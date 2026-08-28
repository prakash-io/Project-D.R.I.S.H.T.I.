// Backend client. One place that knows the base URL.
export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

async function json(path, options) {
  const response = await fetch(`${API_URL}${path}`, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!response.ok) {
    throw new Error(body.error ?? body.detail ?? `HTTP ${response.status}`);
  }
  return body;
}

export const getHealth = () => json('/health');
export const getTrucks = () => json('/trucks');

export const getIncidents = (status) =>
  json(`/incidents${status ? `?status=${encodeURIComponent(status)}` : ''}`);

export const approveIncident = (id, approvedBy = 'dispatcher') =>
  json(`/incidents/${id}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approved_by: approvedBy }),
  });

export const rejectIncident = (id, approvedBy = 'dispatcher') =>
  json(`/incidents/${id}/reject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approved_by: approvedBy }),
  });

export const getRiskSegments = (min = 0.85, limit = 2000) =>
  json(`/risk/segments?min=${min}&limit=${limit}`);

export const incidentPhotoUrl = (id) => `${API_URL}/incidents/${id}/photo`;

// The demonstration corridors, planned by pgr_astar over `routable_edges`.
//
// Geometry is opt-in on the API because the raw paths are 1k-9k points each
// and the picker only needs the endpoints. The dispatcher view does want the
// lines, so it asks for them -- simplified, since 40 m of Douglas-Peucker
// tolerance is well under a line width at the zooms this overlay is read at
// and cuts the payload by roughly an order of magnitude (4411 -> 309 points
// on Guwahati-Shillong).
export const getCorridors = () =>
  json('/routes/corridors?geometry=1&simplify_m=40');

/**
 * The route every truck in the fleet is currently driving.
 *
 * The console had no way to ask this and it showed: the map drew ten static
 * corridors and a set of moving vehicles, with nothing joining a truck to the
 * road it was on. Two trucks on screen and no line under either of them was
 * the reported bug, and it was not a rendering fault -- the data was never
 * fetched, because there was no endpoint to fetch it from.
 *
 * Simplified server-side at 40 m, the same tolerance the corridor overlay
 * uses. Eleven raw 4,400-point paths is several megabytes per page load.
 */
export const getActiveTrips = () => json('/trips/active?simplify_m=40');

/// Every distinct road one trip could have taken, ranked, with the one being
/// driven flagged and the ones a hazard has closed marked blocked.
export const getTripAlternatives = (tripId) =>
  json(`/trips/${encodeURIComponent(tripId)}/alternatives`);

/**
 * Plan one route live through pgr_astar (API-04).
 *
 * The corridors table already holds a planned geometry for each demo route,
 * and replaying that would paint faster. This posts instead, because the
 * point of the demo sidebar is to show the routing engine working -- a
 * stored polyline proves only that someone ran the planner once. Measured
 * end to end against the seeded corridors: 224 ms for Guwahati-Shillong
 * (287 edges), 810 ms for Guwahati-Dibrugarh (1449 edges), which is inside
 * the budget for a click to feel like it did something.
 */
export const planRoute = (from, to, riskWeight = 0) =>
  json('/routes/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from, to, risk_weight: riskWeight }),
  });

/**
 * Hazard forecast along one corridor — the Alerts page's data source.
 *
 * This is the XGBoost model behind `/predict-hazard`, reached through the
 * Node backend rather than called at the FastAPI service directly. Three
 * reasons, and none of them is squeamishness about an extra origin:
 *
 *   1. FastAPI is not CORS-open to the browser, and it should not be — it
 *      holds the GeoTIFF handles and the KDTree pickles and has no auth of
 *      its own. `backend/src/routes/risk.js` is the boundary.
 *   2. The rainfall window has to be located via `hourly.time`, never sliced
 *      from index 0 (CLAUDE.md decision 11). That lives in one place server
 *      side; a second caller re-deriving it is a second place to get it
 *      wrong, silently, in a way that shifts every forecast by hours.
 *   3. `/risk/route` samples the polyline before it scores, so a 4,411-point
 *      corridor costs ~12 model calls rather than 4,411.
 *
 * Returns `{ hazards, sampled, threshold, degraded, generated_at }`. Note
 * `degraded`: the backend returns whatever it scored before an AI-service
 * failure rather than erroring, because a partial forecast is still a
 * warning while an empty one reads as "nothing ahead".
 */
export const forecastRoute = (coordinates, sampleKm = 25, maxPoints = 12) =>
  json('/risk/route', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      coordinates,
      sample_km: sampleKm,
      max_points: maxPoints,
    }),
  });

/**
 * One truck, its driver and its active trip — the analytics deep-dive.
 *
 * Separate from getTrucks() rather than an expansion of it: the list is what
 * every console polls for its first paint, while this joins two more tables
 * and runs a linear-referencing call to measure how far along the route the
 * truck actually is. Cheap for one truck, wasteful across a fleet.
 */
export const getTruckDetail = (truckId) =>
  json(`/trucks/${encodeURIComponent(truckId)}`);

/**
 * Full meteorological metrics along a route (ML-03).
 *
 * Open-Meteo is public and CORS-open, so the browser COULD call it directly.
 * It does not, for the same reason forecastRoute goes through the backend
 * plus one that is specific to weather: Open-Meteo's hourly series starts at
 * 00:00 UTC, not at the current hour, so the window has to be located by
 * searching `hourly.time` (CLAUDE.md decision 11). That rule now lives in
 * backend/src/services/openMeteo.js and nowhere else. A second implementation
 * here would be a second place to get it wrong -- silently, and in a way that
 * shows a dispatcher weather up to 23 hours stale while looking entirely
 * plausible.
 *
 * Returns `{ points, route, daily, units, window_start_utc, hours, sampled }`.
 * `route` is the per-hour WORST CASE across the sampled points, not a mean:
 * a corridor is only as passable as its worst point.
 */
export const getRouteWeather = (coordinates, points = 3, hours = 48) =>
  json('/weather/route', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ coordinates, points, hours }),
  });
