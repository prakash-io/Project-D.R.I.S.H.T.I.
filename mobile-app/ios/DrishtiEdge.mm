// Objective-C++ shim (MOB-04). Mirrors DrishtiEdgeJni.cpp exactly; both are
// thin marshalling over EdgeEngineApi so the two platforms cannot drift.
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

#include "EdgeEngineApi.h"

@interface DrishtiEdge : RCTEventEmitter <RCTBridgeModule>
@end

@implementation DrishtiEdge {
  DrishtiEdgeEngine *_engine;
}

RCT_EXPORT_MODULE();

- (NSArray<NSString *> *)supportedEvents { return @[@"DrishtiEdgeFix"]; }

// The sensor callback runs at 100 Hz; hopping to the main queue for each
// sample would put IMU data behind UI work. The engine is owned by this
// module and touched only from this queue, which is what keeps it safe
// without a lock.
- (dispatch_queue_t)methodQueue {
  return dispatch_queue_create("com.drishti.edge", DISPATCH_QUEUE_SERIAL);
}

RCT_EXPORT_METHOD(create:(NSString *)graphPath
                  modelPath:(NSString *)modelPath
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  if (_engine != NULL) { DrishtiEdge_Destroy(_engine); _engine = NULL; }
  _engine = DrishtiEdge_Create(graphPath.length ? graphPath.UTF8String : NULL,
                               modelPath.length ? modelPath.UTF8String : NULL);
  if (_engine == NULL) {
    reject(@"create_failed", @"could not create the edge engine", nil);
    return;
  }
  resolve(@(DrishtiEdge_HasGraph(_engine)));
}

RCT_EXPORT_METHOD(destroy:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  if (_engine != NULL) { DrishtiEdge_Destroy(_engine); _engine = NULL; }
  resolve(@YES);
}

RCT_EXPORT_METHOD(reset:(double)lat longitude:(double)lon heading:(double)heading
                  speed:(double)speed timestamp:(double)timestamp
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  DrishtiEdge_Reset(_engine, lat, lon, heading, speed, timestamp);
  resolve(@YES);
}

// Not a promise: called 100 times a second, and a resolved promise per sample
// would flood the bridge with results nobody reads. A fix is emitted as an
// event instead, and only when the filter actually advanced.
RCT_EXPORT_METHOD(pushImu:(float)ax ay:(float)ay az:(float)az
                  gyroYaw:(float)gyroYaw gyroPitch:(float)gyroPitch
                  gyroRoll:(float)gyroRoll timestamp:(double)timestamp) {
  if (_engine == NULL) return;
  if (!DrishtiEdge_PushImu(_engine, ax, ay, az, gyroYaw, gyroPitch, gyroRoll, timestamp)) {
    return;  // block not complete; nothing new to report
  }
  DrishtiEdgeFix fix;
  DrishtiEdge_GetFix(_engine, &fix);
  if (!fix.valid) return;

  [self sendEventWithName:@"DrishtiEdgeFix" body:@{
    @"latitude": @(fix.latitude),
    @"longitude": @(fix.longitude),
    @"heading_deg": @(fix.heading_deg),
    @"speed_mps": @(fix.speed_mps),
    @"covariance_m2": @(fix.covariance_m2),
    @"timestamp_s": @(fix.timestamp_s),
    @"map_matched": @(fix.map_matched),
    @"matched_edge_id": @(fix.matched_edge_id),
  }];
}

RCT_EXPORT_METHOD(updateSpeed:(double)speedMps) {
  DrishtiEdge_UpdateSpeed(_engine, speedMps);
}

RCT_EXPORT_METHOD(mapMatch:(double)maxDistanceM
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  resolve(@(DrishtiEdge_MapMatch(_engine, maxDistanceM)));
}

RCT_EXPORT_METHOD(hasGraph:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  resolve(@(DrishtiEdge_HasGraph(_engine)));
}

- (void)dealloc {
  if (_engine != NULL) { DrishtiEdge_Destroy(_engine); _engine = NULL; }
}

@end
