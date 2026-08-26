// Runtime permissions (MOB-01).
//
// Android 6+ grants none of the dangerous permissions at install time, and
// nothing in this app asked for them -- tracking worked on the bench only
// because the handset had been granted location by hand in Settings. On a
// clean install watchPosition would have failed with PERMISSION_DENIED and
// the foreground service would have refused to start.
import { PermissionsAndroid, Platform } from 'react-native';

/**
 * Ask for everything a trip needs, in the order the driver should see it.
 *
 * Returns { location, notifications }. Only `location` is fatal: without it
 * there is nothing to track. A denied notification permission is degraded but
 * workable -- the foreground service still runs and still keeps the process
 * alive, the driver just does not see the persistent notification. It is NOT
 * treated as fatal for that reason, but it is reported so the caller can say
 * so out loud rather than leaving the driver wondering why nothing is shown.
 */
export async function requestTrackingPermissions() {
  if (Platform.OS !== 'android') {
    // iOS declares its usage strings in Info.plist and the OS prompts on
    // first use; there is no equivalent imperative request to make here.
    return { location: true, notifications: true };
  }

  const location = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    {
      title: 'Drishti needs this truck’s location',
      message: 'Position is recorded for the whole trip, including when the '
        + 'screen is off, so the route is complete through areas with no signal.',
      buttonPositive: 'Allow',
    },
  );

  // POST_NOTIFICATIONS only exists from API 33. Requesting it on an older
  // build returns never-granted rather than throwing, which would read as a
  // denial on every handset below 13 -- so gate on the version instead.
  let notifications = true;
  if (Platform.Version >= 33) {
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    );
    notifications = result === PermissionsAndroid.RESULTS.GRANTED;
  }

  return {
    location: location === PermissionsAndroid.RESULTS.GRANTED,
    notifications,
  };
}
