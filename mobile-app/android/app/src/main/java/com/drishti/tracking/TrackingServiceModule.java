package com.drishti.tracking;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

/**
 * JS control surface for TrackingService (MOB-01).
 *
 * Deliberately thin: start, repaint, stop, ask. All tracking policy -- when
 * the truck is online, when it drops into dead reckoning -- stays in
 * src/services/tracking.js, which is where the rest of that decision already
 * lives.
 */
public class TrackingServiceModule extends ReactContextBaseJavaModule {

  public TrackingServiceModule(ReactApplicationContext context) {
    super(context);
  }

  @Override
  public String getName() {
    return "DrishtiTrackingService";
  }

  /**
   * Promote to a foreground service.
   *
   * Rejects rather than throwing if location has not been granted: from
   * Android 14 a service declaring foregroundServiceType="location" that is
   * started without the permission is killed with
   * SecurityException/ForegroundServiceStartNotAllowedException. Failing here
   * with a readable reason is far easier to act on than a native crash on a
   * handset in a valley.
   */
  @ReactMethod
  public void start(String status, Promise promise) {
    if (!hasLocationPermission()) {
      promise.reject("E_NO_LOCATION_PERMISSION",
          "ACCESS_FINE_LOCATION must be granted before tracking can run in the background");
      return;
    }
    try {
      Intent intent = new Intent(getReactApplicationContext(), TrackingService.class);
      intent.setAction(TrackingService.ACTION_START);
      intent.putExtra(TrackingService.EXTRA_STATUS, status);
      // startForegroundService, not startService: from API 26 a background
      // start of a plain service throws. The service then has ~5 s to call
      // startForeground, which it does first thing in onStartCommand.
      ContextCompat.startForegroundService(getReactApplicationContext(), intent);
      promise.resolve(true);
    } catch (Exception error) {
      promise.reject("E_START_FAILED", error.getMessage(), error);
    }
  }

  /** Repaint the notification text, e.g. on the GNSS -> dead-reckoning flip. */
  @ReactMethod
  public void update(String status, Promise promise) {
    if (!TrackingService.isRunning()) {
      promise.resolve(false);
      return;
    }
    try {
      Intent intent = new Intent(getReactApplicationContext(), TrackingService.class);
      intent.setAction(TrackingService.ACTION_UPDATE);
      intent.putExtra(TrackingService.EXTRA_STATUS, status);
      ContextCompat.startForegroundService(getReactApplicationContext(), intent);
      promise.resolve(true);
    } catch (Exception error) {
      promise.reject("E_UPDATE_FAILED", error.getMessage(), error);
    }
  }

  @ReactMethod
  public void stop(Promise promise) {
    try {
      Intent intent = new Intent(getReactApplicationContext(), TrackingService.class);
      intent.setAction(TrackingService.ACTION_STOP);
      // stopService, not another startForegroundService: the latter would
      // re-promote a service we are trying to tear down if it had already
      // exited on its own.
      getReactApplicationContext().stopService(intent);
      promise.resolve(true);
    } catch (Exception error) {
      promise.reject("E_STOP_FAILED", error.getMessage(), error);
    }
  }

  @ReactMethod
  public void isRunning(Promise promise) {
    promise.resolve(TrackingService.isRunning());
  }

  private boolean hasLocationPermission() {
    Context context = getReactApplicationContext();
    return ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION)
        == PackageManager.PERMISSION_GRANTED;
  }
}
