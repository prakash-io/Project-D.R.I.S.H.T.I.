// Predictive route hazards (workflow section 5).
//
// Open-Meteo precipitation and the XGBoost hazard model are queried through
// the backend's POST /risk/route, NOT from the handset. That is deliberate,
// and it is a correctness decision rather than a performance one:
//
//   * The model takes eight features. Five of them (elevation, slope, aspect,
//     distance to river, distance to road) come from GeoTIFF terrain sheets
//     and KDTree indices that are hundreds of megabytes and live server-side.
//   * CLAUDE.md decision 2: the training parquet is already RobustScaler
//     output. Re-deriving and re-scaling features on the phone would desync
//     serving from training silently -- the model would keep answering, just
//     wrongly.
//   * CLAUDE.md decision 11: the rainfall window must be located via
//     `hourly.time`, never sliced from index 0, because the Open-Meteo series
//     starts at 00:00 UTC rather than now. That slicing already exists and is
//     tested in the AI service; a second implementation here is a second
//     chance to get it wrong.
//
// What this file owns is the offline half: caching the returned nodes so the
// warnings survive the dark zone that made them matter.
import { Q } from '@nozbe/watermelondb';

/// A forecast older than this is still shown -- a stale flood warning is not
/// worthless -- but it is labelled so the driver knows what they are reading.
export const STALE_AFTER_MS = 3 * 60 * 60 * 1000;   // 3 hours

/// Model class -> the words that go on the map. Short: this is read at speed.
const KIND_LABEL = {
  FLOOD_RISK: 'FLASH FLOOD',
  LANDSLIDE_RISK: 'LANDSLIDE',
  HEAVY_RAIN: 'HEAVY RAIN',
};

/// Above this hourly intensity the node is called heavy rain regardless of the
/// terrain class, because that is what the driver will actually meet.
const HEAVY_RAIN_MMH = 7.5;

export function hazardLabel(kind, intensityMmh) {
  if (Number.isFinite(intensityMmh) && intensityMmh >= HEAVY_RAIN_MMH
      && kind !== 'LANDSLIDE_RISK') {
    return KIND_LABEL.HEAVY_RAIN;
  }
  return KIND_LABEL[kind] ?? 'HAZARD';
}

/// Stable identity for one node, so a refresh replaces rather than duplicates.
/// Rounded to ~11 m: the model's own inputs do not vary below that, so two
/// samples that close are the same warning.
function nodeKey(lat, lng, kind) {
  return `${lat.toFixed(4)}:${lng.toFixed(4)}:${kind}`;
}

/**
 * Fetch hazards for a route and cache them.
 *
 * Returns the cached set either way. A failed fetch is not an empty map: the
 * previous forecast stays on screen, because "no warnings" and "could not ask"
 * must never look the same to a driver.
 */
export async function refreshRouteHazards(database, { apiUrl, coordinates, sampleKm = 10 }) {
  if (!Array.isArray(coordinates) || coordinates.length < 1) {
    return { hazards: await cachedHazards(database), fetched: false, error: 'no route' };
  }

  let payload;
  try {
    const response = await fetch(`${apiUrl}/risk/route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ coordinates, sample_km: sampleKm }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    payload = await response.json();
  } catch (error) {
    // Dark zone, or the model is down. Keep what we have.
    return { hazards: await cachedHazards(database), fetched: false, error: error.message };
  }

  await cacheHazards(database, payload.hazards ?? []);
  return {
    hazards: await cachedHazards(database),
    fetched: true,
    degraded: payload.degraded ?? null,
    sampled: payload.sampled ?? 0,
  };
}

/**
 * Replace the cached forecast with a freshly returned set.
 *
 * A whole-set replace rather than an upsert: a node that has dropped below the
 * threshold since the last call must DISAPPEAR from the map. Merging would
 * leave a cleared flood warning on screen indefinitely.
 */
export async function cacheHazards(database, hazards) {
  const collection = database.get('hazard_forecasts');
  const existing = await collection.query().fetch();
  const now = Date.now();

  await database.write(async () => {
    await Promise.all(existing.map((row) => row.destroyPermanently()));
    await Promise.all(hazards.map((h) => collection.create((row) => {
      row.nodeKey = nodeKey(h.lat, h.lng, h.kind);
      row.latitude = h.lat;
      row.longitude = h.lng;
      row.kind = h.kind;
      row.probability = h.probability ?? 0;
      row.rainfall24hMm = h.rainfall_24h_mm ?? null;
      row.rainfallIntensityMmh = h.rainfall_intensity_mmh ?? null;
      row.windowStartUtc = h.window_start_utc ?? null;
      row.fetchedAt = now;
    })));
  });
}

/** Everything currently cached, newest first. */
export async function cachedHazards(database) {
  if (!database) return [];
  const rows = await database.get('hazard_forecasts')
    .query(Q.sortBy('fetched_at', Q.desc)).fetch();

  return rows.map((row) => ({
    id: row.id,
    latitude: row.latitude,
    longitude: row.longitude,
    kind: row.kind,
    label: hazardLabel(row.kind, row.rainfallIntensityMmh),
    probability: row.probability,
    rainfall24hMm: row.rainfall24hMm,
    rainfallIntensityMmh: row.rainfallIntensityMmh,
    fetchedAt: row.fetchedAt ? new Date(row.fetchedAt).getTime() : null,
  }));
}

/**
 * GeoJSON for the map layer.
 *
 * `label` is baked into the feature properties rather than computed in the
 * style, because a MapLibre expression cannot express the intensity rule
 * above.
 */
export function toFeatureCollection(hazards) {
  return {
    type: 'FeatureCollection',
    features: (hazards ?? [])
      .filter((h) => Number.isFinite(h.latitude) && Number.isFinite(h.longitude))
      .map((h) => ({
        type: 'Feature',
        id: h.id,
        geometry: { type: 'Point', coordinates: [h.longitude, h.latitude] },
        properties: {
          type: h.label,
          kind: h.kind,
          probability: h.probability ?? 0,
          stale: h.fetchedAt ? (Date.now() - h.fetchedAt) > STALE_AFTER_MS : false,
        },
      })),
  };
}
