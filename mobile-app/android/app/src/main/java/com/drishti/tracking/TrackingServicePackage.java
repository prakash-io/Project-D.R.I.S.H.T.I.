package com.drishti.tracking;

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.uimanager.ViewManager;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Registers TrackingServiceModule (MOB-01).
 *
 * Same reason as DrishtiEdgePackage: PackageList only autolinks node_modules
 * packages, and this service is in-app.
 */
public class TrackingServicePackage implements ReactPackage {

  @Override
  public List<NativeModule> createNativeModules(ReactApplicationContext context) {
    List<NativeModule> modules = new ArrayList<>();
    modules.add(new TrackingServiceModule(context));
    return modules;
  }

  @Override
  public List<ViewManager> createViewManagers(ReactApplicationContext context) {
    return Collections.emptyList();
  }
}
