// Which way a truck is pointing, taken from the road rather than from the fix.
//
// The 3D model has a nose, so it states a direction whether or not anyone
// chose one. The heading it was given came from the bearing between the last
// two GNSS fixes, and on a real feed that is not the direction of travel:
//
//   * A 1 Hz fix carries several metres of receiver noise. At 30 km/h a truck
//     moves 8 m between packets, so a 5 m lateral error is a 30 degree
//     bearing error -- the model twitches across the road while the vehicle
//     drives straight.
//   * The marker is INTERPOLATED between fixes (see useTelemetry), so on
//     every frame but the last the position is behind the leg the bearing was
//     computed from.
//   * A stopped truck emits fixes that differ by centimetres of jitter, whose
//     bearing is uniformly random. The old code held the previous heading to
//     hide this, which is the right patch for the wrong quantity.
//
// The road does not have any of those problems. A truck on a planned route is
// on that route -- that is what map-matching on the handset guarantees -- so
// the direction it faces is the direction the route runs where it is
// standing. This projects the position onto the route and returns the bearing
// of the segment it landed on.
//
// Falls back to the fix-to-fix bearing (`fallbackDeg`), because a truck with
// no active trip has no route to take a heading from and pointing every
// unrouted vehicle due north would be its own lie.

/// Metres per degree of latitude. Constant to within 0.6% over the ellipsoid,
/// which is far inside what a heading needs.
const M_PER_DEG = 111320;

/**
 * One truck's position along one route.
 *
 * Stateful on purpose. A truck moves monotonically along its path, so the
 * segment it is on this frame is at or just after the one it was on last
 * frame, and the search can start there instead of at the origin. That turns
 * a 4,400-segment scan per truck per animation frame into a ~64-segment one,
 * which is the difference between a smooth console and a hot laptop.
 */
export class RouteTracker {
  /**
   * @param {Array<[number, number]>} coordinates [lng, lat], origin first.
   */
  constructor(coordinates) {
    this.coordinates = Array.isArray(coordinates) ? coordinates : [];
    this.cursor = 0;
  }

  /// True when there is at least one segment to take a bearing from.
  get usable() {
    return this.coordinates.length >= 2;
  }

  /**
   * Replace the path, keeping the cursor only if it still addresses a segment.
   *
   * Called on a reroute. Resetting the cursor unconditionally would be safe
   * but would make every rerouted truck scan its whole new path on the next
   * frame; keeping a cursor that now points past the end would be worse.
   */
  setCoordinates(coordinates) {
    this.coordinates = Array.isArray(coordinates) ? coordinates : [];
    if (this.cursor > this.coordinates.length - 2) this.cursor = 0;
  }

  /**
   * Compass bearing of the route where this position sits, or null.
   *
   * Null -- rather than 0 -- when there is no usable route or the position is
   * nowhere near it. 0 is due north, which is a claim; null lets the caller
   * fall back to something it can actually support.
   *
   * @param {number} lng
   * @param {number} lat
   * @param {number} maxOffRouteM How far off the line the truck may be before
   *   the route stops being evidence of where it is pointing. 250 m is well
   *   past the simplification tolerance and the width of any carriageway, and
   *   comfortably short of the next road over.
   */
  headingAt(lng, lat, maxOffRouteM = 250) {
    if (!this.usable) return null;

    const cosLat = Math.cos((lat * Math.PI) / 180);
    const segments = this.coordinates.length - 1;

    // A window ahead of the cursor and a little behind it. Behind matters:
    // the interpolation is a lag, so a marker can sit fractionally back from
    // where the last fix put it, and a forward-only window would drag the
    // cursor past the truck and never recover.
    let best = this.#search(
      lng, lat, cosLat,
      Math.max(0, this.cursor - 8),
      Math.min(segments, this.cursor + 64),
    );

    // The local window missed -- a burst-synced jump, a fresh route, or a
    // truck that has genuinely moved a long way since the last frame. Pay for
    // the full scan once and the cursor is right again for every frame after.
    if (best.distanceSq > (maxOffRouteM / M_PER_DEG) ** 2) {
      best = this.#search(lng, lat, cosLat, 0, segments);
    }

    if (best.index < 0) return null;
    if (best.distanceSq > (maxOffRouteM / M_PER_DEG) ** 2) return null;

    this.cursor = best.index;

    const [aLng, aLat] = this.coordinates[best.index];
    const [bLng, bLat] = this.coordinates[best.index + 1];
    return bearing(aLng, aLat, bLng, bLat, cosLat);
  }

  /// Nearest segment in [from, to), by squared distance in degree-space.
  #search(lng, lat, cosLat, from, to) {
    let index = -1;
    let distanceSq = Infinity;
    for (let i = from; i < to; i += 1) {
      const d = segmentDistanceSq(
        lng, lat, cosLat,
        this.coordinates[i], this.coordinates[i + 1],
      );
      if (d < distanceSq) { distanceSq = d; index = i; }
    }
    return { index, distanceSq };
  }
}

/**
 * Squared distance from a point to a segment, with longitude scaled to match.
 *
 * Squared, and never square-rooted in the loop: this runs a few thousand
 * times per animation frame and the comparison is monotonic in the square.
 *
 * The cos(lat) factor is not optional. Longitude degrees are ~0.9 as long as
 * latitude degrees at 26 N, so an unscaled comparison biases every match
 * east-west and picks the wrong segment wherever a route doubles back --
 * which on the Shillong climb is most of it.
 */
function segmentDistanceSq(lng, lat, cosLat, a, b) {
  const ax = (a[0] - lng) * cosLat;
  const ay = a[1] - lat;
  const bx = (b[0] - lng) * cosLat;
  const by = b[1] - lat;

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  // A zero-length segment: two identical consecutive vertices, which the
  // route stitcher tries to avoid but a simplified geometry can still carry.
  if (lenSq === 0) return ax * ax + ay * ay;

  // Projection parameter, clamped to the segment so the nearest point on an
  // infinite line does not get reported as a point on a finite road.
  let t = -(ax * dx + ay * dy) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;

  const px = ax + t * dx;
  const py = ay + t * dy;
  return px * px + py * py;
}

/// Degrees clockwise from north, which is what a compass heading is and what
/// the ScenegraphLayer's yaw expects.
function bearing(aLng, aLat, bLng, bLat, cosLat) {
  const x = (bLng - aLng) * cosLat;
  const y = bLat - aLat;
  if (x === 0 && y === 0) return null;
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}
