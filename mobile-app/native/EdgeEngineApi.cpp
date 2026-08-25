// EdgeEngineApi.cpp — the sequence the platform shims must not have to know.

#include "EdgeEngineApi.h"

#include <cmath>
#include <memory>
#include <string>

#include "DeadReckoning.h"
#include "MapMatcher.h"

using drishti::DeadReckoningEkf;
using drishti::DrFix;
using drishti::ImuDecimator;
using drishti::ImuSample;
using drishti::MapMatch;
using drishti::MapMatcher;
using drishti::MatchStatus;

struct DrishtiEdgeEngine {
    ImuDecimator decimator{100, drishti::kModelRateHz};
    DeadReckoningEkf ekf{};
    MapMatcher matcher;
    std::string model_path;
    std::string error;
    std::int64_t last_edge_id = 0;
    bool has_graph = false;
};

extern "C" {

DrishtiEdgeEngine* DrishtiEdge_Create(const char* graph_path, const char* model_path) {
    auto engine = std::make_unique<DrishtiEdgeEngine>();
    if (model_path != nullptr) engine->model_path = model_path;

    if (graph_path != nullptr && graph_path[0] != '\0') {
        engine->has_graph = engine->matcher.Open(graph_path);
        if (!engine->has_graph) {
            // Not fatal. Unaided dead reckoning still beats losing the truck
            // entirely, and the caller can see why via LastError().
            engine->error = engine->matcher.Error();
        }
    }
    return engine.release();
}

void DrishtiEdge_Destroy(DrishtiEdgeEngine* engine) { delete engine; }

void DrishtiEdge_Reset(DrishtiEdgeEngine* engine, double latitude, double longitude,
                       double heading_deg, double speed_mps, double timestamp_s) {
    if (engine == nullptr) return;
    engine->decimator.Reset();
    engine->ekf.Reset(latitude, longitude, heading_deg, speed_mps, timestamp_s);
    engine->last_edge_id = 0;
}

bool DrishtiEdge_PushImu(DrishtiEdgeEngine* engine,
                         float ax, float ay, float az,
                         float gyro_yaw, float gyro_pitch, float gyro_roll,
                         double timestamp_s) {
    if (engine == nullptr) return false;

    ImuSample sample;
    sample.ax = ax;
    sample.ay = ay;
    sample.az = az;
    sample.gyro_yaw = gyro_yaw;
    sample.gyro_pitch = gyro_pitch;
    sample.gyro_roll = gyro_roll;
    sample.timestamp_s = timestamp_s;

    const auto decimated = engine->decimator.Push(sample);
    if (!decimated.has_value()) return false;

    engine->ekf.Predict(decimated->gyro_yaw, decimated->timestamp_s);
    return true;
}

void DrishtiEdge_UpdateSpeed(DrishtiEdgeEngine* engine, double speed_mps) {
    if (engine == nullptr) return;
    engine->ekf.UpdateSpeed(speed_mps);
}

bool DrishtiEdge_MapMatch(DrishtiEdgeEngine* engine, double max_distance_m) {
    if (engine == nullptr || !engine->has_graph) return false;

    const DrFix fix = engine->ekf.Current();
    if (!std::isfinite(fix.latitude_deg) || !std::isfinite(fix.longitude_deg)) return false;

    MapMatch match;
    const MatchStatus status =
        engine->matcher.Match(fix.latitude_deg, fix.longitude_deg, max_distance_m, &match);
    if (status != MatchStatus::kOk) {
        engine->error = drishti::ToString(status);
        return false;
    }

    engine->ekf.UpdateMapMatch(match.latitude_deg, match.longitude_deg, match.bearing_deg);
    engine->last_edge_id = match.edge_id;
    return true;
}

void DrishtiEdge_GetFix(const DrishtiEdgeEngine* engine, DrishtiEdgeFix* out) {
    if (out == nullptr) return;
    *out = DrishtiEdgeFix{};
    if (engine == nullptr) return;

    const DrFix fix = engine->ekf.Current();
    out->latitude = fix.latitude_deg;
    out->longitude = fix.longitude_deg;
    out->heading_deg = fix.heading_deg;
    out->speed_mps = fix.speed_mps;
    out->covariance_m2 = fix.covariance_m2;
    out->timestamp_s = fix.timestamp_s;
    out->map_matched = fix.map_matched;
    out->matched_edge_id = fix.map_matched ? engine->last_edge_id : 0;
    out->valid = engine->ekf.Initialised();
}

bool DrishtiEdge_HasGraph(const DrishtiEdgeEngine* engine) {
    return engine != nullptr && engine->has_graph;
}

const char* DrishtiEdge_LastError(const DrishtiEdgeEngine* engine) {
    return (engine == nullptr) ? "" : engine->error.c_str();
}

}  // extern "C"
