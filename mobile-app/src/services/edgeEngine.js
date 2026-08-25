// JS face of the C++ edge engine (MOB-04/MOB-06).
//
// The native side owns the ordering -- decimate, predict, infer, map-match --
// so this module is deliberately thin. Anything clever here would be a second
// place for that sequence to go wrong.
import { NativeModules, NativeEventEmitter } from 'react-native';

const { DrishtiEdge } = NativeModules;

if (!DrishtiEdge) {
  // Loud, because silently degrading to "no dead reckoning" is the one
  // failure the driver cannot see and the dispatcher cannot diagnose.
  console.error(
    '[edge] the DrishtiEdge native module is not linked. Dark-zone dead ' +
    'reckoning is UNAVAILABLE; the app will lose the truck when GNSS drops.',
  );
}

export const isAvailable = () => Boolean(DrishtiEdge);

/**
 * Start the engine, seeded from the last trusted GNSS fix.
 *
 * `graphPath` is the bundled road_graph.sqlite. Without it the engine still
 * dead-reckons, it just cannot map-match -- which is far worse but still
 * better than losing the truck entirely.
 */
export async function start({ graphPath, modelPath, lastFix }) {
  if (!DrishtiEdge) return false;
  await DrishtiEdge.create(graphPath ?? null, modelPath ?? null);
  await DrishtiEdge.reset(
    lastFix.latitude,
    lastFix.longitude,
    lastFix.heading ?? 0,
    lastFix.speed ?? 0,
    (lastFix.timestamp ?? Date.now()) / 1000,
  );
  return true;
}

export async function stop() {
  if (DrishtiEdge) await DrishtiEdge.destroy();
}

/**
 * Subscribe to dead-reckoned fixes.
 *
 * The native side emits one per DECIMATED sample (10 Hz), not per raw IMU
 * sample (100 Hz). Bridging 100 events a second across the RN bridge would
 * cost more than the filter does, and 9 in 10 of them would carry no new
 * information anyway.
 */
export function subscribe(onFix) {
  if (!DrishtiEdge) return () => {};
  const emitter = new NativeEventEmitter(DrishtiEdge);
  const subscription = emitter.addListener('DrishtiEdgeFix', onFix);
  return () => subscription.remove();
}

/**
 * Feed one raw IMU sample at the handset's 100 Hz.
 *
 * Deliberately fire-and-forget rather than awaited: this is called 100 times
 * a second from the sensor callback, and awaiting a bridge round trip on each
 * one would queue the sensor stream behind the JS thread. The native side
 * decimates and only emits a fix when the filter actually advanced.
 */
export function pushImu(ax, ay, az, gyroYaw, gyroPitch, gyroRoll, timestampS) {
  if (!DrishtiEdge) return;
  DrishtiEdge.pushImu(ax, ay, az, gyroYaw, gyroPitch, gyroRoll, timestampS);
}

/// Snap the current estimate to the road graph. Resolves to true if accepted.
export function mapMatch(maxDistanceM = 60) {
  if (!DrishtiEdge) return Promise.resolve(false);
  return DrishtiEdge.mapMatch(maxDistanceM);
}

/// Fold in a speed from the TFLite model, m/s. Weak by construction (Q3).
export function updateSpeed(speedMps) {
  if (!DrishtiEdge) return;
  DrishtiEdge.updateSpeed(speedMps);
}

export function getFix() {
  if (!DrishtiEdge) return Promise.resolve(null);
  return DrishtiEdge.getFix();
}

export const hasGraph = () => (DrishtiEdge ? DrishtiEdge.hasGraph() : Promise.resolve(false));
