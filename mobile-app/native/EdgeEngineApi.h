// EdgeEngineApi.h — one flat C surface over the whole edge engine.
//
// Android binds through JNI and iOS through Objective-C++, and both need the
// same behaviour. Exposing the C++ classes to each separately would mean two
// places to get the ordering wrong -- decimate, predict, infer, match, and
// only then read a fix. This owns that sequence once; the platform shims just
// marshal arguments.
//
// C linkage and POD types on purpose: no exceptions cross this boundary, no
// std:: types appear in it, and a JNI call cannot leak a C++ object.
//
// Lifecycle:
//     handle = DrishtiEdge_Create(graph_path, model_path);
//     DrishtiEdge_Reset(h, lat, lon, heading, speed, t);   // last GPS fix
//     DrishtiEdge_PushImu(h, ax, ay, az, gx, gy, gz, t);   // at 100 Hz
//     DrishtiEdge_GetFix(h, &fix);                         // whenever needed
//     DrishtiEdge_Destroy(h);

#ifndef DRISHTI_EDGE_ENGINE_API_H
#define DRISHTI_EDGE_ENGINE_API_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct DrishtiEdgeEngine DrishtiEdgeEngine;

/// A dead-reckoned fix, in the shape the WatermelonDB row and the burst-sync
/// payload both need. `covariance_m2` is not optional: the telemetry table's
/// CHECK constraint rejects an 'ekf' row without it.
typedef struct {
    double latitude;
    double longitude;
    double heading_deg;
    double speed_mps;
    double covariance_m2;
    double timestamp_s;
    int64_t matched_edge_id;   ///< 0 when this fix was not map-matched
    bool map_matched;
    bool valid;                ///< false before Reset() or with no samples yet
} DrishtiEdgeFix;

/// Create an engine. `graph_path` is road_graph.sqlite; either path may be
/// NULL, in which case that capability is simply unavailable -- a missing
/// road graph disables map matching rather than failing the whole engine,
/// because unaided dead reckoning is still better than nothing.
DrishtiEdgeEngine* DrishtiEdge_Create(const char* graph_path, const char* model_path);
void DrishtiEdge_Destroy(DrishtiEdgeEngine* engine);

/// Seed from the last trusted GNSS fix, at the moment signal was lost.
void DrishtiEdge_Reset(DrishtiEdgeEngine* engine, double latitude, double longitude,
                       double heading_deg, double speed_mps, double timestamp_s);

/**
 * Feed one raw IMU sample at the handset's native rate (100 Hz).
 *
 * Returns true when this sample completed a decimated block and therefore
 * advanced the filter -- i.e. when there is a new fix worth storing. The
 * caller writes to WatermelonDB on true and does nothing on false, which is
 * what keeps a 100 Hz sensor from producing 100 rows a second.
 */
bool DrishtiEdge_PushImu(DrishtiEdgeEngine* engine,
                         float ax, float ay, float az,
                         float gyro_yaw, float gyro_pitch, float gyro_roll,
                         double timestamp_s);

/// Fold in a speed from the TFLite model, in m/s. Weak by construction.
void DrishtiEdge_UpdateSpeed(DrishtiEdgeEngine* engine, double speed_mps);

/// Snap to the road graph. Returns true when a match was accepted.
bool DrishtiEdge_MapMatch(DrishtiEdgeEngine* engine, double max_distance_m);

void DrishtiEdge_GetFix(const DrishtiEdgeEngine* engine, DrishtiEdgeFix* out);

/// True when the road graph opened. Map matching is a no-op without it.
bool DrishtiEdge_HasGraph(const DrishtiEdgeEngine* engine);

/// Last error, or "" -- never NULL. Owned by the engine.
const char* DrishtiEdge_LastError(const DrishtiEdgeEngine* engine);

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // DRISHTI_EDGE_ENGINE_API_H
