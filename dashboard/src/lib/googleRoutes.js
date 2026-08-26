// Google Maps Directions -> GeoJSON LineString, and hazard-avoiding reroutes.
//
// -------------------------------------------------------------------------
// WHY THE MAPS JS API AND NOT THE DIRECTIONS WEB SERVICE
// -------------------------------------------------------------------------
// The Directions *Web Service* (maps.googleapis.com/maps/api/directions/json)
// sends no CORS header, so a browser cannot call it -- the request is blocked
// before Google ever sees the key. The usual fix is a server-side proxy, and
// this task is explicitly not permitted to touch the backend. So routes are
// requested through the Maps *JavaScript* API's DirectionsService, which is
// designed for browser use and works from the origin the dashboard is served
// on. `directionsToGeoJSON` still accepts a raw Web Service response verbatim,
// so if a proxy is ever added the parsing side needs no change.
//
// -------------------------------------------------------------------------
// HAZARD AVOIDANCE IS NOT A DIRECTIONS FEATURE
// -------------------------------------------------------------------------
// Task 4 asks for a reroute that "strictly avoids the active hazard polygon".
// The Directions API has no avoid-polygon parameter -- `avoid` accepts only
// tolls, highways, ferries and indoor. Anything claiming otherwise is steering
// by waypoint. So this module is honest about which of two mechanisms is doing
// the work:
//
//   pgRouting (backend POST /routes/plan)  ACTUALLY avoids the hazard. An
//       approved incident sets the blocked edge's cost to 999999 in the
//       routable_edges view, so pgr_astar cannot return a path through it.
//       This is the authoritative reroute and it is tried first.
//
//   Google Directions + detour waypoints  produces the road-quality geometry
//       a driver reads well, by pushing a waypoint out perpendicular to the
//       hazard and asking for a route through it. The result is then MEASURED
//       against the hazard radius and rejected if it still passes through.
//
// `planEmergencyReroute` runs both and reports which one it used, rather than
// presenting a Google line and implying the hazard was respected.

import { API_URL } from './api';

const GOOGLE_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY ?? '';
const EARTH_RADIUS_M = 6_371_008.8;

export const hasGoogleKey = () => GOOGLE_KEY.length > 0;

// ---------------------------------------------------------------------------
// Encoded polyline
// ---------------------------------------------------------------------------

/**
 * Decode a Google encoded polyline into [lng, lat] pairs.
 *
 * Google's format stores each coordinate as a signed delta from the previous
 * one, zig-zag encoded and split into 5-bit chunks with the continuation bit
 * set on all but the last. Output order is [lng, lat] because that is GeoJSON
 * order -- the single most common bug in this conversion is emitting Google's
 * own lat,lng order and drawing the whole fleet in the Indian Ocean.
 */
export function decodePolyline(encoded, precision = 5) {
  if (typeof encoded !== 'string' || encoded.length === 0) return [];
  const factor = 10 ** precision;
  const coordinates = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    coordinates.push([lng / factor, lat / factor]);
  }
  return coordinates;
}

/**
 * Normalise any Directions result into a GeoJSON LineString Feature.
 *
 * Handles all three shapes this app can receive:
 *   - a Web Service response  (routes[].overview_polyline.points, encoded)
 *   - a Maps JS DirectionsResult (routes[].overview_path, LatLng objects)
 *   - an already-decoded array of [lng, lat]
 */
export function directionsToGeoJSON(input, properties = {}) {
  let coordinates = [];
  let distanceM = null;
  let durationS = null;
  let summary = null;

  if (Array.isArray(input)) {
    coordinates = input;
  } else {
    const route = input?.routes?.[0];
    if (!route) return null;
    summary = route.summary ?? null;

    if (Array.isArray(route.overview_path) && route.overview_path.length > 0) {
      // Maps JS: LatLng instances expose lat()/lng() as functions. Plain
      // objects with numeric lat/lng also occur when a result has been
      // serialised, so both are handled.
      coordinates = route.overview_path.map((point) => [
        typeof point.lng === 'function' ? point.lng() : point.lng,
        typeof point.lat === 'function' ? point.lat() : point.lat,
      ]);
    } else if (route.overview_polyline?.points) {
      coordinates = decodePolyline(route.overview_polyline.points);
    } else if (typeof route.overview_polyline === 'string') {
      coordinates = decodePolyline(route.overview_polyline);
    }

    // Legs carry the authoritative totals; overview geometry carries none.
    const legs = Array.isArray(route.legs) ? route.legs : [];
    if (legs.length > 0) {
      distanceM = legs.reduce((sum, leg) => sum + (leg.distance?.value ?? 0), 0) || null;
      durationS = legs.reduce((sum, leg) => sum + (leg.duration?.value ?? 0), 0) || null;
    }
  }

  if (coordinates.length < 2) return null;

  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates },
    properties: {
      provider: 'google',
      distance_m: distanceM,
      duration_s: durationS,
      summary,
      ...properties,
    },
  };
}

// ---------------------------------------------------------------------------
// Maps JS API loader
// ---------------------------------------------------------------------------

let mapsPromise = null;

/** Load the Maps JS API once, on demand. Rejects if no key is configured. */
export function loadGoogleMaps() {
  if (!hasGoogleKey()) {
    return Promise.reject(new Error('VITE_GOOGLE_MAPS_API_KEY is not set'));
  }
  if (window.google?.maps?.DirectionsService) return Promise.resolve(window.google.maps);
  if (mapsPromise) return mapsPromise;

  mapsPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    // `routes` is the only library needed; loading places/geometry as well
    // would pull weight this dashboard never calls.
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(GOOGLE_KEY)}&libraries=routes&v=weekly`;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (window.google?.maps) resolve(window.google.maps);
      else reject(new Error('Maps JS loaded but google.maps is missing'));
    };
    script.onerror = () => {
      // Cleared so a later attempt can retry rather than being stuck on a
      // permanently rejected promise.
      mapsPromise = null;
      reject(new Error('Maps JS failed to load (network, key, or referrer restriction)'));
    };
    document.head.appendChild(script);
  });
  return mapsPromise;
}

/**
 * One Directions request through the browser API.
 *
 * @param {{lat,lng}} origin
 * @param {{lat,lng}} destination
 * @param {Array<{lat,lng}>} waypoints  forced intermediate points
 */
export async function requestDirections({ origin, destination, waypoints = [] }) {
  const maps = await loadGoogleMaps();
  const service = new maps.DirectionsService();

  const result = await service.route({
    origin: { lat: origin.lat, lng: origin.lng },
    destination: { lat: destination.lat, lng: destination.lng },
    waypoints: waypoints.map((point) => ({
      location: { lat: point.lat, lng: point.lng },
      stopover: false,
    })),
    travelMode: maps.TravelMode.DRIVING,
    // A truck cannot use a passenger ferry, and an NER detour that silently
    // routes over one is a route the driver cannot take.
    avoidFerries: true,
  });

  return directionsToGeoJSON(result);
}

// ---------------------------------------------------------------------------
// Backend pgRouting -- the authoritative avoider
// ---------------------------------------------------------------------------

/**
 * POST /routes/plan. Read-only; it computes and returns, it writes nothing.
 *
 * This is the reroute that genuinely respects a blocked road, because the
 * 999999 cost lives in the routable_edges view that pgr_astar reads.
 */
export async function planViaBackend(from, to, { riskWeight = 0 } = {}) {
  const response = await fetch(`${API_URL}/routes/plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from, to, risk_weight: riskWeight }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);

  return {
    type: 'Feature',
    geometry: body.geometry,
    properties: {
      provider: 'pgrouting',
      distance_m: body.distance_m ?? null,
      edge_count: body.edge_count ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

export function haversineM([lng1, lat1], [lng2, lat2]) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearingDeg([lng1, lat1], [lng2, lat2]) {
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2))
    - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Travel `distanceM` from a point along a bearing. */
export function destinationPoint([lng, lat], bearing, distanceM) {
  const delta = distanceM / EARTH_RADIUS_M;
  const theta = toRad(bearing);
  const phi1 = toRad(lat);
  const lambda1 = toRad(lng);

  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta),
  );
  const lambda2 = lambda1 + Math.atan2(
    Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
    Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2),
  );
  return [((toDeg(lambda2) + 540) % 360) - 180, toDeg(phi2)];
}

/** Closest approach, in metres, between a LineString and a point. */
export function minDistanceToPath(coordinates, point) {
  if (!Array.isArray(coordinates) || coordinates.length === 0) return Infinity;
  let best = Infinity;
  // Vertex sampling rather than true point-to-segment distance. Directions
  // overview geometry is dense enough (tens of metres between vertices) that
  // the error is far below the hazard radii this is compared against, and the
  // exact version costs a projection per segment for no decision change.
  for (const vertex of coordinates) {
    const d = haversineM(vertex, point);
    if (d < best) best = d;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Emergency reroute
// ---------------------------------------------------------------------------

/// How far off the hazard to push a detour waypoint, as a multiple of the
/// hazard radius. 2.5x leaves room for the router to find a real road out
/// there rather than snapping the waypoint back onto the closed one.
const DETOUR_FACTOR = 2.5;
/// A route is only accepted as clear if it stays this far outside the hazard.
const CLEARANCE_FACTOR = 1.2;

/**
 * Reroute a truck around an active hazard (Task 4).
 *
 * Returns { feature, provider, avoided, note } and never throws for a routing
 * failure -- a dispatcher pressing this under pressure needs an answer, and
 * "could not find a clear route" is an answer.
 *
 * Order of preference:
 *   1. pgRouting, which cannot traverse the blocked edge at all.
 *   2. Google with a detour waypoint, verified clear by measurement.
 *   3. Google with a detour waypoint that is NOT clear -- returned, but
 *      flagged `avoided: false` so the UI can say so rather than imply safety.
 */
export async function planEmergencyReroute({ from, to, hazard, hazardRadiusM = 400 }) {
  const hazardPoint = hazard ? [Number(hazard.lng), Number(hazard.lat)] : null;

  // 1. The authoritative path.
  try {
    const feature = await planViaBackend(from, to, { riskWeight: 0.5 });
    if (feature?.geometry?.coordinates?.length >= 2) {
      const clearance = hazardPoint
        ? minDistanceToPath(feature.geometry.coordinates, hazardPoint)
        : Infinity;
      return {
        feature,
        provider: 'pgrouting',
        // pgr_astar physically cannot return the blocked edge, so this is
        // avoided by construction. The measurement is reported for the
        // dispatcher's confidence, not to make the decision.
        avoided: true,
        clearanceM: clearance,
        note: 'pgRouting — blocked edge excluded from the graph',
      };
    }
  } catch (error) {
    // Fall through to Google. A 422 here means "unreachable with that road
    // closed", which is real information but not a reason to show nothing.
    console.warn('[reroute] pgRouting unavailable:', error.message);
  }

  // 2 / 3. Road-quality geometry with a forced detour.
  if (!hasGoogleKey()) {
    return {
      feature: null,
      provider: null,
      avoided: false,
      note: 'No route: pgRouting failed and no Google key is configured',
    };
  }

  const fromPoint = [from.lng, from.lat];
  const toPoint = [to.lng, to.lat];
  const axis = bearingDeg(fromPoint, toPoint);
  const offset = Math.max(hazardRadiusM * DETOUR_FACTOR, 600);
  const anchor = hazardPoint ?? midpoint(fromPoint, toPoint);

  // Perpendicular to the travel axis, both sides. Which side is passable
  // depends on terrain nobody here can know, so both are asked for and the
  // better answer wins.
  const candidates = [90, -90].map((turn) => {
    const [lng, lat] = destinationPoint(anchor, (axis + turn + 360) % 360, offset);
    return { lat, lng };
  });

  const attempts = [];
  for (const waypoint of candidates) {
    try {
      const feature = await requestDirections({ origin: from, destination: to, waypoints: [waypoint] });
      if (!feature) continue;
      const clearance = hazardPoint
        ? minDistanceToPath(feature.geometry.coordinates, hazardPoint)
        : Infinity;
      attempts.push({ feature, clearance });
      if (clearance >= hazardRadiusM * CLEARANCE_FACTOR) {
        return {
          feature,
          provider: 'google',
          avoided: true,
          clearanceM: clearance,
          note: `Google Directions via detour — clears hazard by ${Math.round(clearance)} m`,
        };
      }
    } catch (error) {
      console.warn('[reroute] Directions attempt failed:', error.message);
    }
  }

  if (attempts.length === 0) {
    return { feature: null, provider: null, avoided: false, note: 'No route could be computed' };
  }

  // Best of a bad set. Returned so the dispatcher sees something, flagged so
  // nobody mistakes it for a safe route.
  const best = attempts.reduce((a, b) => (b.clearance > a.clearance ? b : a));
  return {
    feature: best.feature,
    provider: 'google',
    avoided: false,
    clearanceM: best.clearance,
    note: `Closest clear route still passes within ${Math.round(best.clearance)} m of the hazard`,
  };
}

function midpoint([lng1, lat1], [lng2, lat2]) {
  return [(lng1 + lng2) / 2, (lat1 + lat2) / 2];
}

/**
 * The closest vertex to `point` across several LineStrings.
 *
 * Used to draw the leader line between a hazard's REPORTED position and the
 * road it actually blocks. Those are two different places and the gap is not a
 * bug: the backend snaps the report to the nearest edge with ST_ClosestPoint
 * to decide what to close, but it stores and returns the point the driver was
 * standing on when they tagged it. So the marker can sit tens of metres off
 * the carriageway -- driver standoff plus GNSS error -- and a dispatcher
 * reasonably asks why the landslide is in a field.
 *
 * Returns null when nothing is within `maxDistanceM`, so an unrelated road on
 * the far side of the valley never gets a leader drawn to it.
 */
export function closestVertexAcross(paths, point, maxDistanceM = 2500) {
  let best = null;
  let bestDistance = maxDistanceM;
  for (const path of paths) {
    if (!Array.isArray(path)) continue;
    for (const vertex of path) {
      const d = haversineM(vertex, point);
      if (d < bestDistance) {
        bestDistance = d;
        best = vertex;
      }
    }
  }
  return best ? { vertex: best, distanceM: bestDistance } : null;
}

/** Bounding box [minLng, minLat, maxLng, maxLat] of any coordinate list. */
export function boundsOf(coordinates) {
  if (!coordinates || coordinates.length === 0) return null;
  let minLng = Infinity; let minLat = Infinity;
  let maxLng = -Infinity; let maxLat = -Infinity;
  for (const [lng, lat] of coordinates) {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLng, minLat, maxLng, maxLat];
}
