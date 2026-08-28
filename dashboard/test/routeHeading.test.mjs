// The heading a truck is drawn with must come from the road (WEB-03).
//
//     node --test dashboard/test/
//
// The 3D model has a nose, so it states a direction whether or not anyone
// chose one. It used to take that direction from the bearing between the last
// two GNSS fixes, which is not the direction of travel -- a 5 m lateral
// error on an 8 m leg is a 30 degree error, and the marker is interpolated so
// the position drawn is rarely the position that bearing was measured from.
//
// These cases are the ones that were wrong on screen, written as arithmetic:
// a truck between vertices, a truck at a bend, a truck standing still, and a
// truck that is not on the route at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RouteTracker } from '../src/lib/routeHeading.js';

/// Guwahati-ish, so the cos(lat) correction is actually exercised. At 26 N a
/// longitude degree is ~0.9 of a latitude degree, and an implementation that
/// ignores that reads a due-east leg as north-east by about 10 degrees.
const LAT = 26.1445;
const LNG = 91.7362;

/// Degrees of latitude per metre.
const DEG = 1 / 111320;

const close = (actual, expected, tolerance, what) => {
  assert.notEqual(actual, null, `${what}: got null`);
  // Compass angles wrap, so 359 and 1 are two degrees apart.
  const delta = Math.abs(((actual - expected + 540) % 360) - 180);
  assert.ok(delta <= tolerance,
    `${what}: ${actual?.toFixed(1)} deg is ${delta.toFixed(1)} from ${expected}`);
};

test('a due-north leg reads 0, not something skewed by longitude scaling', () => {
  const t = new RouteTracker([[LNG, LAT], [LNG, LAT + 1000 * DEG]]);
  close(t.headingAt(LNG, LAT + 500 * DEG), 0, 0.5, 'north');
});

test('a due-east leg reads 90 -- the cos(lat) correction is applied', () => {
  // 1000 m of EASTING at this latitude is more than 1000 m of longitude
  // degrees; if the tracker forgot cos(lat) this segment would read as about
  // 84 degrees rather than 90.
  const east = (1000 * DEG) / Math.cos((LAT * Math.PI) / 180);
  const t = new RouteTracker([[LNG, LAT], [LNG + east, LAT]]);
  close(t.headingAt(LNG + east / 2, LAT), 90, 0.5, 'east');
});

test('the heading follows the road around a bend, not the straight line', () => {
  // North for 1 km, then east for 1 km. A bearing taken between the two ends
  // would read 45; the road reads 0 on the first leg and 90 on the second,
  // which is what a driver actually does.
  const east = (1000 * DEG) / Math.cos((LAT * Math.PI) / 180);
  const t = new RouteTracker([
    [LNG, LAT],
    [LNG, LAT + 1000 * DEG],
    [LNG + east, LAT + 1000 * DEG],
  ]);
  close(t.headingAt(LNG, LAT + 250 * DEG), 0, 0.5, 'before the bend');
  close(t.headingAt(LNG + east * 0.75, LAT + 1000 * DEG), 90, 0.5, 'after the bend');
});

test('a stationary truck keeps the road heading instead of spinning', () => {
  // This is the case the old fix-to-fix bearing could not answer. A parked
  // truck emits 1 Hz packets that differ by centimetres of receiver jitter,
  // whose bearing is uniformly random; the road under it does not move.
  const t = new RouteTracker([[LNG, LAT], [LNG, LAT + 1000 * DEG]]);
  const jitter = [
    t.headingAt(LNG + 0.3 * DEG, LAT + 500 * DEG),
    t.headingAt(LNG - 0.4 * DEG, LAT + 500 * DEG),
    t.headingAt(LNG + 0.1 * DEG, LAT + 500.2 * DEG),
  ];
  for (const h of jitter) close(h, 0, 0.5, 'jittering on the spot');
});

test('a truck far off the route gets null, not a confident wrong answer', () => {
  // Null is the honest answer and the caller falls back to the fix-derived
  // bearing. Returning 0 here would point every off-route vehicle due north.
  const t = new RouteTracker([[LNG, LAT], [LNG, LAT + 1000 * DEG]]);
  assert.equal(t.headingAt(LNG + 5000 * DEG, LAT + 500 * DEG), null);
});

test('an empty or single-point route is not usable', () => {
  assert.equal(new RouteTracker([]).headingAt(LNG, LAT), null);
  assert.equal(new RouteTracker([[LNG, LAT]]).headingAt(LNG, LAT), null);
  assert.equal(new RouteTracker(undefined).headingAt(LNG, LAT), null);
});

test('the cursor advances along the route and still finds the right segment', () => {
  // The windowed search is an optimisation and must not change the answer.
  // A long path walked end to end is where a cursor that drifts ahead of the
  // truck would show up: the local window would miss and, without the
  // full-scan fallback, the heading would freeze on a segment far behind.
  const points = [];
  for (let i = 0; i <= 400; i += 1) points.push([LNG, LAT + i * 20 * DEG]);
  // Then turn hard east for the last stretch.
  const east = (20 * DEG) / Math.cos((LAT * Math.PI) / 180);
  for (let i = 1; i <= 100; i += 1) {
    points.push([LNG + i * east, LAT + 400 * 20 * DEG]);
  }
  const t = new RouteTracker(points);

  for (let i = 0; i < 400; i += 1) {
    close(t.headingAt(LNG, LAT + (i + 0.5) * 20 * DEG), 0, 0.5, `north leg at ${i}`);
  }
  for (let i = 1; i < 100; i += 1) {
    close(t.headingAt(LNG + (i - 0.5) * east, LAT + 400 * 20 * DEG), 90, 0.5,
      `east leg at ${i}`);
  }
});

test('a truck that jumps backwards is re-found by the full-scan fallback', () => {
  // A burst-synced batch can move a marker a long way in one frame. The
  // cursor is then ahead of the truck and the local window cannot see it.
  const points = [];
  for (let i = 0; i <= 400; i += 1) points.push([LNG, LAT + i * 20 * DEG]);
  const t = new RouteTracker(points);
  t.headingAt(LNG, LAT + 390 * 20 * DEG);          // drive to the far end
  close(t.headingAt(LNG, LAT + 5 * 20 * DEG), 0, 0.5, 'after jumping back');
});

test('a reroute swaps the path without stranding the cursor past its end', () => {
  const long = [];
  for (let i = 0; i <= 300; i += 1) long.push([LNG, LAT + i * 20 * DEG]);
  const t = new RouteTracker(long);
  t.headingAt(LNG, LAT + 280 * 20 * DEG);
  assert.ok(t.cursor > 250, 'cursor should have advanced along the long path');

  // The detour is a short path running due east. A cursor left at 280 would
  // address a segment that no longer exists.
  const east = (100 * DEG) / Math.cos((LAT * Math.PI) / 180);
  t.setCoordinates([[LNG, LAT], [LNG + east, LAT]]);
  close(t.headingAt(LNG + east / 2, LAT), 90, 0.5, 'on the new path');
});

test('duplicate consecutive vertices do not divide by zero', () => {
  // A simplified geometry can carry them even though the route stitcher tries
  // to avoid it; a zero-length segment must not produce NaN.
  const t = new RouteTracker([
    [LNG, LAT], [LNG, LAT], [LNG, LAT + 1000 * DEG],
  ]);
  close(t.headingAt(LNG, LAT + 500 * DEG), 0, 0.5, 'past the duplicate');
});
