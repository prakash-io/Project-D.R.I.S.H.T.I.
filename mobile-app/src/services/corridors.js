// Demonstration corridors, fetched from the backend (migration 009).
//
// Every corridor here was planned by pgr_astar over the real road graph --
// 486,784 edges out of road_network.parquet -- so the line the driver sees is
// the road, not a straight hop between two pins. Guwahati to Shillong is 62 km
// as the crow flies and 95 km by road; drawing the former would misrepresent
// both the distance and the terrain the whole platform is about.
import RNFS from 'react-native-fs';

/**
 * Abort a fetch after `ms`.
 *
 * NOT the AbortSignal.timeout static. It exists in every browser and in Node,
 * so it reads as safe, but React Native ships its own AbortController
 * polyfill and does NOT implement that static -- so the call throws
 * "undefined is not a function" from inside the try, and every caller here
 * catches that as a NETWORK failure and answers from cache. On a clean
 * install the cache is empty, so the corridor list came back [] and the
 * simulated drive silently fell through to real GNSS. Found on the handset,
 * not by the parse check: nothing off-device runs this code path.
 */
function abortAfter(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  // Callers must clear this. A resolved fetch that leaves the timer pending
  // holds a callback for the rest of the timeout and then aborts nothing.
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

// Cached to the document directory rather than AsyncStorage: RNFS is already
// a dependency (it extracts the edge assets), and adding a native module for
// two small JSON blobs would mean another autolink to keep working.
const CACHE_DIR = `${RNFS.DocumentDirectoryPath}/corridors`;
const LIST_CACHE = `${CACHE_DIR}/index.json`;

async function writeCache(path, value) {
  try {
    await RNFS.mkdir(CACHE_DIR);
    await RNFS.writeFile(path, JSON.stringify(value), 'utf8');
  } catch (error) {
    // A failed cache write must never fail the fetch that succeeded.
    console.warn('[corridors] cache write failed:', error.message);
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
 * List the corridors. Metadata only -- ~3 KB rather than ~1 MB.
 *
 * Cached, because the corridor picker is the first thing the HAZARD/MAP tabs
 * need and a truck that starts its shift already in a dark zone still has to
 * be able to open it.
 */
export async function listCorridors(apiUrl, { timeoutMs = 15000 } = {}) {
  try {
    const t = abortAfter(timeoutMs);
    let response;
    try {
      response = await fetch(`${apiUrl}/routes/corridors`, { signal: t.signal });
    } finally { t.done(); }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { corridors } = await response.json();
    await writeCache(LIST_CACHE, corridors);
    return corridors;
  } catch (error) {
    console.warn('[corridors] list failed, falling back to cache:', error.message);
    return (await readCache(LIST_CACHE)) ?? [];
  }
}

/**
 * One corridor WITH full geometry.
 *
 * Full, never simplified: this feeds the simulated drive, which walks the
 * polyline vertex by vertex. A 25 m simplification is invisible when drawn but
 * would make the truck cut corners across the inside of every hairpin, which
 * on the Shillong climb means driving through the hillside.
 */
export async function getCorridor(apiUrl, id, { timeoutMs = 30000 } = {}) {
  const key = `${CACHE_DIR}/${id}.json`;
  try {
    const t = abortAfter(timeoutMs);
    let response;
    try {
      response = await fetch(`${apiUrl}/routes/corridors/${id}`, { signal: t.signal });
    } finally { t.done(); }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { corridor } = await response.json();
    await writeCache(key, corridor);
    return corridor;
  } catch (error) {
    console.warn(`[corridors] ${id} failed, falling back to cache:`, error.message);
    const cached = await readCache(key);
    if (!cached) throw error;
    return cached;
  }
}

/**
 * Ensure the truck has an ACTIVE trip on this corridor.
 *
 * Not optional, and the reason is a trap that has already cost a debugging
 * session: the backend's recordTelemetry joins through `trip` to attribute a
 * fix, and when the truck has no active trip that SELECT returns zero rows
 * and the insert is skipped WITHOUT raising. Telemetry then streams from the
 * handset, is accepted over the socket, and is silently dropped server-side --
 * which reads on the dashboard as a truck that never moved.
 */
export async function ensureTrip(apiUrl, truckId, corridor, { timeoutMs = 60000 } = {}) {
  const t = abortAfter(timeoutMs);
  let response;
  try {
    response = await fetch(`${apiUrl}/trips`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        truck_id: truckId,
        from: { lat: corridor.origin_lat, lng: corridor.origin_lng },
        to: { lat: corridor.destination_lat, lng: corridor.destination_lng },
      }),
      signal: t.signal,
    });
  } finally { t.done(); }
  if (!response.ok) throw new Error(`trip create failed: HTTP ${response.status}`);
  return response.json();
}
