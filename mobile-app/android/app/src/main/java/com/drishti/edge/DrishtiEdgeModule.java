package com.drishti.edge;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

/**
 * React Native face of the C++ edge engine (MOB-04).
 *
 * All sequencing lives in EdgeEngineApi; this only marshals. The engine
 * handle is a long held here rather than in JS so a stale JS reference can
 * never be dereferenced natively.
 */
public class DrishtiEdgeModule extends ReactContextBaseJavaModule {
  static { System.loadLibrary("drishti_edge"); }

  private long engine = 0;

  // Reused across every fix. At 10 Hz for a multi-minute blackout, allocating
  // a fresh array per fix is thousands of short-lived objects for the GC to
  // walk on the same thread that is reading sensors.
  private final double[] numbers = new double[7];
  private final boolean[] flags = new boolean[2];

  public DrishtiEdgeModule(ReactApplicationContext context) { super(context); }

  @Override public String getName() { return "DrishtiEdge"; }

  private static native long nativeCreate(String graphPath, String modelPath);
  private static native void nativeDestroy(long handle);
  private static native void nativeReset(long handle, double lat, double lon,
                                         double heading, double speed, double timestamp);
  private static native boolean nativePushImu(long handle, float ax, float ay, float az,
                                              float gyroYaw, float gyroPitch,
                                              float gyroRoll, double timestamp);
  private static native void nativeUpdateSpeed(long handle, double speedMps);
  private static native boolean nativeMapMatch(long handle, double maxDistanceM);
  private static native void nativeGetFix(long handle, double[] numbers, boolean[] flags);
  private static native boolean nativeHasGraph(long handle);

  @ReactMethod
  public void create(String graphPath, String modelPath, Promise promise) {
    if (engine != 0) { nativeDestroy(engine); engine = 0; }
    engine = nativeCreate(graphPath, modelPath);
    if (engine == 0) { promise.reject("create_failed", "could not create the edge engine"); return; }
    promise.resolve(nativeHasGraph(engine));
  }

  @ReactMethod
  public void destroy(Promise promise) {
    if (engine != 0) { nativeDestroy(engine); engine = 0; }
    promise.resolve(true);
  }

  @ReactMethod
  public void reset(double lat, double lon, double heading, double speed,
                    double timestamp, Promise promise) {
    nativeReset(engine, lat, lon, heading, speed, timestamp);
    promise.resolve(true);
  }

  /**
   * Called at 100 Hz, so it is NOT a promise: resolving one per sample would
   * push 100 results a second across the bridge that nothing reads. A fix is
   * emitted as an event, and only when the decimator actually advanced the
   * filter -- i.e. 10 times a second, not 100.
   */
  @ReactMethod
  public void pushImu(float ax, float ay, float az, float gyroYaw,
                      float gyroPitch, float gyroRoll, double timestamp) {
    if (engine == 0) return;
    if (!nativePushImu(engine, ax, ay, az, gyroYaw, gyroPitch, gyroRoll, timestamp)) return;

    nativeGetFix(engine, numbers, flags);
    if (!flags[1]) return;   // not valid yet

    WritableMap fix = Arguments.createMap();
    fix.putDouble("latitude", numbers[0]);
    fix.putDouble("longitude", numbers[1]);
    fix.putDouble("heading_deg", numbers[2]);
    fix.putDouble("speed_mps", numbers[3]);
    fix.putDouble("covariance_m2", numbers[4]);
    fix.putDouble("timestamp_s", numbers[5]);
    fix.putDouble("matched_edge_id", numbers[6]);
    fix.putBoolean("map_matched", flags[0]);

    getReactApplicationContext()
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
        .emit("DrishtiEdgeFix", fix);
  }

  @ReactMethod public void updateSpeed(double speedMps) { nativeUpdateSpeed(engine, speedMps); }

  @ReactMethod
  public void mapMatch(double maxDistanceM, Promise promise) {
    promise.resolve(nativeMapMatch(engine, maxDistanceM));
  }

  @ReactMethod
  public void hasGraph(Promise promise) { promise.resolve(nativeHasGraph(engine)); }
}
