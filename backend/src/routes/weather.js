// Meteorological metrics along a route, for the analytics deep-dive.
//
// Proxied through Node rather than called from the browser, for the same three
// reasons dashboard/src/lib/api.js already gives for routing /risk/route this
// way -- and one more that is specific to weather:
//
//   The window rule (CLAUDE.md decision 11) has to live in exactly one place.
//   Open-Meteo's series starts at 00:00 UTC, not at the current hour, so any
//   caller that slices from index 0 shows a dispatcher weather that is up to
//   23 hours stale and completely plausible. There is now one implementation
//   of "find the current hour" on the server; a second one in the browser
//   would be a second place for that to be got wrong, silently.
//
// It also means one shared TTL cache instead of one per open tab, and the
// upstream URL stays in the backend's configuration rather than being baked
// into a bundle.
import { Router } from 'express';
import {
  fetchRouteWeather, summariseRoute, dailyTotals, sampleAlong, WeatherUnavailable,
} from '../services/openMeteo.js';

export const weatherRouter = Router();

/// Three points -- origin, midpoint, destination. Enough to show that weather
/// varies ALONG a corridor, which is the fact a single reading hides, without
/// turning one page load into a dozen upstream locations.
const DEFAULT_POINTS = 3;
const MAX_POINTS = 8;
/// Two days. The bar chart needs whole days and the hourly table is read by
/// scrolling; past 48 h an hourly precipitation forecast is not worth the
/// pixels it costs.
const DEFAULT_HOURS = 48;
const MAX_HOURS = 96;

/// What each sampled point is called on the page. Beyond three, the middle
/// ones are numbered -- a made-up place name would be worse than an index.
function labelFor(index, count) {
  if (index === 0) return 'Origin';
  if (index === count - 1) return 'Destination';
  if (count === 3) return 'Midpoint';
  return `Waypoint ${index}`;
}

/**
 * POST /weather/route   { coordinates: [[lng,lat],...], points?, hours? }
 *
 * Returns per-point series, a route-level worst-case series, and per-day
 * totals. The worst case is what the headline figures are drawn from: a
 * corridor is only as passable as its worst point, and averaging a downpour at
 * one end against clear sky at the other produces a number describing neither.
 */
weatherRouter.post('/route', async (req, res, next) => {
  try {
    const coordinates = req.body?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length === 0) {
      return res.status(400).json({
        error: 'coordinates must be a non-empty [[lng, lat], ...]',
      });
    }

    const count = clamp(Number(req.body?.points ?? DEFAULT_POINTS), 1, MAX_POINTS);
    const hours = clamp(Number(req.body?.hours ?? DEFAULT_HOURS), 1, MAX_HOURS);

    const sampled = sampleAlong(coordinates, count);
    if (sampled.length === 0) {
      return res.status(400).json({ error: 'coordinates carry no finite [lng, lat] pair' });
    }

    const weather = await fetchRouteWeather(sampled, { hours });
    const route = summariseRoute(weather.points);

    res.json({
      points: weather.points.map((point, i) => ({
        label: labelFor(i, weather.points.length),
        ...point,
      })),
      // The series every headline tile and the area chart read.
      route,
      daily: dailyTotals(route),
      units: weather.units,
      // Stated so the page can show WHICH hour it is calling "now". A forecast
      // with no stated window is unfalsifiable.
      window_start_utc: weather.window_start_utc,
      hours: weather.hours,
      sampled: sampled.length,
      source: weather.source,
      generated_at: weather.generated_at,
    });
  } catch (error) {
    // Upstream being unreachable is not a fault in this service, and a 500
    // would put it in the same bucket as a bug here. 503 with the reason lets
    // the page say "the forecast is unavailable" rather than "something broke".
    if (error instanceof WeatherUnavailable) {
      return res.status(503).json({ error: error.message, source: 'open-meteo' });
    }
    return next(error);
  }
});

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}
