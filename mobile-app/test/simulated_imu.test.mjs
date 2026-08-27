// Checks the synthetic inertial stream that demonstrates a dark zone.
//
//     node test/simulated_imu.test.mjs
//
// This stream is fed straight into the C++ EKF, which integrates its
// timestamps and its yaw rate. Two of the properties below are the kind that
// look fine on screen and are wrong: a yaw rate with the wrong SIGN turns the
// truck the wrong way at every bend, and a timestamp that drifts becomes
// phantom acceleration inside the filter. Neither is visible by reading the
// code, and neither would fail a parse check.
//
// Plain Node, no React Native: simulatedImu.js and simulatedDrive.js import
// nothing from the platform, deliberately, so the geometry can be tested off
// the handset.
import assert from 'node:assert/strict';
import { SimulatedImu } from '../src/services/simulatedImu.js';
import { haversine } from '../src/services/simulatedDrive.js';

let checks = 0;
const ok = (label, extra = '') => {
  checks += 1;
  console.log(`  ok   ${label}${extra ? `  ${extra}` : ''}`);
};

const IMU_HZ = 100;
const toRadians = (d) => (d * Math.PI) / 180;

/**
 * Largest |yaw| across a sample set, refusing an empty one.
 *
 * `Math.max(...[])` is -Infinity, which passes any upper-bound assertion
 * without testing anything. An empty sample set here always means the run
 * emitted nothing -- a corridor already consumed, or a stopped simulator --
 * and that has to fail loudly rather than look like a pass.
 */
function peakYaw(samples) {
  assert.ok(samples.length > 0, 'no samples emitted; the assertion would be vacuous');
  return Math.max(...samples.map((s) => Math.abs(s.gyroYaw)));
}

/// Collect every sample from `ticks` ticks, driving tick() directly rather
/// than through setInterval so the test is deterministic.
function run(imu, ticks) {
  const samples = [];
  imu.onSample = (ax, ay, az, gyroYaw, gyroPitch, gyroRoll, t) =>
    samples.push({ ax, ay, az, gyroYaw, gyroPitch, gyroRoll, t });
  imu.clockS = 0;
  imu.lastHeading = null;
  for (let i = 0; i < ticks; i += 1) imu.tick();
  return samples;
}

// ---------------------------------------------------------------- cadence
// A straight due-east run, so heading is constant and only the clock moves.
{
  const imu = new SimulatedImu({
    coordinates: [[91.0, 26.0], [92.0, 26.0]],
    speedKmh: 60,
  });
  const samples = run(imu, 20);

  assert.equal(samples.length, 100, 'expected 5 samples per 50 ms tick');
  ok('emits at 100 Hz', `${samples.length} samples over 20 ticks`);

  // Exact, not approximate. The filter differentiates these.
  const deltas = samples.slice(1).map((s, i) => s.t - samples[i].t);
  const worst = Math.max(...deltas.map((d) => Math.abs(d - 1 / IMU_HZ)));
  assert.ok(worst < 1e-9, `timestamp spacing drifted by ${worst}s`);
  ok('sample timestamps are exactly 10 ms apart', `max error ${worst.toExponential(1)}s`);

  // 100 samples at 100 Hz is one second; at 60 km/h that is 16.67 m.
  const expected = (60 * 1000) / 3600;
  assert.ok(Math.abs(imu.travelled - expected) < 0.01,
    `travelled ${imu.travelled} m, expected ${expected} m`);
  ok('advances at the requested ground speed', `${imu.travelled.toFixed(2)} m in 1.00 s`);

  // Due east and straight: no turn.
  const maxYaw = peakYaw(samples);
  assert.ok(maxYaw < 1e-6, `straight run produced yaw rate ${maxYaw}`);
  ok('a straight run produces no yaw rate', `max |yaw| ${maxYaw.toExponential(1)} rad/s`);

  // Gravity has to be present on some axis or the vibration channel the speed
  // model reads is nothing like a real handset's.
  const meanAz = samples.reduce((a, s) => a + s.az, 0) / samples.length;
  assert.ok(Math.abs(meanAz - 9.80665) < 0.2, `mean az ${meanAz}`);
  ok('accelerometer carries gravity', `mean az ${meanAz.toFixed(3)} m/s²`);
}

// -------------------------------------------------------------- yaw sign
// THE assertion. DeadReckoning.cpp integrates heading in the COMPASS
// convention -- `heading + gyro_yaw_rate * dt`, clockwise from north -- so a
// right-hand turn must arrive positive. A device-frame gyro reports the
// opposite sign, and getting this backwards mirrors every bend in the route
// while still producing a plausible-looking track.
{
  // Segments of ~100 m, not ~50 km. Sized so the corner is actually reached
  // inside the run: at 120 km/h a 0.5-degree leg takes 25 minutes, and the
  // first version of this test drove straight for 20 seconds and concluded
  // the turn produced no yaw.
  //
  // East, then south: a right turn.
  const right = new SimulatedImu({
    coordinates: [[91.0, 26.0], [91.001, 26.0], [91.001, 25.999]],
    speedKmh: 120,
    loop: false,
  });
  // One run, reused. Calling run() twice on the same instance would find the
  // corridor already consumed (loop is false), emit nothing, and leave
  // Math.max(...[]) === -Infinity -- which satisfies an upper bound
  // vacuously. That is exactly how this assertion first "passed".
  const all = run(right, 200);
  const turns = all.filter((s) => Math.abs(s.gyroYaw) > 1e-9);
  assert.ok(turns.length > 0, 'the corner produced no yaw rate at all');
  const turning = turns[0].gyroYaw;
  assert.ok(turning > 0, `a right turn produced yaw ${turning} rad/s; must be positive`);
  ok('a right turn yields a POSITIVE yaw rate', `${turning.toFixed(3)} rad/s`);

  // Rate-limited to something a vehicle can do. Before the limiter the
  // polyline's instantaneous corner produced 157 rad/s -- four times a real
  // MEMS gyro's saturation point, and a 90-degree turn inside one 10 ms
  // sample. 45 deg/s is 0.785 rad/s.
  const peak = peakYaw(all);
  assert.ok(peak <= toRadians(45) + 1e-9,
    `yaw rate reached ${peak} rad/s, above the ${toRadians(45).toFixed(3)} limit`);
  ok('yaw rate stays within a vehicle-plausible limit',
    `peak ${peak.toFixed(3)} rad/s <= ${toRadians(45).toFixed(3)}`);

  // East, then north: a left turn, and the mirror image.
  const left = new SimulatedImu({
    coordinates: [[91.0, 26.0], [91.001, 26.0], [91.001, 26.001]],
    speedKmh: 120,
    loop: false,
  });
  const leftSamples = run(left, 200).filter((s) => Math.abs(s.gyroYaw) > 1e-9);
  assert.ok(leftSamples.length > 0, 'the corner produced no yaw rate at all');
  assert.ok(leftSamples[0].gyroYaw < 0,
    `a left turn produced yaw ${leftSamples[0].gyroYaw}; must be negative`);
  ok('a left turn yields a NEGATIVE yaw rate', `${leftSamples[0].gyroYaw.toFixed(3)} rad/s`);
}

// --------------------------------------------------------- bearing wrap
// A turn across due north is the case a naive subtraction gets wrong: going
// from 350 to 010 degrees is a 20-degree turn, not a 340-degree one. At
// 100 Hz the wrong answer is a yaw rate of ~590 rad/s, which throws the EKF's
// heading completely.
{
  const imu = new SimulatedImu({
    // North-north-west, then north-north-east: crosses 0 degrees.
    coordinates: [[91.0, 26.0], [90.9995, 26.001], [91.0, 26.002]],
    speedKmh: 120,
    loop: false,
  });
  const samples = run(imu, 200);
  const worst = peakYaw(samples);
  // A real vehicle does not exceed a few rad/s; 590 is the unwrapped bug.
  assert.ok(worst <= toRadians(45) + 1e-9, `yaw rate spiked to ${worst} rad/s crossing north`);
  ok('crossing due north produces no yaw spike', `max |yaw| ${worst.toFixed(3)} rad/s`);
}

// ------------------------------------------------------------ loop wrap
// Wrapping teleports the truck from the far end of the corridor back to the
// origin. Carrying the heading across that discontinuity would hand the
// filter one enormous yaw rate.
{
  const imu = new SimulatedImu({
    coordinates: [[91.0, 26.0], [91.05, 26.0]],
    speedKmh: 300,
    loop: true,
  });
  const samples = run(imu, 400);
  const worst = peakYaw(samples);
  assert.ok(worst <= toRadians(45) + 1e-9, `loop wrap produced yaw rate ${worst} rad/s`);
  assert.ok(imu.travelled < imu.totalM, 'travelled should wrap, not run past the end');
  ok('looping does not spike the yaw rate', `max |yaw| ${worst.toFixed(3)} rad/s`);
}

// ------------------------------------------------------- speed injection
// CLAUDE.md decision 8: the speed model is a WEAK measurement,
// R = RMSE^2 = 27.656638, i.e. sigma = 5.259 m/s. Injecting a clean speed
// here would flatter the platform -- drift is exactly what dead reckoning is
// judged on, and the demonstration has to show the drift the real model
// would produce.
{
  const imu = new SimulatedImu({
    coordinates: [[91.0, 26.0], [92.0, 26.0]],
    speedKmh: 60,
  });

  const n = 200000;
  const draws = Array.from({ length: n }, () => imu.sampleSpeed());
  const mean = draws.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(draws.reduce((a, b) => a + (b - mean) ** 2, 0) / n);

  // The clamp at zero lifts the mean and compresses the spread slightly, so
  // these are loose on purpose -- the point is that the noise is the model's
  // 5.259, not that it is unclamped Gaussian.
  const truth = (60 * 1000) / 3600;
  assert.ok(Math.abs(mean - truth) < 0.6, `mean ${mean} vs ${truth}`);
  ok('injected speed is centred on the true ground speed',
    `mean ${mean.toFixed(2)} m/s vs ${truth.toFixed(2)}`);

  assert.ok(Math.abs(sd - 5.259) < 0.35, `sigma ${sd}, expected ~5.259`);
  ok("noise matches the speed model's held-out RMSE",
    `sigma ${sd.toFixed(3)} m/s vs 5.259 (R = 27.656638)`);

  assert.ok(draws.every((d) => d >= 0), 'a negative ground speed was emitted');
  ok('never emits a negative ground speed');
}

// ------------------------------------------------- corridor is followed
// The whole point: the samples must describe a truck on the ROUTE, not a
// truck wandering. Integrating the emitted heading should retrace the
// corridor to within a few metres.
{
  const corridor = [
    [91.0, 26.0], [91.2, 26.05], [91.35, 26.2], [91.4, 26.45], [91.6, 26.5],
  ];
  const imu = new SimulatedImu({ coordinates: corridor, speedKmh: 90, loop: false });
  run(imu, 100);

  const total = corridor.slice(1)
    .reduce((a, c, i) => a + haversine(corridor[i], c), 0);
  const expected = ((90 * 1000) / 3600) * 5;   // 100 ticks = 5 s

  assert.ok(Math.abs(imu.travelled - expected) < 0.05,
    `travelled ${imu.travelled}, expected ${expected}`);
  assert.ok(imu.travelled < total, 'should still be on the corridor');
  ok('walks the corridor at the requested speed',
    `${imu.travelled.toFixed(1)} m of ${total.toFixed(0)} m in 5 s`);
}

console.log(`\n${checks} checks passed`);
