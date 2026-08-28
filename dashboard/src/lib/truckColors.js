// One colour per truck, and ONE function that decides it.
//
// The whole value of this file is that the deck.gl layers, the 2D fallback
// dot, the fleet legend, the truck selector, the fleet table and the deep-dive
// header all call the same function. A legend that assigned its own colours
// would disagree with the map the first time the fleet changed, and a
// dispatcher reading a swatch against a vehicle is exactly who that misleads.
//
// ------------------------------------------------------------ the hue space
//
// Two bands are refused, because this console has already spent them:
//
//   345-20°   aviation hazard red. #F85149 is the risk corridor, the alert
//             text and the incident border. A truck in that band reads as a
//             hazard at a glance, which is the one misreading that costs
//             something.
//    95-125°  terminal green. tokens.css spends it on exactly one element --
//             the telemetry link indicator -- and says so.
//
// That leaves 295 usable degrees.
//
// Saturation and lightness are FIXED rather than varied. On the #0A0A0A
// substrate a hue at 72%/62% clears 4.5:1 at every angle, so identity is
// carried by hue alone and every truck is equally legible. Varying lightness
// to squeeze in more values would make some trucks dimmer than others, which
// reads as a state -- faded, stale, unselected -- that does not exist.
//
// ------------------------------------------------------------- the assignment
//
// Hues are spread EVENLY over the fleet rather than hashed into a table, and
// that is a correction made against measurement, not a preference. Hashing
// nine truck ids into a 24-hue table produced seven distinct colours -- two
// exact collisions. Resolving the collisions by probing fixed that but left
// the closest pair 7° apart (#e4d258 against #e3e458), which is distinct in
// the data and identical to the eye, so it failed the actual requirement
// while passing the literal one. Even spacing over N trucks gives 295/N
// degrees of separation: about 33° for the nine-truck demonstration fleet.
//
// The cost is that the assignment depends on the SIZE of the fleet, so adding
// a vehicle re-spaces the others. That is affordable here specifically because
// the assignment runs over the ROSTER (GET /trucks, fetched once) and not over
// the live subset -- so it changes when someone registers a vehicle, which is
// an administrative event, and never when a truck starts or stops emitting,
// which is a telemetry event that happens constantly. Colouring by the live
// subset would have made the whole map recolour every time a truck came online.
//
// WHICH truck lands in which band is decided by the hash of its id, not by
// its position in the list, so it is a property of the vehicle rather than of
// alphabetical accident.
//
// ---------------------------------------------------------------- the source
//
// Identity in the FILL does not displace the GNSS/dead-reckoning distinction,
// which MapView is right to call the whole product. That distinction moves to
// two channels it already had:
//
//   * the stroke around the 2D marker -- dead-reckoning amber, otherwise the
//     substrate colour it always was
//   * the uncertainty halo, which only a dead-reckoned truck has at all
//
// So the fill answers "which truck" and the outline answers "how do we know
// where it is". Both were previously fighting for the fill, which is why the
// fleet was two colours no matter how many vehicles were on it.

/// [start, end) hue bands this console has already committed. See the header.
const RESERVED = [[345, 360], [0, 20], [95, 125]];

const SATURATION = 0.72;
const LIGHTNESS = 0.62;

function isReserved(hue) {
  return RESERVED.some(([lo, hi]) => hue >= lo && hue < hi);
}

/// Every whole degree this console is free to spend, in order. 295 of them.
const ALLOWED = (() => {
  const out = [];
  for (let hue = 0; hue < 360; hue += 1) if (!isReserved(hue)) out.push(hue);
  return out;
})();

/// Golden angle, used only by the unassigned fallback below.
const GOLDEN_ANGLE = 137.508;

/**
 * FNV-1a over the id.
 *
 * Used to decide which truck takes which band, and as the fallback hue before
 * a roster exists. Keyed on the id rather than on a list position so a truck's
 * band does not move because an unrelated vehicle sorted differently.
 */
function hash(id) {
  let h = 0x811c9dc5;
  const text = String(id ?? '');
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    // >>> 0 after every step: JS bitwise ops produce a SIGNED 32-bit int, and
    // without this the multiply overflows negative and the modulo that
    // consumes it returns a negative index.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/// The resolved assignment, or an empty map before any roster is known.
///
/// Module-level rather than a React context on purpose: the deck.gl colour
/// accessors are plain functions called per truck per frame from outside the
/// component tree, and threading a context into them would mean rebuilding the
/// layers whenever it changed. Everything that reads this re-renders on the
/// same state change that writes it.
let assignment = new Map();

/**
 * Spread the fleet evenly over the usable hue space.
 *
 * Called in exactly one place -- App.jsx, over the whole roster -- so every
 * surface in the console shares one answer. Deterministic for a given SET of
 * ids: sorting before hashing means the result does not depend on the order
 * telemetry happened to arrive in.
 *
 * @param ids  every registered truck id, live or not
 * @returns    Map(id -> hue degrees), also stored for truckHue()
 */
export function assignFleetColors(ids) {
  const unique = [...new Set((ids ?? []).filter(Boolean))].sort();
  const next = new Map();

  // Ordered by hash: this is what decides which truck gets which band. Ties
  // fall back to the id so the sort is total and therefore stable.
  const ordered = unique.sort((a, b) => (hash(a) - hash(b)) || (a < b ? -1 : 1));

  ordered.forEach((id, i) => {
    next.set(id, ALLOWED[Math.floor((i * ALLOWED.length) / ordered.length)]);
  });

  assignment = next;
  return next;
}

/**
 * The hue this truck owns, in degrees.
 *
 * Falls back to a golden-angle walk when the roster has not loaded -- a
 * deep-dive URL opened directly paints before GET /trucks answers, and a truck
 * with no colour at all would be worse than one whose colour settles a moment
 * later. The fallback can collide; the assignment cannot, and the assignment
 * is what is on screen a few hundred milliseconds later.
 */
export function truckHue(truckId) {
  const assigned = assignment.get(truckId);
  if (assigned !== undefined) return assigned;
  const walk = Math.floor((hash(truckId) % 997) * GOLDEN_ANGLE) % ALLOWED.length;
  return ALLOWED[walk];
}

/**
 * [r, g, b], 0-255 — what the deck.gl accessors want.
 *
 * ScenegraphLayer's getColor is a MULTIPLY over the model's own material, not
 * a replacement, which is why scripts/gen_truck_gltf.mjs ships the mesh
 * near-white: a mid-grey base would darken every one of these toward each
 * other and undo the separation this file exists to create.
 */
export function truckRgb(truckId) {
  return hslToRgb(truckHue(truckId), SATURATION, LIGHTNESS);
}

/// '#rrggbb' — what a DOM swatch, a border or an SVG fill wants. Derived from
/// truckRgb rather than computed separately, so the two cannot drift.
export function truckHex(truckId) {
  const [r, g, b] = truckRgb(truckId);
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/// `rgb(r g b / a)` for a tint behind text, where a flat hex would be opaque
/// enough to fight the readout in front of it.
export function truckRgba(truckId, alpha) {
  const [r, g, b] = truckRgb(truckId);
  return `rgb(${r} ${g} ${b} / ${alpha})`;
}

/**
 * A short, stable label for a truck.
 *
 * The plate when there is one, because that is what a dispatcher says out
 * loud on a radio. The first id segment otherwise -- never a bare index,
 * which would renumber for the same reason the colour must not.
 */
export function truckLabel(truck) {
  return truck?.plate ?? String(truck?.truck_id ?? truck?.id ?? '').slice(0, 8);
}

function hslToRgb(hDeg, s, l) {
  const h = ((((hDeg % 360) + 360) % 360)) / 360;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hueToChannel(p, q, h + 1 / 3) * 255),
    Math.round(hueToChannel(p, q, h) * 255),
    Math.round(hueToChannel(p, q, h - 1 / 3) * 255),
  ];
}

function hueToChannel(p, q, tRaw) {
  let t = tRaw;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}
