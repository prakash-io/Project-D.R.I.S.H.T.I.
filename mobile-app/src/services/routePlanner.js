// Driver-entered routing: origin, destination, and the answer to a detour.
//
// This is the half of navigation the client never had. Until now the route on
// the driver's map came from one of two places -- a demonstration corridor
// picked from a list, or a reroute the backend imposed -- and neither is a
// driver saying where they are going. A navigator that cannot be told a
// destination is a tracker.
//
// Everything routable lives on the server: the 486,784-edge graph, pgr_astar,
// and the per-edge ETA model. The handset's job is to name two ends and draw
// what comes back. It deliberately does NOT estimate its own distance or ETA
// -- see the note in RouteSummary about why an on-device guess would be worse
// than no number at all.
import RNFS from 'react-native-fs';

/**
 * Abort a fetch after `ms`.
 *
 * NOT AbortSignal.timeout. React Native's AbortController polyfill does not
 * implement that static, so the call throws from inside the try and every
 * caller reads it as a network failure. That exact bug silently disabled the
 * corridor fetches once already; verify_runtime.mjs now fails the build on it.
 */
function abortAfter(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

const CACHE_DIR = `${RNFS.DocumentDirectoryPath}/routing`;
const PLACES_CACHE = `${CACHE_DIR}/places.json`;

/// A* over half a million edges is not instant, and a long NER route is the
/// slow case: Shillong to Dibrugarh crosses 1,049 edges and takes tens of
/// seconds. A 30 s timeout would abort exactly the journeys this platform
/// exists for, and the driver would read "no route" for a road that is there.
const PLAN_TIMEOUT_MS = 180_000;

async function writeCache(path, value) {
  try {
    await RNFS.mkdir(CACHE_DIR);
    await RNFS.writeFile(path, JSON.stringify(value), 'utf8');
  } catch (error) {
    // A failed cache write must never fail the fetch that succeeded.
    console.warn('[routing] cache write failed:', error.message);
  }
}

async function readCache(path) {
  try {
    if (!(await RNFS.exists(path))) return null;
    return JSON.parse(await RNFS.readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The places a driver may type into the destination field.
 *
 * Every one is an end of a seeded corridor, which is the property that
 * matters: it has already been proven reachable in this extract. A free-text
 * geocoder would accept a village the graph does not cover and hand the driver
 * a 422 they cannot tell from a server fault.
 *
 * Cached, because the destination field is the first thing the driver touches
 * and a truck can start its shift already out of signal.
 */
export async function listPlaces(apiUrl, { timeoutMs = 15000 } = {}) {
  try {
    const t = abortAfter(timeoutMs);
    let response;
    try {
      response = await fetch(`${apiUrl}/routes/places`, { signal: t.signal });
    } finally { t.done(); }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { places } = await response.json();
    await writeCache(PLACES_CACHE, places);
    return places;
  } catch (error) {
    console.warn('[routing] places failed, falling back to cache:', error.message);
    return (await readCache(PLACES_CACHE)) ?? [];
  }
}

/**
 * Plan the driver's route AND open the trip on it, in one call.
 *
 * Deliberately one call and not two. POST /routes/plan followed by POST /trips
 * reads better but runs A* twice over the same pair, which on a 415 km route
 * is tens of seconds of the driver watching a spinner for a path the server
 * already had.
 *
 * The trip is not bookkeeping. recordTelemetry attributes each fix through the
 * truck's ACTIVE trip, and when there is none it drops the fix without
 * raising -- telemetry streams, is accepted, and vanishes, which reads on the
 * dashboard as a truck that never moved. Planning a route and opening a trip
 * are the same act here for that reason.
 *
 * Throws on failure rather than returning null: "could not plan" and "there is
 * no road" are different answers and the UI says different things about them.
 */
export async function planTrip(apiUrl, truckId, from, to, { timeoutMs = PLAN_TIMEOUT_MS } = {}) {
  const t = abortAfter(timeoutMs);
  let response;
  try {
    response = await fetch(`${apiUrl}/trips`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        truck_id: truckId,
        from: { lat: from.lat, lng: from.lng },
        to: { lat: to.lat, lng: to.lng },
      }),
      signal: t.signal,
    });
  } catch (error) {
    // An aborted fetch surfaces as AbortError, which says nothing useful to a
    // driver. Name the actual condition.
    throw new Error(error.name === 'AbortError'
      ? 'the route took too long to plan' : error.message);
  } finally { t.done(); }

  const body = await response.json().catch(() => ({}));
  if (response.status === 422 || body.reachable === false) {
    throw new Error('no road connects those two places in this map');
  }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);

  const coordinates = body.geometry?.coordinates ?? [];
  if (coordinates.length < 2) throw new Error('the planned route came back empty');

  return {
    tripId: body.trip?.id ?? null,
    coordinates,
    distanceM: body.distance_m,
    durationSec: body.estimated_time_sec,
    edgeCount: body.edge_count,
  };
}

/**
 * Tell the server what the driver did with a reroute offer.
 *
 * Best-effort by design, and the reason is the whole point of the app: the
 * driver is on a mountain road with a landslide ahead and has just tapped
 * ACCEPT. The map must switch to the new path on that tap, not after a round
 * trip over a link that may not exist. So the caller updates the UI first and
 * calls this after; a rejected promise is logged, never surfaced as a failure
 * to reroute, because the reroute did happen on the device.
 *
 * Answering twice is safe -- the endpoint is idempotent for a repeat of the
 * same answer, and a 409 for a changed one.
 */
export async function ackReroute(apiUrl, rerouteId, accepted, { timeoutMs = 15000 } = {}) {
  if (!rerouteId) return { ok: false, error: 'no reroute id' };
  try {
    const t = abortAfter(timeoutMs);
    let response;
    try {
      response = await fetch(`${apiUrl}/reroutes/${rerouteId}/ack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accepted, responded_by: 'driver' }),
        signal: t.signal,
      });
    } finally { t.done(); }
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    return { ok: true, ...(await response.json().catch(() => ({}))) };
  } catch (error) {
    console.warn('[routing] reroute ack failed:', error.message);
    return { ok: false, error: error.message };
  }
}

/**
 * Normalise whatever the backend sent into [[lng, lat], ...], or null.
 *
 * Both shapes are real: /trips and /routes/plan return a GeoJSON LineString
 * object, while a cached corridor is already a bare coordinate array. An
 * Array.isArray guard that accepted only the second silently rejected every
 * reroute once, so the route was never drawn and nothing logged.
 */
export function routeCoordinates(geometry) {
  if (Array.isArray(geometry) && geometry.length >= 2) return geometry;
  const coords = geometry?.coordinates;
  if (Array.isArray(coords) && coords.length >= 2) return coords;
  return null;
}
