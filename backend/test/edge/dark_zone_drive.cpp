// dark_zone_drive — drive the REAL edge engine from a stdin IMU stream.
//
// Node cannot call the C++ engine: there is no N-API binding, only the flat C
// surface the JNI and Objective-C++ shims use. Rather than reimplement the EKF
// in JavaScript -- which would prove nothing, because the thing under test is
// the C++ -- the mission script pipes IMU samples into this process and reads
// dead-reckoned fixes back out.
//
// It links the same three translation units the mobile app does
// (DeadReckoning, MapMatcher, EdgeEngineApi) against the same shipped
// road_graph.sqlite, so the R*Tree really is queried.
//
// NOT linked: EKF_TFLite_Bridge.cpp. Running the 1D-CNN needs libtensorflowlite,
// which is an NDK/CocoaPods artefact and is not built on a laptop -- exactly
// why native/test/ ships a stub for it. Consequently the speed measurement is
// injected over `S` lines by the caller instead of being inferred here. The
// EKF and the map matcher are real; the speed model is mocked, and the caller
// is expected to say so.
//
// Protocol, one record per line on stdin:
//     I <ax> <ay> <az> <gyaw> <gpitch> <groll> <t>   raw IMU sample
//     S <speed_mps>                                  weak speed measurement
// One JSON object per line on stdout, emitted whenever a sample completes a
// decimated block and advances the filter.
#include "EdgeEngineApi.h"

#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <sstream>
#include <string>

int main(int argc, char** argv) {
    if (argc < 7) {
        std::fprintf(stderr,
            "usage: %s <graph.sqlite> <lat> <lon> <heading_deg> <speed_mps> <t0>"
            " [match_every_n] [max_match_m]\n", argv[0]);
        return 2;
    }
    const char* graph = argv[1];
    const double lat = std::atof(argv[2]);
    const double lon = std::atof(argv[3]);
    const double heading = std::atof(argv[4]);
    const double speed = std::atof(argv[5]);
    const double t0 = std::atof(argv[6]);
    const long match_every = (argc > 7) ? std::atol(argv[7]) : 50;
    const double max_match_m = (argc > 8) ? std::atof(argv[8]) : 60.0;

    DrishtiEdgeEngine* engine = DrishtiEdge_Create(graph, nullptr);
    if (engine == nullptr) {
        std::fprintf(stderr, "create failed\n");
        return 1;
    }
    // Reported, never assumed: without the graph this run would silently
    // degrade to unaided dead reckoning and the drift assertion would be
    // measuring the wrong thing.
    const bool has_graph = DrishtiEdge_HasGraph(engine);
    std::fprintf(stderr, "has_graph=%s error=\"%s\"\n",
                 has_graph ? "true" : "false", DrishtiEdge_LastError(engine));
    if (!has_graph) {
        DrishtiEdge_Destroy(engine);
        return 3;
    }

    DrishtiEdge_Reset(engine, lat, lon, heading, speed, t0);

    long emitted = 0, matches = 0;
    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;
        std::istringstream in(line);
        char kind = 0;
        in >> kind;

        if (kind == 'S') {
            double mps = 0.0;
            in >> mps;
            DrishtiEdge_UpdateSpeed(engine, mps);
            continue;
        }
        if (kind != 'I') continue;

        double ax, ay, az, gyaw, gpitch, groll, t;
        in >> ax >> ay >> az >> gyaw >> gpitch >> groll >> t;
        const bool advanced = DrishtiEdge_PushImu(
            engine, static_cast<float>(ax), static_cast<float>(ay),
            static_cast<float>(az), static_cast<float>(gyaw),
            static_cast<float>(gpitch), static_cast<float>(groll), t);
        if (!advanced) continue;

        emitted += 1;
        // Mirrors Tracker.startOffline(): match every N advanced fixes, not
        // every sample. Matching at 10 Hz would hammer the R*Tree for a
        // correction the filter has barely moved since.
        if (match_every > 0 && emitted % match_every == 0) {
            if (DrishtiEdge_MapMatch(engine, max_match_m)) matches += 1;
        }

        DrishtiEdgeFix fix;
        DrishtiEdge_GetFix(engine, &fix);
        if (!fix.valid) continue;

        std::printf(
            "{\"lat\":%.7f,\"lng\":%.7f,\"heading_deg\":%.3f,\"speed_mps\":%.4f,"
            "\"covariance_m2\":%.4f,\"timestamp_s\":%.3f,"
            "\"matched_edge_id\":%lld,\"map_matched\":%s}\n",
            fix.latitude, fix.longitude, fix.heading_deg, fix.speed_mps,
            fix.covariance_m2, fix.timestamp_s,
            static_cast<long long>(fix.matched_edge_id),
            fix.map_matched ? "true" : "false");
    }

    std::fflush(stdout);
    std::fprintf(stderr, "emitted=%ld matches=%ld\n", emitted, matches);
    DrishtiEdge_Destroy(engine);
    return 0;
}
