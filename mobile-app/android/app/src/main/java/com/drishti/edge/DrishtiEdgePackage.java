package com.drishti.edge;

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.uimanager.ViewManager;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Registers DrishtiEdgeModule (MOB-04).
 *
 * PackageList only autolinks node_modules packages; the edge engine lives in
 * this app, so it has to be added to MainApplication by hand.
 */
public class DrishtiEdgePackage implements ReactPackage {

  @Override
  public List<NativeModule> createNativeModules(ReactApplicationContext context) {
    List<NativeModule> modules = new ArrayList<>();
    modules.add(new DrishtiEdgeModule(context));
    return modules;
  }

  @Override
  public List<ViewManager> createViewManagers(ReactApplicationContext context) {
    return Collections.emptyList();
  }
}
