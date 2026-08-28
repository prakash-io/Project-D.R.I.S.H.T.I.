// Simulated inertial stream for a demonstrated dark zone (MOB-06).
//
// The problem this solves
// -----------------------
// SimulatedDrive substitutes the GNSS receiver, which covers workflow section
// 1 — a truck moving on a corridor with the network up. It does nothing for
// section 2, the part this platform actually exists for, because dead
// reckoning is not fed by the position source at all. It is fed by the IMU.
//
// So a handset sitting on a desk with the network pulled produces a perfectly
// working dark zone in which the truck does not move: the accelerometer reads
// gravity, the gyroscope reads nothing, and the EKF correctly concludes the
// vehicle is stationary. The offline half of the demonstration cannot be shown
// on a stationary phone with real sensors, no matter how the toggle is wired.
//
// This walks the same corridor geometry and synthesises the IMU stream a truck
// driving it would produce. Everything downstream is untouched: the same
// edge.pushImu, the same C++ decimator, the same Extended Kalman Filter, the
// same R*Tree map matching, the same WatermelonDB rows. The SENSOR is
// substituted, never the system — the identical contract SimulatedDrive keeps
// for GNSS, and the reason both are honest to demonstrate with.
//
// What is real here and what is not
// ---------------------------------
// Real: the decimation, the EKF prediction and covariance growth, the gyro
// heading integration, the map matching against the 486k-edge extract, the
// persistence, the burst sync.
//
// Not real: the vibration signature, and the speed measurement.
//
// The speed deserves the detail, because it is the one place this could
// quietly overstate the system. On a handset the forward speed is supposed to
// come from the TFLite 1D-CNN reading vibration. Feeding that model synthetic
// vibration would be meaningless — it was trained on IO-VNBD recordings of
// real vehicles, and invented noise is out of distribution for it, so its
// output would be arbitrary rather than merely imprecise. Worse, a *clean*
// injected speed would flatter the platform: drift is exactly what dead
// reckoning is judged on.
//
// So the speed is injected at the model's own measured error — Gaussian noise
// at sigma = sqrt(kSpeedMeasurementVariance) = 5.259 m/s, the held-out RMSE
// from native/IMU_Constants.h. That is the same choice the Chunk 5 mission
// makes, and it means the drift the demonstration shows is the drift the real
// speed model would produce. What bounds it is the map matching, per
// CLAUDE.md decision 8, and that runs for real.
// Imported with the explicit extension, unlike the rest of src/. Metro
// resolves both, but Node's ESM loader resolves only this form -- and being
// runnable under plain Node is the entire reason this module imports nothing
// from React Native. test/simulated_imu.test.mjs is what that buys.
import { bearing, measure } from './simulatedDrive.js';

/// Matches native/IMU_Constants.h: kSpeedMeasurementVariance = 27.656638,
/// i.e. the speed model's held-out RMSE of 5.259 m/s. Kept as the variance so
/// the two files can be compared without a square root in between.
const SPEED_MEASUREMENT_VARIANCE = 27.656638;
const SPEED_SIGMA = Math.sqrt(SPEED_MEASUREMENT_VARIANCE);

const IMU_HZ = 100;
/**
 * Rate at which the speed measurement is delivered — the MODEL's rate, not a
 * convenient round number.
 *
 * native/IMU_Constants.h sets kModelRateHz = 10: the engine decimates 100 Hz
 * to 10 Hz and the 1D-CNN produces one speed estimate per decimated sample.
 * backend/simulate_dark_zone_mission.mjs injects at exactly that rate for the
 * same reason.
 *
 * This was 1 Hz in the first version and it mattered a great deal. The
 * measurement is deliberately weak (sigma 5.259 m/s against a 13.9 m/s ground
 * truth), so the filter depends on averaging many of them; at a tenth of the
 * intended rate it got a tenth of the information, and the estimate drifted
 * past the map matcher's 60 m acceptance radius after about forty seconds.
 * Once outside it, no match is accepted and the drift is unbounded — the
 * dead-reckoned track ran 622 m off a corridor it should have held to metres.
 */
const MODEL_HZ = 10;
const SAMPLES_PER_SPEED = IMU_HZ / MODEL_HZ;
/// Wall-clock cadence of the emitting timer. Deliberately NOT 100 Hz: a
/// JS interval asking for 10 ms is not honoured on a busy RN thread and the
/// jitter would land in the sample TIMESTAMPS, which is what the filter
/// integrates over. Ticking at 20 Hz and emitting five correctly-spaced
/// samples per tick keeps dt exact regardless of when the timer actually ran.
const TICK_MS = 50;
const SAMPLES_PER_TICK = (IMU_HZ * TICK_MS) / 1000;

const GRAVITY = 9.80665;
const toRad = (d) => (d * Math.PI) / 180;

/**
 * Ceiling on how fast the simulated truck may change heading, degrees/second.
 *
 * This exists because a corridor is a POLYLINE, and a polyline turns corners
 * instantaneously. Taking the bearing difference between consecutive segments
 * and dividing by dt produced 157 rad/s at every vertex -- a 90-degree turn
 * completed inside one 10 ms sample.
 *
 * That is not a small inaccuracy. A real MEMS gyro saturates around 35 rad/s,
 * so 157 is not a reading any sensor could produce; the stream would have been
 * replaying vertices rather than simulating a vehicle. The EKF would integrate
 * it to the right heading -- `heading + rate * dt` gets there either way --
 * while its covariance model, which treats gyro noise as a RATE, was handed a
 * rate four times past the hardware's range.
 *
 * 45 deg/s is a hard but real turn: roughly a loaded truck taking a hairpin at
 * walking pace. The consequence is that heading LAGS on tight corners, which
 * is what happens in a real vehicle too, and is exactly the error the map
 * matcher exists to absorb.
 */
const MAX_YAW_RATE_DEG_S = 45;

/**
 * Floor on the corner slow-down, as a fraction of the requested speed.
 *
 * The worst hairpin on Guwahati -> Shillong asks for 569 deg/s at 50 km/h,
 * which scaled naively would crawl the truck to under 4 km/h and stall the
 * demonstration on one bend. 0.15 is 7.5 km/h at a 50 km/h setting: slow, but
 * the speed a vehicle really does take a switchback at.
 */
const MIN_CORNER_SPEED_FRACTION = 0.15;

/// Box-Muller, drawing from an injectable uniform source. One normal deviate
/// per call; the second is discarded, which costs a log and a sqrt that are
/// not worth caching at 10 Hz.
function gaussian(rand) {
  let u = 0;
  while (u === 0) u = rand();   // log(0) is -Infinity
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/**
 * mulberry32 — a small seedable PRNG, for reproducible streams.
 *
 * Exported because tests need it and because a flaky measurement here is
 * worse than none: the injected speed noise is deliberately large (sigma
 * 5.259 m/s against 13.9 m/s of signal), so two runs of the SAME
 * configuration produced 43 m and 399 m of worst-case deviation. A number
 * that swings by an order of magnitude between runs cannot tell anyone
 * whether a change helped.
 */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/// Smallest signed difference between two compass bearings, degrees.
/// Without the wrap, crossing north reads as a 359-degree turn and the EKF
/// swings the heading right round.
function bearingDelta(from, to) {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

export class SimulatedImu {
  /**
   * @param {number[][]} opts.coordinates   [[lng, lat], ...] from the corridor
   * @param {number}   opts.speedKmh        ground speed to simulate
   * @param {boolean}  opts.loop            restart at the origin on arrival
   * @param {function} opts.onSample        (ax, ay, az, gyroYaw, gyroPitch, gyroRoll, tS)
   * @param {function} opts.onSpeed         (speedMps) — the noisy measurement
   * @param {function} opts.random          uniform source; seed it in tests
   */
  constructor({
    coordinates, speedKmh = 60, loop = true, onSample, onSpeed,
    random = Math.random,
  }) {
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      throw new Error('simulated IMU needs a corridor of at least two points');
    }
    this.coordinates = coordinates;
    this.cum = measure(coordinates);
    this.totalM = this.cum[this.cum.length - 1];
    this.speedMps = (speedKmh * 1000) / 3600;
    this.loop = loop;
    this.onSample = onSample;
    this.onSpeed = onSpeed;
    this.random = random;

    this.travelled = 0;
    this.segment = 0;
    // Instantaneous speed. Diverges from speedMps through corners, which is
    // what keeps the emitted heading consistent with the emitted motion.
    this.currentSpeedMps = this.speedMps;
    this.timer = null;
    this.sampleIndex = 0;
    // Monotonic sample clock in seconds. Seeded once at start and advanced by
    // exactly 1/IMU_HZ per sample, never read from Date.now() per sample: the
    // filter differentiates these timestamps, so wall-clock jitter would
    // become phantom acceleration.
    this.clockS = 0;
    this.lastHeading = null;
  }

  get progress() {
    return this.totalM > 0 ? this.travelled / this.totalM : 0;
  }

  start() {
    if (this.timer) return;
    this.clockS = Date.now() / 1000;
    this.lastHeading = null;

    // One timer, not two. The speed measurement is emitted from inside tick()
    // on the sample clock rather than on its own wall-clock interval, so it
    // stays locked to the model's rate however the timer actually fires.
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  /**
   * One speed measurement, as noisy as the real model's.
   *
   * A method rather than an inline expression so a test can draw from it
   * directly and check the distribution, without having to drive a timer.
   *
   * Clamped at zero because a negative ground speed is not a measurement the
   * filter should ever receive, and at 5.259 m/s of noise around a 13.9 m/s
   * mean the tail does reach below zero every few hundred samples.
   */
  sampleSpeed() {
    // Centred on the INSTANTANEOUS speed, not the nominal one: the model reads
    // vibration from the vehicle as it is moving now, and a truck braking for a
    // switchback is exactly when a stale nominal speed would push the filter
    // hardest in the wrong direction.
    return Math.max(0, this.currentSpeedMps + gaussian(this.random) * SPEED_SIGMA);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.sampleIndex = 0;
  }

  /** Emit one tick's worth of samples, each advancing the truck along the route. */
  tick() {
    const dt = 1 / IMU_HZ;

    for (let i = 0; i < SAMPLES_PER_TICK; i += 1) {
      // Advance by LAST sample's speed, which the steering below may have cut
      // for a corner. Order matters: the truck slows before the bend it is
      // already in, not after leaving it.
      this.travelled += this.currentSpeedMps * dt;

      if (this.travelled >= this.totalM) {
        if (!this.loop) { this.travelled = this.totalM; this.stop(); return; }
        this.travelled %= this.totalM;
        this.segment = 0;
        // The wrap teleports the truck from the far end back to the origin.
        // Carrying the heading across that discontinuity would hand the EKF
        // one enormous yaw rate and throw the filter; treat it as a fresh
        // start instead.
        this.lastHeading = null;
      }

      while (this.segment < this.cum.length - 2
             && this.cum[this.segment + 1] < this.travelled) {
        this.segment += 1;
      }

      const a = this.coordinates[this.segment];
      const b = this.coordinates[Math.min(this.segment + 1, this.coordinates.length - 1)];
      // Where the ROAD points. The truck steers toward this rather than
      // snapping to it.
      const targetDeg = bearing(a, b);

      // Yaw rate in rad/s, positive clockwise.
      //
      // That sign is not arbitrary and not the usual one. DeadReckoning.cpp
      // integrates heading as `heading + gyro_yaw_rate * dt` in the compass
      // convention (clockwise from north, line 136), so a right-hand turn must
      // arrive POSITIVE. A device-frame gyro would report the opposite. This
      // stream is generated to the filter's convention directly.
      //
      // Rate-limited, per MAX_YAW_RATE_DEG_S: the heading slews toward the
      // road's bearing at a speed a vehicle could actually turn, instead of
      // teleporting to it at each polyline vertex.
      let yawRate = 0;
      if (this.lastHeading === null) {
        // First sample of a run, or the first after a loop wrap. The truck is
        // already pointing along the road; it did not turn to get there.
        this.lastHeading = targetDeg;
        this.currentSpeedMps = this.speedMps;
      } else {
        const maxStepDeg = MAX_YAW_RATE_DEG_S * dt;
        const wanted = bearingDelta(this.lastHeading, targetDeg);
        const stepDeg = Math.max(-maxStepDeg, Math.min(maxStepDeg, wanted));
        yawRate = toRad(stepDeg) / dt;
        this.lastHeading = (this.lastHeading + stepDeg + 360) % 360;

        // Slow down for the corner, exactly as a driver does.
        //
        // Without this the truck holds 50 km/h through bends that physically
        // demand more steering than MAX_YAW_RATE_DEG_S allows, so its heading
        // LAGS the road while its position keeps advancing along the polyline
        // -- and the emitted IMU then describes a vehicle that is not the one
        // the simulator is moving. Integrating that stream cuts every corner,
        // and on Guwahati -> Shillong the dead-reckoned track ran 389 m wide
        // of a road it should hold to metres.
        //
        // Measured on that corridor at 50 km/h: half the bends need only
        // 5 deg/s and 90% need under 22, but 1.9% demand more than 45 and the
        // worst hairpin needs 569. Those are the turns no loaded truck takes
        // at speed either.
        //
        // Scaling speed by (what we can turn / what the road asks) is the
        // condition for heading and motion to stay consistent: the truck
        // arrives at the bend slowly enough to steer through it.
        const asked = Math.abs(wanted);
        this.currentSpeedMps = asked > maxStepDeg
          ? this.speedMps * Math.max(MIN_CORNER_SPEED_FRACTION, maxStepDeg / asked)
          : this.speedMps;
      }

      // Lateral acceleration is the real centripetal term, v * omega, so a
      // hairpin on the Shillong climb produces the sideways force it actually
      // would. The rest is a vibration floor: this is the channel the speed
      // model reads, and a perfectly still accelerometer is the one input
      // guaranteed not to resemble a moving truck.
      const vibration = () => (this.random() - 0.5) * 0.35;
      const ax = vibration();
      const ay = this.currentSpeedMps * yawRate + vibration();
      const az = GRAVITY + vibration();

      this.clockS += dt;
      this.onSample?.(ax, ay, az, yawRate, vibration() * 0.02, vibration() * 0.02,
        this.clockS);

      // The speed measurement, at the model's 10 Hz. Counted in samples rather
      // than timed, so it cannot drift out of step with the IMU stream the
      // engine decimates.
      this.sampleIndex += 1;
      if (this.sampleIndex % SAMPLES_PER_SPEED === 0) {
        this.onSpeed?.(this.sampleSpeed());
      }
    }
  }
}
