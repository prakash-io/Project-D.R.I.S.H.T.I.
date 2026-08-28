// Drives the real edge engine from a synthetic inertial stream, and prints
// the track it produces.
//
//     ./sim_drive_track <road_graph.sqlite> <seed_lat> <seed_lng> <seed_heading>
//         < stream.csv  > track.csv
//
// This exists to close the one gap the other two suites leave open.
// test_dead_reckoning proves the EKF and the map matcher are correct against
// the shipped 104 MB graph; mobile-app/test/simulated_imu.test.mjs proves the
// synthetic IMU stream has the right rate, sign, magnitude and noise. Neither
// proves the COMPOSITION -- that feeding one into the other actually tracks a
// North East corridor rather than wandering off it.
//
// That composition is what the driver sees during a demonstrated dark zone,
// and it is where a sign error hides: a yaw rate with the wrong sign still
// produces a smooth, confident, entirely wrong track, and every unit test on
// either side of the join still passes.
//
// Input protocol, one record per line:
//
//     I,ax,ay,az,gyro_yaw,gyro_pitch,gyro_roll,timestamp_s
//     S,speed_mps
//
// Output, one line per fix the engine emitted (i.e. per decimated block):
//
//     lat,lng,heading_deg,speed_mps,covariance_m2,map_matched,matched_edge_id
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include "../EdgeEngineApi.h"

namespace {

/// Matches tracking.js: MAP_MATCH_EVERY_N_FIXES = 50, i.e. 5 s at the
/// engine's 10 Hz decimated output. Kept identical on purpose -- a harness
/// that matched more often than the app would report a track the app cannot
/// actually produce.
constexpr int kDefaultMapMatchEveryNFixes = 50;
constexpr double kMapMatchMaxDistanceM = 60.0;

}  // namespace

int main(int argc, char** argv) {
    if (argc < 5) {
        std::fprintf(stderr,
                     "usage: %s <graph.sqlite> <seed_lat> <seed_lng> <seed_heading_deg>\n",
                     argv[0]);
        return 2;
    }

    const char* graph_path = argv[1];
    const double seed_lat = std::atof(argv[2]);
    const double seed_lng = std::atof(argv[3]);
    const double seed_heading = std::atof(argv[4]);
    // Optional: how often to attempt a map match, in decimated fixes. Exposed
    // so the interval can be MEASURED rather than assumed -- see
    // test/dark_zone_track.test.mjs, which compares 5 s against 1 s on a
    // corridor twisty enough for the difference to matter.
    const int match_every = (argc > 5) ? std::atoi(argv[5])
                                       : kDefaultMapMatchEveryNFixes;

    DrishtiEdgeEngine* engine = DrishtiEdge_Create(graph_path, nullptr);
    if (engine == nullptr) {
        std::fprintf(stderr, "could not create the engine\n");
        return 1;
    }
    if (!DrishtiEdge_HasGraph(engine)) {
        std::fprintf(stderr, "engine has no road graph: %s\n",
                     DrishtiEdge_LastError(engine));
        DrishtiEdge_Destroy(engine);
        return 1;
    }

    // Seeded from the last trusted GNSS fix, exactly as Tracker.startOffline
    // does. Speed starts at 0 rather than at the corridor speed: the filter is
    // supposed to acquire that from the speed measurements, and handing it the
    // answer up front would hide a broken UpdateSpeed path.
    DrishtiEdge_Reset(engine, seed_lat, seed_lng, seed_heading, 0.0, 0.0);

    char line[512];
    long fix_count = 0;
    long emitted = 0;

    while (std::fgets(line, sizeof(line), stdin) != nullptr) {
        if (line[0] == 'S') {
            double speed = 0.0;
            if (std::sscanf(line, "S,%lf", &speed) == 1) {
                DrishtiEdge_UpdateSpeed(engine, speed);
            }
            continue;
        }
        if (line[0] != 'I') continue;

        double ax, ay, az, gy, gp, gr, t;
        if (std::sscanf(line, "I,%lf,%lf,%lf,%lf,%lf,%lf,%lf",
                        &ax, &ay, &az, &gy, &gp, &gr, &t) != 7) {
            continue;
        }

        const bool advanced = DrishtiEdge_PushImu(
            engine,
            static_cast<float>(ax), static_cast<float>(ay), static_cast<float>(az),
            static_cast<float>(gy), static_cast<float>(gp), static_cast<float>(gr),
            t);
        if (!advanced) continue;

        fix_count += 1;
        if (match_every > 0 && fix_count % match_every == 0) {
            DrishtiEdge_MapMatch(engine, kMapMatchMaxDistanceM);
        }

        DrishtiEdgeFix fix;
        DrishtiEdge_GetFix(engine, &fix);
        if (!fix.valid) continue;

        std::printf("%.7f,%.7f,%.2f,%.3f,%.3f,%d,%lld\n",
                    fix.latitude, fix.longitude, fix.heading_deg, fix.speed_mps,
                    fix.covariance_m2, fix.map_matched ? 1 : 0,
                    static_cast<long long>(fix.matched_edge_id));
        emitted += 1;
    }

    std::fprintf(stderr, "%ld decimated fixes, %ld emitted, match every %d\n",
                 fix_count, emitted, match_every);
    DrishtiEdge_Destroy(engine);
    return 0;
}
