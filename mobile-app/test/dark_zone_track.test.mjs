// End-to-end: does a demonstrated dark zone actually track the corridor?
//
//     make -C native/test sim_drive_track
//     node test/dark_zone_track.test.mjs
//
// Needs the backend on :4000 (for the corridor geometry) and the shipped
// road_graph.sqlite. Skips with a clear message rather than failing if either
// is missing, because a machine without the 104 MB extract cannot answer this
// question either way.
//
// Why this test exists
// --------------------
// Three things are already proven separately. test_dead_reckoning covers the
// EKF and the map matcher against the real graph. test/simulated_imu.test.mjs
// covers the synthetic IMU's rate, sign, magnitude and noise. Neither covers
// the JOIN, and the join is what the driver sees.
//
// A sign error in the yaw rate is the case that motivates it: it produces a
// smooth, confident, entirely wrong track, mirrored at every bend, and every
// unit test on both sides still passes. Only driving the real filter with the
// real stream along a real North East corridor can catch that.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SimulatedImu, seededRandom } from '../src/services/simulatedImu.js';
import { haversine, bearing } from '../src/services/simulatedDrive.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const GRAPH = path.join(ROOT, 'data/artifacts/edge/road_graph.sqlite');
const HARNESS = path.join(here, '..', 'native', 'test', 'sim_drive_track');
const API = process.env.API_URL ?? 'http://localhost:4000';

const SPEED_KMH = 50;
const SECONDS = 120;

let checks = 0;
const ok = (label, extra = '') => {
  checks += 1;
  console.log(`  ok   ${label}${extra ? `  ${extra}` : ''}`);
};
const skip = (why) => {
  console.log(`  SKIP dark-zone track  ${why}`);
  process.exit(0);
};

if (!existsSync(GRAPH)) skip(`no road graph at ${GRAPH}`);
if (!existsSync(HARNESS)) skip('run `make -C native/test sim_drive_track` first');

// ------------------------------------------------------------- corridor
let corridor;
try {
  const response = await fetch(`${API}/routes/corridors?geometry=1`);
  const body = await response.json();
  corridor = (body.corridors ?? []).find(
    (c) => (c.geometry?.coordinates?.length ?? 0) > 100,
  );
} catch {
  skip(`backend not reachable at ${API}`);
}
if (!corridor) skip('no corridor with geometry returned');

const route = corridor.geometry.coordinates;
console.log(`  corridor: ${corridor.name}, ${route.length} vertices`);

// -------------------------------------------------------- generate stream
// The same class the app runs. Timers are not started; tick() is driven
// directly so the stream is deterministic and the run does not take
// SECONDS of wall clock.
// Seeded. The speed measurement carries sigma 5.259 m/s against 13.9 m/s of
// signal, so an unseeded run of this exact configuration produced 43 m of
// worst-case deviation on one attempt and 399 m on the next -- a number that
// swings by an order of magnitude cannot decide whether anything is working.
const imu = new SimulatedImu({
  coordinates: route,
  speedKmh: SPEED_KMH,
  loop: false,
  random: seededRandom(20260828),
});

// Both callbacks write into ONE ordered stream, so the harness replays the
// speed measurements interleaved with the IMU samples exactly as the engine
// receives them on a handset. Collecting them separately and concatenating
// would deliver every speed at the end, after all the prediction had already
// happened.
const lines = [];
imu.onSample = (ax, ay, az, gy, gp, gr, t) => {
  lines.push(`I,${ax.toFixed(6)},${ay.toFixed(6)},${az.toFixed(6)},`
    + `${gy.toFixed(6)},${gp.toFixed(6)},${gr.toFixed(6)},${t.toFixed(4)}`);
};
// Emitted by the simulator itself at the model's 10 Hz, not scheduled here.
imu.onSpeed = (speedMps) => lines.push(`S,${speedMps.toFixed(4)}`);
imu.clockS = 0;
imu.lastHeading = null;

// 20 ticks per second (TICK_MS = 50).
for (let tick = 0; tick < SECONDS * 20; tick += 1) imu.tick();

const speedRecords = lines.filter((l) => l[0] === 'S').length;
ok('generated a synthetic inertial stream',
  `${lines.length} records, ${speedRecords} speed measurements, `
  + `${SECONDS}s at ${SPEED_KMH} km/h`);

// ------------------------------------------------------------ run engine
const seed = route[0];
const seedHeading = bearing(route[0], route[1]);

const track = await new Promise((resolve, reject) => {
  const child = spawn(HARNESS,
    [GRAPH, String(seed[1]), String(seed[0]), String(seedHeading)]);
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('error', reject);

  // The harness reads until EOF, so the stream has to be written AND the pipe
  // closed. Omitting the end() leaves it blocked in fgets forever, which
  // presents as a test that simply never returns.
  child.stdin.write(`${lines.join('\n')}\n`);
  child.stdin.end();
  child.on('close', (code) => {
    if (code !== 0) return reject(new Error(`harness exited ${code}: ${err}`));
    console.log(`  engine:   ${err.trim()}`);
    resolve(out.trim().split('\n').filter(Boolean).map((line) => {
      const [lat, lng, heading, speed, cov, matched, edge] = line.split(',');
      return {
        lat: Number(lat), lng: Number(lng),
        heading: Number(heading), speed: Number(speed),
        cov: Number(cov), matched: matched === '1', edge: Number(edge),
      };
    }));
  });
});

assert.ok(track.length > 0, 'the engine emitted no fixes at all');
ok('the C++ engine produced a track', `${track.length} fixes`);

// --------------------------------------------------------------- assert
// Distance from each fix to the nearest corridor vertex. The corridor's
// vertices are ~20 m apart on this route, so nearest-vertex is within a few
// metres of true point-to-polyline distance -- fine at the tolerances below.
function offRoute([lng, lat]) {
  let best = Infinity;
  for (const vertex of route) {
    const d = haversine([lng, lat], vertex);
    if (d < best) best = d;
  }
  return best;
}

const deviations = track.map((f) => offRoute([f.lng, f.lat]));
const worst = Math.max(...deviations);
const mean = deviations.reduce((a, b) => a + b, 0) / deviations.length;

// Report before asserting. When this fails, the shape of the failure is the
// whole diagnosis -- drift that grows steadily is the filter working with a
// weak speed, whereas a step change is a map match snapping to the wrong edge.
const matchedCount = track.filter((f) => f.matched).length;
console.log('  profile:  '
  + [0, 0.25, 0.5, 0.75, 1]
    .map((q) => {
      const i = Math.min(track.length - 1, Math.round(q * (track.length - 1)));
      return `t+${(i / 10).toFixed(0)}s ${deviations[i].toFixed(0)}m`;
    })
    .join('  '));
console.log(`  speed:    seeded 0 -> final ${track[track.length - 1].speed.toFixed(2)} m/s `
  + `(true ${((SPEED_KMH * 1000) / 3600).toFixed(2)})`);
console.log(`  matched:  ${matchedCount} of ${track.length}`);

// The truck must still be ON the North East corridor after two minutes of
// dead reckoning with no GNSS. This is the assertion that a mirrored yaw rate
// fails: a sign error walks the estimate off the route within seconds and the
// deviation runs to kilometres.
//
// 150 m against a measured 54.5 m worst case. The margin is for float and
// sqlite ordering differences across platforms, NOT for drift -- the stream is
// seeded, so on this machine the number is deterministic. If this starts
// failing at 200-400 m, the yaw sign or the speed cadence has regressed; if it
// fails in kilometres, the sign is inverted.
assert.ok(worst < 150,
  `dead reckoning wandered ${worst.toFixed(0)} m off the corridor`);
ok('the dead-reckoned track stays on the corridor',
  `mean ${mean.toFixed(1)} m, worst ${worst.toFixed(1)} m over ${SECONDS}s`);

// Map matching is what bounds the drift (CLAUDE.md decision 8). If nothing
// matched, the number above is unaided dead reckoning and got lucky.
const matched = track.filter((f) => f.matched).length;
assert.ok(matched > 0, 'no fix was ever map-matched; drift is unbounded');
ok('the R*Tree map matcher engaged',
  `${matched} of ${track.length} fixes snapped to the graph`);

// The filter has to ACQUIRE its speed from the injected measurements. It is
// seeded at 0, so a non-zero speed here proves UpdateSpeed reached the EKF --
// the path that is not yet wired to TFLite on the native side.
const finalSpeed = track[track.length - 1].speed;
const truth = (SPEED_KMH * 1000) / 3600;
assert.ok(finalSpeed > 1,
  `the filter never acquired a speed (${finalSpeed} m/s); UpdateSpeed is not reaching it`);
ok('the EKF acquired speed from the injected measurements',
  `${finalSpeed.toFixed(2)} m/s vs ${truth.toFixed(2)} true`);

// Distance actually covered, as a sanity check that the truck MOVED. A
// stationary estimate would sit on the corridor forever and pass every
// deviation check above.
const covered = haversine([track[0].lng, track[0].lat],
  [track[track.length - 1].lng, track[track.length - 1].lat]);
assert.ok(covered > 200,
  `the estimate barely moved: ${covered.toFixed(0)} m in ${SECONDS}s`);
ok('the truck actually travelled', `${(covered / 1000).toFixed(2)} km in ${SECONDS}s`);

console.log(`\n${checks} checks passed`);
