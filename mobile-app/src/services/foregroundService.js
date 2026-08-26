// Foreground service control (MOB-01).
//
// Thin wrapper over the native module in
// android/app/src/main/java/com/drishti/tracking/. See TrackingService.java
// for why a backgrounded app cannot simply keep calling watchPosition.
import { NativeModules, Platform } from 'react-native';

const native = NativeModules.DrishtiTrackingService;

/// iOS keeps background location alive through the Info.plist background mode
/// and `showsBackgroundLocationIndicator`, which the tracker already sets, so
/// there is no service to start there. Every export below no-ops rather than
/// throwing so the tracker does not need a platform branch at each call site.
const available = Platform.OS === 'android' && native != null;

export function isSupported() {
  return available;
}

/** Promote to a foreground service, or repaint it if already running. */
export async function start(status) {
  if (!available) return false;
  try {
    return await native.start(status ?? '');
  } catch (error) {
    // Never fatal to tracking. A refused promotion means the track will gap
    // when backgrounded, which is bad -- but a foreground trip still records,
    // and taking the whole tracker down instead would be worse.
    console.warn('[fgs] could not start foreground service:', error.message);
    return false;
  }
}

/** Repaint the notification text, e.g. GNSS -> dead reckoning. */
export async function update(status) {
  if (!available) return false;
  try {
    return await native.update(status ?? '');
  } catch (error) {
    console.warn('[fgs] could not update notification:', error.message);
    return false;
  }
}

export async function stop() {
  if (!available) return false;
  try {
    return await native.stop();
  } catch (error) {
    console.warn('[fgs] could not stop foreground service:', error.message);
    return false;
  }
}

export async function isRunning() {
  if (!available) return false;
  try {
    return await native.isRunning();
  } catch {
    return false;
  }
}
