// Connectivity listener (MOB-03).
//
// Drives the whole mode switch: online means 1 Hz GNSS streamed over
// Socket.IO, offline means 100 Hz IMU into the C++ engine and rows into
// WatermelonDB.
import NetInfo from '@react-native-community/netinfo';

/**
 * Watch connectivity and fire on transitions only.
 *
 * `isInternetReachable`, not just `isConnected`: a truck in a valley often
 * holds a cell association with no usable data path, and treating that as
 * online means the app stops dead reckoning at exactly the wrong moment.
 * Null means "not yet determined" and is deliberately treated as offline --
 * the safe direction, because dead reckoning that was not needed costs
 * nothing, while dead reckoning that was needed and did not run loses the truck.
 */
export function watchConnectivity({ onOnline, onOffline }) {
  let wasOnline = null;

  return NetInfo.addEventListener((state) => {
    const online = Boolean(state.isConnected) && state.isInternetReachable === true;
    if (online === wasOnline) return;
    wasOnline = online;
    if (online) onOnline(state);
    else onOffline(state);
  });
}
