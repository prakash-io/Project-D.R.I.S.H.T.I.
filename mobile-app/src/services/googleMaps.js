// Google Maps HTTP fallbacks (online only).
//
// Strictly a supplement to the offline stack, never a dependency of it. The
// map itself is MapLibre over Bhuvan raster tiles with an offline pack; these
// endpoints are plain HTTPS calls that are simply unavailable in a dark zone,
// so every one of them fails soft and the caller carries on.
//
// `region=IN` is pinned on every request. Without it Google biases results to
// the caller's locale, which for NER place names and disputed boundaries
// returns the wrong answer.
const BASE = 'https://maps.googleapis.com/maps/api';
const REGION = 'IN';

/// Same substitution caveat as the rest of the app: process.env is not
/// inlined by RN's Babel preset, so this is null unless a build injects it.
const API_KEY = process.env.GOOGLE_MAPS_API_KEY ?? null;

export function isConfigured() {
  return typeof API_KEY === 'string' && API_KEY.length > 0;
}

/**
 * A static map image URL, used as a last-resort backdrop if MapLibre itself
 * cannot initialise. Returns null when unconfigured so callers render their
 * own ground instead of a broken image.
 */
export function staticMapUrl({ lat = 22.5937, lng = 78.9629, zoom = 4, size = '800x800' } = {}) {
  if (!isConfigured()) return null;
  return `${BASE}/staticmap?center=${lat},${lng}&zoom=${zoom}&size=${size}` +
    `&region=${REGION}&key=${API_KEY}`;
}

/** Place name -> coordinates. Null on any failure, including no network. */
export async function geocode(address) {
  if (!isConfigured() || !address) return null;
  try {
    const url = `${BASE}/geocode/json?address=${encodeURIComponent(address)}` +
      `&region=${REGION}&key=${API_KEY}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const body = await response.json();
    const location = body?.results?.[0]?.geometry?.location;
    return location ? { latitude: location.lat, longitude: location.lng } : null;
  } catch (error) {
    console.warn('[gmaps] geocode unavailable:', error.message);
    return null;
  }
}

/**
 * Directions as a [lng, lat][] ready for MapLibre.
 *
 * Advisory only. Authoritative rerouting is pgRouting server-side, which is
 * the only thing that knows which edges an incident has blocked -- Google has
 * no idea a landslide closed a road twenty minutes ago.
 */
export async function directions(origin, destination) {
  if (!isConfigured() || !origin || !destination) return null;
  try {
    const url = `${BASE}/directions/json?origin=${encodeURIComponent(origin)}` +
      `&destination=${encodeURIComponent(destination)}&region=${REGION}&key=${API_KEY}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const body = await response.json();
    const encoded = body?.routes?.[0]?.overview_polyline?.points;
    return encoded ? decodePolyline(encoded) : null;
  } catch (error) {
    console.warn('[gmaps] directions unavailable:', error.message);
    return null;
  }
}

/// Google's encoded polyline algorithm, to [lng, lat] pairs (GeoJSON order).
function decodePolyline(encoded) {
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    points.push([lng / 1e5, lat / 1e5]);
  }

  return points;
}
