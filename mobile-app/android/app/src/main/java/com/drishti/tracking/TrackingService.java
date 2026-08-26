package com.drishti.tracking;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;

import com.drishti.MainActivity;
import com.drishti.R;

/**
 * Keeps trip tracking alive while the app is backgrounded (MOB-01).
 *
 * WHY THIS IS NOT OPTIONAL: a driver puts the phone in a cradle and the
 * screen goes off, or they switch to a maps app. From Android 8 the system
 * then throttles a backgrounded process's location to a few updates an HOUR,
 * and from Android 12 it may freeze the process outright. Both are silent --
 * the track simply gaps, and it gaps hardest on the long unattended stretches
 * that are the entire point of this platform. A foreground service with a
 * visible notification is the only sanctioned way to keep collecting.
 *
 * The location watch itself stays in JavaScript (see src/services/tracking.js);
 * this service's job is to keep the process alive and hold the wake lock so
 * that code keeps being scheduled. That split is deliberate -- the dark-zone
 * logic, the EKF handoff and the WatermelonDB writes are all already there,
 * and duplicating a second location pipeline in Java would create two sources
 * of truth for the same track.
 */
public class TrackingService extends Service {

  public static final String ACTION_START = "com.drishti.tracking.START";
  public static final String ACTION_UPDATE = "com.drishti.tracking.UPDATE";
  public static final String ACTION_STOP = "com.drishti.tracking.STOP";
  public static final String EXTRA_STATUS = "status";

  private static final String CHANNEL_ID = "drishti.tracking";
  private static final int NOTIFICATION_ID = 1;

  /** Mirrors the service's own lifecycle so JS can ask without binding. */
  private static volatile boolean running = false;

  public static boolean isRunning() {
    return running;
  }

  private PowerManager.WakeLock wakeLock;

  @Override
  public IBinder onBind(Intent intent) {
    return null;   // started, never bound
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    final String action = intent == null ? ACTION_START : intent.getAction();

    if (ACTION_STOP.equals(action)) {
      stopTracking();
      return START_NOT_STICKY;
    }

    final String status = intent == null ? null : intent.getStringExtra(EXTRA_STATUS);
    final Notification notification = buildNotification(status);

    if (ACTION_UPDATE.equals(action) && running) {
      // Already in the foreground: just repaint the text. Calling
      // startForeground again would work but re-asserts the service type on
      // every mode flip, which is noise in the system log and, on some OEM
      // builds, an extra chance to be denied.
      NotificationManager manager = getSystemService(NotificationManager.class);
      if (manager != null) manager.notify(NOTIFICATION_ID, notification);
      return START_STICKY;
    }

    // API 29+ wants the type restated at promotion time, and from API 34 a
    // mismatch with the manifest is a hard crash rather than a warning.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
    } else {
      startForeground(NOTIFICATION_ID, notification);
    }

    acquireWakeLock();
    running = true;

    // START_STICKY: if the OS kills us under memory pressure mid-haul we want
    // to come back. The restart arrives with a null intent, which is why the
    // action defaults to START above rather than dereferencing it.
    return START_STICKY;
  }

  @Override
  public void onDestroy() {
    stopTracking();
    super.onDestroy();
  }

  private void stopTracking() {
    releaseWakeLock();
    running = false;
    // stopForeground(boolean) is deprecated from API 33 in favour of the
    // explicit constant. Same behaviour on both paths: remove the
    // notification rather than leaving it behind detached from any service.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(Service.STOP_FOREGROUND_REMOVE);
    } else {
      stopForeground(true);
    }
    stopSelf();
  }

  /**
   * A PARTIAL wake lock, held for the life of the service.
   *
   * Without it the CPU sleeps between GNSS callbacks with the screen off.
   * That is survivable for 1 Hz GNSS, but the dark-zone path polls the IMU at
   * 100 Hz into the C++ EKF, and a sleeping CPU turns that into a burst of
   * stale samples on each wake -- which the vibration model reads as a
   * different vehicle motion than actually occurred. The lock keeps the
   * sampling honest.
   *
   * Scoped to the service, so it is released the moment tracking stops; it is
   * not a lock the app can leak by being left open.
   */
  private void acquireWakeLock() {
    if (wakeLock != null && wakeLock.isHeld()) return;
    PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
    if (power == null) return;
    wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "drishti:tracking");
    wakeLock.setReferenceCounted(false);
    wakeLock.acquire();
  }

  private void releaseWakeLock() {
    if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
    wakeLock = null;
  }

  private Notification buildNotification(String status) {
    createChannel();

    Intent open = new Intent(this, MainActivity.class);
    open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    // FLAG_IMMUTABLE is mandatory from API 31 and correct everywhere: nothing
    // outside the app has any business rewriting this intent's extras.
    int flags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
    PendingIntent tap = PendingIntent.getActivity(this, 0, open, flags);

    String text = (status == null || status.isEmpty())
        ? getString(R.string.tracking_notification_idle)
        : status;

    return new NotificationCompat.Builder(this, CHANNEL_ID)
        .setContentTitle(getString(R.string.tracking_notification_title))
        .setContentText(text)
        .setSmallIcon(R.drawable.ic_tracking)
        .setContentIntent(tap)
        // The driver must not be able to swipe tracking away by accident, and
        // the notification is the honest signal that location is being read.
        .setOngoing(true)
        .setSilent(true)
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        // Visible on the lock screen: this runs for hours and the driver is
        // entitled to see it without unlocking.
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .build();
  }

  private void createChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    NotificationManager manager = getSystemService(NotificationManager.class);
    if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;

    // IMPORTANCE_LOW: present and persistent, but it must never make a sound
    // or heads-up over a driver.
    NotificationChannel channel = new NotificationChannel(
        CHANNEL_ID,
        getString(R.string.tracking_channel_name),
        NotificationManager.IMPORTANCE_LOW);
    channel.setDescription(getString(R.string.tracking_channel_description));
    channel.setShowBadge(false);
    manager.createNotificationChannel(channel);
  }
}
