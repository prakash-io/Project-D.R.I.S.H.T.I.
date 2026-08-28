// Full meteorological metrics from Open-Meteo, for the dispatcher's route
// deep-dive (ML-03, consumed by the analytics page).
//
// This is NOT a second copy of ai-services/drishti_ai/weather.py, and the
// split is deliberate. That module feeds the XGBoost hazard model: it pulls
// precipitation alone, aggregates it into the three rainfall FEATURES the
// model was trained on, and its output is scored, never shown. This one pulls
// the whole observable set -- temperature, humidity, wind, visibility,
// precipitation -- and its output is read by a human and never scored. Merging
// them would put a display concern inside the feature pipeline, and the
// feature pipeline is the one place in this system where an extra column
// silently desynchronises training from serving.
//
// What IS shared, and must stay shared, is the window discipline:
//
//   1. THE SERIES DOES NOT START "NOW". With timezone=UTC, Open-Meteo returns
//      whole days -- the first sample is 00:00 UTC today. Probed from this
//      repo at 2026-08-28, forecast_days=2 returned 48 hours beginning
//      2026-08-28T00:00, so `hourly.temperature_2m[0]` is last midnight, not
//      the current conditions. Slicing from index 0 puts a dispatcher's
//      "current temperature" up to 23 hours in the past, and it looks
//      completely plausible while doing it. The current hour is LOCATED by
//      searching hourly.time. This is CLAUDE.md decision 11.
//
//   2. NULLS ARE NOT COMPACTED. Open-Meteo emits null for hours it has no
//      value for. Dropping them shifts every later hour leftwards, which is
//      how a cloudburst outside the window gets reported as being inside it.
//      Nulls are skipped in place and the hours that actually carried a value
//      are counted alongside every aggregate.
//
// Multiple coordinates go in ONE request. Open-Meteo accepts comma-separated
// latitude/longitude and answers with a JSON ARRAY, one entry per location,
// in the order asked -- verified against the live API. Three points along a
// 95 km corridor therefore cost one round trip rather than three.

const OPEN_METEO_URL = process.env.OPEN_METEO_URL
  ?? 'https://api.open-meteo.com/v1/forecast';
const TIMEOUT_MS = Number(process.env.OPEN_METEO_TIMEOUT_MS ?? 12000);

/// The hourly variables the analytics page reads. Order is not significant to
/// the API but is kept stable so a cached payload is comparable across runs.
const HOURLY_VARS = [
  'temperature_2m',
  'relative_humidity_2m',
  'precipitation',
  'precipitation_probability',
  'wind_speed_10m',
  'wind_gusts_10m',
  'visibility',
  'weather_code',
];

/// Our field names, mapped from Open-Meteo's. Renamed at the boundary so the
/// unit is in the name -- `wind_speed_kmh` cannot be misread as m/s the way a
/// bare `wind_speed_10m` can, and this API has burned that exact assumption
/// before (it answers km/h by default, not m/s).
const FIELDS = {
  temperature_2m: 'temperature_c',
  relative_humidity_2m: 'humidity_pct',
  precipitation: 'precipitation_mm',
  precipitation_probability: 'precipitation_probability_pct',
  wind_speed_10m: 'wind_speed_kmh',
  wind_gusts_10m: 'wind_gust_kmh',
  visibility: 'visibility_m',
  weather_code: 'weather_code',
};

/// 4 days, not 2. The series starts at 00:00 UTC, so up to 23 hours of the
/// first day are already spent before the current hour is even reached; 4
/// guarantees a full 48-hour forward window exists whatever the time of day.
const FORECAST_DAYS = 4;

/// Cache TTL. Open-Meteo's own model updates hourly, so anything shorter
/// spends requests to receive the same numbers.
const CACHE_TTL_MS = Number(process.env.WEATHER_CACHE_TTL_MS ?? 10 * 60 * 1000);
/// ~11 km at this latitude, which is Open-Meteo's own grid spacing: two
/// queries that collide here would have received the same upstream answer.
const CACHE_PRECISION = 1;
const MAX_CACHE_ENTRIES = 256;

const cache = new Map();

export class WeatherUnavailable extends Error {}

/**
 * Sample a polyline down to exactly `count` points, evenly spaced by DISTANCE.
 *
 * By distance and not by vertex index, because the road graph's vertex density
 * is a property of how the road was digitised, not of how long it is: a
 * hairpin section of NH-6 carries vertices every few metres while a straight
 * run carries one every few hundred. Indexing evenly would put every sample in
 * the mountains and none on the plain.
 *
 * The first and last vertex are always included, so `count: 3` is exactly
 * origin / midpoint / destination -- which is what the analytics page labels
 * them.
 */
export function sampleAlong(coordinates, count) {
  const clean = coordinates.filter(
    (c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]));
  if (clean.length === 0) return [];
  if (clean.length === 1 || count <= 1) return [clean[0]];
  if (count >= clean.length) return clean;

  // Cumulative distance along the line, so a target distance can be resolved
  // to a vertex without walking from the start each time.
  const cumulative = [0];
  for (let i = 1; i < clean.length; i += 1) {
    cumulative.push(cumulative[i - 1] + haversineKm(clean[i - 1], clean[i]));
  }
  const total = cumulative[cumulative.length - 1];
  if (total === 0) return [clean[0], clean[clean.length - 1]].slice(0, count);

  const out = [];
  for (let i = 0; i < count; i += 1) {
    const target = (total * i) / (count - 1);
    // First vertex at or past the target. The last sample resolves to the
    // final vertex exactly, because target === total there.
    let index = cumulative.findIndex((d) => d >= target);
    if (index < 0) index = clean.length - 1;
    out.push(clean[index]);
  }
  return out;
}

export function haversineKm([lng1, lat1], [lng2, lat2]) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180)
      * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Hourly metrics for every point, from the current hour forward.
 *
 * @param points  [[lng, lat], ...] -- one Open-Meteo request covers all of them
 * @param hours   forward hours to return per point
 * @returns { points: [{ lat, lng, elevation_m, current, hourly }], units,
 *            window_start_utc, hours }
 */
export async function fetchRouteWeather(points, { hours = 48, useCache = true } = {}) {
  if (!Array.isArray(points) || points.length === 0) {
    throw new WeatherUnavailable('no points to query');
  }

  const key = cacheKey(points, hours);
  if (useCache) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      // Refresh LRU position so a corridor a dispatcher keeps open stays warm.
      cache.delete(key);
      cache.set(key, hit);
      return hit.value;
    }
  }

  const params = new URLSearchParams({
    latitude: points.map(([, lat]) => lat.toFixed(4)).join(','),
    longitude: points.map(([lng]) => lng.toFixed(4)).join(','),
    hourly: HOURLY_VARS.join(','),
    forecast_days: String(FORECAST_DAYS),
    // UTC throughout. `timezone=auto` re-bases the series on the location's
    // local midnight, which moves the window without saying so -- and with
    // several points on one request there would be no single series origin
    // for the dashboard to align them on.
    timezone: 'UTC',
    windspeed_unit: 'kmh',
    precipitation_unit: 'mm',
  });

  let payload;
  try {
    const response = await fetch(`${OPEN_METEO_URL}?${params}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new WeatherUnavailable(
        `Open-Meteo returned HTTP ${response.status}`);
    }
    payload = await response.json();
  } catch (error) {
    if (error instanceof WeatherUnavailable) throw error;
    throw new WeatherUnavailable(`Open-Meteo request failed: ${error.message}`);
  }

  // One location comes back as an object, several as an array. Normalised so
  // a single-point route is not a separate code path.
  const entries = Array.isArray(payload) ? payload : [payload];
  if (entries.length !== points.length) {
    throw new WeatherUnavailable(
      `asked Open-Meteo for ${points.length} locations, got ${entries.length}`);
  }

  const nowHour = new Date();
  nowHour.setUTCMinutes(0, 0, 0);

  let units = null;
  let windowStart = null;

  const result = entries.map((entry, i) => {
    const hourly = entry?.hourly ?? {};
    const stamps = hourly.time;
    if (!Array.isArray(stamps) || stamps.length === 0) {
      throw new WeatherUnavailable('Open-Meteo response carries no hourly.time');
    }
    for (const key_ of HOURLY_VARS) {
      const series = hourly[key_];
      // A length mismatch would silently pair a value with the wrong hour,
      // which is the failure mode that is impossible to spot on a chart.
      if (Array.isArray(series) && series.length !== stamps.length) {
        throw new WeatherUnavailable(
          `Open-Meteo ${key_} has ${series.length} values for ${stamps.length} hours`);
      }
    }

    // THE WINDOW. Located by searching hourly.time for the first stamp at or
    // after the current hour -- never index 0. See the header.
    const start = stamps.findIndex((s) => parseHour(s) >= nowHour);
    if (start < 0) {
      throw new WeatherUnavailable(
        `Open-Meteo series ends at ${stamps[stamps.length - 1]}, before the `
        + `current hour ${nowHour.toISOString()} — cannot locate the window`);
    }
    if (windowStart === null) windowStart = stamps[start];
    if (units === null) units = entry.hourly_units ?? null;

    const end = Math.min(start + hours, stamps.length);
    const rows = [];
    for (let h = start; h < end; h += 1) {
      const row = { time: `${stamps[h]}Z` };
      for (const [source, name] of Object.entries(FIELDS)) {
        const series = hourly[source];
        // null stays null. It is skipped where an aggregate is taken, and it
        // renders as a gap rather than as a zero -- "no reading" and "no rain"
        // are different facts and a chart must not merge them.
        const value = Array.isArray(series) ? series[h] : null;
        row[name] = value === undefined ? null : value;
      }
      rows.push(row);
    }
    if (rows.length === 0) {
      throw new WeatherUnavailable(
        `Open-Meteo returned no forward hours from ${stamps[start]}`);
    }

    return {
      lat: entry.latitude ?? points[i][1],
      lng: entry.longitude ?? points[i][0],
      elevation_m: entry.elevation ?? null,
      // The current hour is simply the first row of the located window, which
      // is the whole reason the window is located rather than assumed.
      current: rows[0],
      hourly: rows,
    };
  });

  const value = {
    points: result,
    units: units ?? {},
    window_start_utc: windowStart ? `${windowStart}Z` : null,
    hours: result[0].hourly.length,
    source: 'open-meteo',
    generated_at: new Date().toISOString(),
  };

  cache.set(key, { at: Date.now(), value });
  while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  return value;
}

/**
 * Collapse the per-point series into one route-level series.
 *
 * WORST CASE per hour, not an average, and that is the whole point of the
 * function. A route is passable or it is not, and it is not passable at its
 * worst point: a corridor with 40 mm/h falling on the Shillong end and none at
 * Guwahati averages to a comfortable 20 and reads as a wet afternoon. The
 * dispatcher needs the 40.
 *
 * Which direction is "worst" differs per metric -- most precipitation, least
 * visibility, strongest wind -- so each is reduced with its own comparator.
 * Temperature has no worst direction and is averaged, since it is context
 * rather than a hazard.
 */
export function summariseRoute(points) {
  const first = points[0]?.hourly ?? [];
  return first.map((row, i) => {
    const across = points.map((p) => p.hourly[i]).filter(Boolean);
    return {
      time: row.time,
      temperature_c: mean(across.map((r) => r.temperature_c)),
      humidity_pct: worst(across.map((r) => r.humidity_pct), Math.max),
      precipitation_mm: worst(across.map((r) => r.precipitation_mm), Math.max),
      precipitation_probability_pct:
        worst(across.map((r) => r.precipitation_probability_pct), Math.max),
      wind_speed_kmh: worst(across.map((r) => r.wind_speed_kmh), Math.max),
      wind_gust_kmh: worst(across.map((r) => r.wind_gust_kmh), Math.max),
      // The one metric where lower is worse.
      visibility_m: worst(across.map((r) => r.visibility_m), Math.min),
    };
  });
}

/**
 * Per-day totals for the bar chart.
 *
 * Precipitation is SUMMED over each day and temperature is carried as a
 * min/max pair, because those are the two shapes a day of weather actually
 * has. Days are UTC, matching the series they are cut from -- a local-midnight
 * boundary here would not line up with any timestamp on the page.
 */
export function dailyTotals(series) {
  const byDay = new Map();
  for (const row of series) {
    const day = row.time.slice(0, 10);
    if (!byDay.has(day)) {
      byDay.set(day, { date: day, precipitation_mm: 0, hours: 0,
        temp_min_c: null, temp_max_c: null });
    }
    const bucket = byDay.get(day);
    if (Number.isFinite(row.precipitation_mm)) {
      bucket.precipitation_mm += row.precipitation_mm;
      // Counted so a partial first day is never mistaken for a dry one: today
      // starts at the current hour, so it carries fewer than 24.
      bucket.hours += 1;
    }
    if (Number.isFinite(row.temperature_c)) {
      bucket.temp_min_c = bucket.temp_min_c === null
        ? row.temperature_c : Math.min(bucket.temp_min_c, row.temperature_c);
      bucket.temp_max_c = bucket.temp_max_c === null
        ? row.temperature_c : Math.max(bucket.temp_max_c, row.temperature_c);
    }
  }
  return [...byDay.values()].map((d) => ({
    ...d,
    precipitation_mm: Number(d.precipitation_mm.toFixed(2)),
  }));
}

function mean(values) {
  const known = values.filter(Number.isFinite);
  if (known.length === 0) return null;
  return Number((known.reduce((a, b) => a + b, 0) / known.length).toFixed(2));
}

function worst(values, pick) {
  const known = values.filter(Number.isFinite);
  return known.length === 0 ? null : pick(...known);
}

/// Open-Meteo emits naive stamps that are UTC because we asked for timezone=UTC.
/// Parsed explicitly rather than handed to `new Date(s)`, which treats a naive
/// stamp as LOCAL time -- an hour-shifting bug that only shows up off UTC.
function parseHour(stamp) {
  return new Date(`${stamp}Z`);
}

function cacheKey(points, hours) {
  const rounded = points
    .map(([lng, lat]) => `${lat.toFixed(CACHE_PRECISION)},${lng.toFixed(CACHE_PRECISION)}`)
    .join('|');
  return `${rounded}@${hours}`;
}
