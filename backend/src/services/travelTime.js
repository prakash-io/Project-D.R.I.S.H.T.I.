// Travel-time estimation for a planned route (workflow section 4).
//
// THIS IS A PLANNING ESTIMATE, NOT A MEASURED MODEL. There is no historical
// trip corpus for these corridors, so the speeds below are engineering
// assumptions about loaded trucks on NER roads, not observations. They are
// stated as one table in one place precisely so that nobody mistakes them for
// something the platform learned, and so a real fleet log can replace them
// wholesale later.
//
// No `motorway` entry: the extract contains none, which is correct -- NER has
// no motorway-class road. `trunk` is the National Highway tier here.
//
// Speeds are deliberately below plains figures. NH6/NH37 through the hills
// average far under their design speed for a loaded truck, and an ETA that
// reads optimistic is worse than one that reads slow: a driver who is told
// 4 h and arrives in 5 stops trusting the number.
export const CLASS_SPEED_KMH = {
  trunk: 45,          trunk_link: 35,
  primary: 40,        primary_link: 30,
  secondary: 35,      secondary_link: 28,
  tertiary: 30,       tertiary_link: 25,
  unclassified: 25,
  residential: 20,
  living_street: 10,
  service: 15,
  road: 25,           // OSM's explicit "class unknown"
};

/// Applied to any surface OSM does not call paved. 10,202 edges in the
/// extract carry one of these values; a gravel hill road is not driven at its
/// class speed.
export const UNPAVED_SURFACES = new Set([
  'unpaved', 'gravel', 'dirt', 'ground', 'earth', 'sand', 'mud',
  'compacted', 'fine_gravel', 'grass', 'pebblestone',
]);
export const UNPAVED_FACTOR = 0.6;

/// Fallback for a class not in the table. Matches `unclassified`, which is the
/// single largest tier by length in this extract (33.8%), so an unknown class
/// is treated as the most common road rather than as a highway.
export const DEFAULT_SPEED_KMH = 25;

/**
 * Curvature penalty, from the edge's own geometry.
 *
 * Road class alone cannot tell a hill highway from a plains highway, and in
 * NER that is the single biggest term in a truck's speed. Sinuosity -- path
 * length over the straight line between the edge's endpoints -- separates
 * them using data already in the routing query. Measured on two real routes,
 * trunk edges only:
 *
 *     Guwahati -> Shillong  (NH6, hill)    sinuosity 1.114
 *     Guwahati -> Tezpur    (NH15, plains) sinuosity 1.004
 *
 * The excess over 1 differs by a factor of ~28 between them, so this is a
 * strong discriminator rather than noise. k = 4 puts the hill trunk at ~0.69
 * of its class speed and leaves the plains trunk essentially untouched
 * (~0.98). The floor stops a hairpin switchback edge producing an absurd
 * crawl.
 */
export const SINUOSITY_K = 4;
export const SINUOSITY_FLOOR = 0.55;

export function sinuosityFactor(lengthM, straightM) {
  if (!Number.isFinite(lengthM) || !Number.isFinite(straightM) || straightM <= 5) return 1;
  const sinuosity = lengthM / straightM;
  if (!(sinuosity > 1)) return 1;
  return Math.max(SINUOSITY_FLOOR, 1 / (1 + SINUOSITY_K * (sinuosity - 1)));
}

export function edgeSpeedKmh(highway, surface, lengthM, straightM) {
  const base = CLASS_SPEED_KMH[highway] ?? DEFAULT_SPEED_KMH;
  const paved = UNPAVED_SURFACES.has(surface) ? base * UNPAVED_FACTOR : base;
  return paved * sinuosityFactor(lengthM, straightM);
}

/**
 * Seconds to drive a sequence of routed edges.
 *
 * Each edge is timed at its own class speed rather than the route being
 * divided by one average: a reroute that swaps 5 km of national highway for
 * 5 km of residential lane is the same distance and not the same journey,
 * and telling the driver otherwise defeats the point of sending an ETA.
 *
 * Edges with no usable length contribute nothing rather than NaN -- a single
 * bad row must not turn the whole ETA into "—".
 */
export function estimateDurationSec(edges) {
  let seconds = 0;
  for (const edge of edges) {
    const metres = Number(edge.lengthM);
    if (!Number.isFinite(metres) || metres <= 0) continue;
    const kmh = edgeSpeedKmh(edge.highway, edge.surface, metres, edge.straightM);
    seconds += metres / (kmh / 3.6);
  }
  return seconds;
}
