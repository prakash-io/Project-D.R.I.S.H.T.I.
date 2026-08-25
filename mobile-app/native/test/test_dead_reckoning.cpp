// Verification for the EKF and the map matcher (Chunk 3, task 3.4).
//
//     make -C mobile-app/native/test run-dr
//
// Two things are being proved:
//
//   1. 50 mock IMU samples fed through the decimator and the EKF produce a
//      dead-reckoned position that is correct, not merely non-crashing. The
//      checks assert direction and distance against hand-computable values,
//      because an EKF that is subtly wrong still returns plausible numbers.
//
//   2. The engine queries the real 104 MB R*Tree extract without segfaulting,
//      and snaps to a road that is actually there.

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "DeadReckoning.h"
#include "EdgeEngineApi.h"
#include "MapMatcher.h"

namespace {

int g_checks = 0;
int g_failures = 0;

void Check(bool condition, const char* what) {
    ++g_checks;
    if (condition) {
        std::printf("  ok   %s\n", what);
    } else {
        ++g_failures;
        std::printf("  FAIL %s\n", what);
    }
}

void CheckNear(double actual, double expected, double tolerance, const char* what) {
    ++g_checks;
    const bool ok = std::abs(actual - expected) <= tolerance;
    if (ok) {
        std::printf("  ok   %-58s %.4f\n", what, actual);
    } else {
        ++g_failures;
        std::printf("  FAIL %-58s got %.6f, expected %.6f +/- %g\n",
                    what, actual, expected, tolerance);
    }
}

void Section(const char* title) { std::printf("\n%s\n", title); }

// Guwahati, on the Brahmaputra. Real roads exist here in the extract.
constexpr double kStartLat = 26.1445;
constexpr double kStartLon = 91.7362;

}  // namespace

int main(int argc, char** argv) {
    using namespace drishti;

    std::printf("=== Chunk 3 verification: C++ dead reckoning engine ===\n");

    // ---------------------------------------------------------- decimator
    Section("100 Hz -> 10 Hz decimation (the model was trained at 10 Hz)");
    {
        ImuDecimator decimator(100, kModelRateHz);
        Check(decimator.Factor() == 10, "decimation factor is 10");

        int emitted = 0;
        ImuSample last{};
        for (int i = 0; i < 50; ++i) {
            ImuSample s{};
            s.ax = 1.0f;
            s.ay = 0.0f;
            s.az = 9.81f;
            // 0.0 and 0.2 alternating: the mean is 0.1, but taking every
            // tenth sample would return whichever phase it landed on.
            s.gyro_yaw = (i % 2 == 0) ? 0.0f : 0.2f;
            s.timestamp_s = 0.01 * i;
            if (auto out = decimator.Push(s)) {
                ++emitted;
                last = *out;
            }
        }
        Check(emitted == 5, "50 samples at 100 Hz emit 5 decimated samples");
        CheckNear(last.gyro_yaw, 0.1, 1e-6, "block mean is averaged, not sub-sampled");
        CheckNear(last.timestamp_s, 0.49, 1e-9, "decimated sample carries the block's last time");
    }

    // ------------------------------------------------- straight-line drive
    Section("50 mock IMU samples -> dead-reckoned coordinates");
    {
        DeadReckoningEkf ekf;
        Check(!ekf.Initialised(), "refuses to run before Reset()");

        // Heading 0 = due North, 20 m/s.
        ekf.Reset(kStartLat, kStartLon, /*heading_deg=*/0.0, /*speed=*/20.0, /*t=*/0.0);
        Check(ekf.Initialised(), "initialised from the last GPS fix");

        ImuDecimator decimator(100, kModelRateHz);
        int predicts = 0;
        for (int i = 1; i <= 50; ++i) {
            ImuSample s{};
            s.ax = 0.0f;
            s.ay = 0.0f;
            s.az = 9.81f;      // stationary in the vertical, i.e. level
            s.gyro_yaw = 0.0f; // driving straight
            s.timestamp_s = 0.01 * i;
            if (auto decimated = decimator.Push(s)) {
                ekf.Predict(decimated->gyro_yaw, decimated->timestamp_s);
                ++predicts;
            }
        }
        Check(predicts == 5, "5 EKF prediction steps from 50 raw samples");

        const DrFix fix = ekf.Current();
        // 50 samples at 100 Hz is 0.5 s; at 20 m/s that is 10 m due north.
        const double north_m = HaversineM(kStartLat, kStartLon, fix.latitude_deg, kStartLon);
        const double east_m = HaversineM(kStartLat, kStartLon, kStartLat, fix.longitude_deg);
        CheckNear(north_m, 10.0, 0.05, "travelled 10.0 m north in 0.5 s at 20 m/s");
        CheckNear(east_m, 0.0, 0.05, "no eastward drift on a due-north heading");
        Check(fix.latitude_deg > kStartLat, "latitude increased (north is +lat)");
        CheckNear(fix.heading_deg, 0.0, 1e-6, "heading unchanged with zero yaw rate");
        CheckNear(fix.speed_mps, 20.0, 1e-9, "speed held by the process model");
        Check(fix.covariance_m2 > 0.0, "covariance is populated (schema requires it)");
        std::printf("       fix: %.6f, %.6f  heading %.1f deg  %.1f m/s  var %.1f m^2\n",
                    fix.latitude_deg, fix.longitude_deg, fix.heading_deg,
                    fix.speed_mps, fix.covariance_m2);
    }

    // --------------------------------------------------------- heading sign
    Section("compass convention: heading 90 deg must go EAST, not north");
    {
        DeadReckoningEkf ekf;
        ekf.Reset(kStartLat, kStartLon, 90.0, 10.0, 0.0);
        ekf.Predict(0.0, 1.0);
        const DrFix fix = ekf.Current();
        Check(fix.longitude_deg > kStartLon, "longitude increased on a due-east heading");
        CheckNear(HaversineM(kStartLat, kStartLon, kStartLat, fix.longitude_deg), 10.0, 0.05,
                  "10 m east after 1 s at 10 m/s");
        CheckNear(std::abs(fix.latitude_deg - kStartLat) * 111000.0, 0.0, 0.05,
                  "no northward component");
    }

    // ------------------------------------------------------------- turning
    Section("gyro yaw rate integrates into heading");
    {
        DeadReckoningEkf ekf;
        ekf.Reset(kStartLat, kStartLon, 0.0, 5.0, 0.0);
        // 0.1 rad/s for 10 s = 1 rad = 57.2958 deg.
        for (int i = 1; i <= 100; ++i) ekf.Predict(0.1, 0.1 * i);
        CheckNear(ekf.Current().heading_deg, 57.2958, 0.5, "heading after 1 rad of yaw");
    }

    // ----------------------------------------------------- weak speed update
    Section("TFLite speed is a WEAK measurement (Q3 decision)");
    {
        DeadReckoningEkf ekf;
        ekf.Reset(kStartLat, kStartLon, 0.0, 20.0, 0.0);
        ekf.Predict(0.0, 1.0);
        const double before = ekf.Current().speed_mps;
        // The model claims the truck has stopped. With R = RMSE^2 = 27.7 the
        // filter must move a little, not capitulate.
        ekf.UpdateSpeed(0.0);
        const double after = ekf.Current().speed_mps;
        Check(after < before, "a slower measurement lowers the estimate");
        Check(after > before * 0.5,
              "but does not collapse to it -- large R keeps the process model in charge");
        std::printf("       speed %.2f -> %.2f m/s after a 0.0 m/s measurement\n",
                    before, after);

        ekf.UpdateSpeed(-5.0);
        Check(ekf.Current().speed_mps >= 0.0, "speed can never go negative");
        ekf.UpdateSpeed(std::nan(""));
        Check(std::isfinite(ekf.Current().speed_mps), "NaN measurement is ignored, not absorbed");
    }

    // ------------------------------------------------ covariance behaviour
    Section("covariance grows while coasting and shrinks on a map match");
    {
        DeadReckoningEkf ekf;
        ekf.Reset(kStartLat, kStartLon, 0.0, 15.0, 0.0);
        const double at_reset = ekf.PositionVarianceM2();
        for (int i = 1; i <= 60; ++i) ekf.Predict(0.0, static_cast<double>(i));
        const double after_coasting = ekf.PositionVarianceM2();
        Check(after_coasting > at_reset, "uncertainty grows through a 60 s blackout");

        const DrFix drifted = ekf.Current();
        ekf.UpdateMapMatch(drifted.latitude_deg, drifted.longitude_deg, 0.0);
        const double after_match = ekf.PositionVarianceM2();
        Check(after_match < after_coasting, "map matching bounds the drift");
        Check(ekf.Current().map_matched, "the fix is flagged map_matched");
        std::printf("       variance %.1f -> %.1f -> %.1f m^2 (reset, 60 s coast, matched)\n",
                    at_reset, after_coasting, after_match);
    }

    // --------------------------------------------- heading 180 deg ambiguity
    Section("a road bearing must not spin the truck around");
    {
        DeadReckoningEkf ekf;
        // Driving south (180 deg) on a road whose stored bearing is north.
        ekf.Reset(kStartLat, kStartLon, 180.0, 10.0, 0.0);
        ekf.Predict(0.0, 1.0);
        const DrFix here = ekf.Current();
        ekf.UpdateMapMatch(here.latitude_deg, here.longitude_deg, 0.0);
        const double heading = ekf.Current().heading_deg;
        Check(heading > 90.0 && heading < 270.0,
              "kept driving south despite a northward road bearing");
        std::printf("       heading stayed %.1f deg\n", heading);
    }

    // ------------------------------------------------------- map matching
    Section("map matching against the real R*Tree extract");
    {
        const std::string path = (argc > 1)
            ? argv[1]
            : std::string("../../../data/artifacts/edge/road_graph.sqlite");

        MapMatcher matcher;
        if (!matcher.Open(path)) {
            std::printf("  SKIP no extract at %s (%s)\n", path.c_str(), matcher.Error().c_str());
            std::printf("       build it: python scripts/build_mobile_extract.py\n");
        } else {
            Check(matcher.IsOpen(), "opened road_graph.sqlite read-only");

            const std::size_t candidates = matcher.CandidateCount(kStartLat, kStartLon, 200.0);
            Check(candidates > 0, "R*Tree returned candidates for a 200 m window");
            std::printf("       %zu candidate edges within 200 m of Guwahati\n", candidates);

            MapMatch match;
            const MatchStatus status = matcher.Match(kStartLat, kStartLon, 100.0, &match);
            Check(status == MatchStatus::kOk, "snapped to a road");
            if (status == MatchStatus::kOk) {
                Check(match.edge_id > 0, "match carries a real edge id");
                Check(match.distance_m >= 0.0 && match.distance_m <= 100.0,
                      "snap distance is within the limit");
                Check(match.bearing_deg >= 0.0 && match.bearing_deg < 360.0,
                      "bearing is a valid compass angle");
                Check(match.latitude_deg > 25.0 && match.latitude_deg < 30.0,
                      "snapped latitude is inside the NER extract");
                Check(match.longitude_deg > 87.0 && match.longitude_deg < 98.0,
                      "snapped longitude is inside the NER extract");
                std::printf("       edge %lld \"%s\" at %.2f m, bearing %.1f deg\n",
                            static_cast<long long>(match.edge_id),
                            match.name.empty() ? "(unnamed)" : match.name.c_str(),
                            match.distance_m, match.bearing_deg);
            }

            // Middle of the Bay of Bengal: no road, and the matcher must say
            // so rather than snapping to something hundreds of km away.
            MapMatch nowhere;
            const MatchStatus far = matcher.Match(15.0, 88.0, 100.0, &nowhere);
            Check(far != MatchStatus::kOk, "a point in the ocean does not match a road");
            std::printf("       ocean query -> %s\n", ToString(far));

            // Repeated queries: proves the prepared statement is reset
            // correctly and nothing leaks or faults across calls.
            bool all_ok = true;
            for (int i = 0; i < 200; ++i) {
                MapMatch m;
                const double lat = kStartLat + 0.0001 * i;
                if (matcher.Match(lat, kStartLon, 200.0, &m) == MatchStatus::kQueryFailed) {
                    all_ok = false;
                    break;
                }
            }
            Check(all_ok, "200 consecutive matches without a query failure or fault");
        }
    }

    // ------------------------------------------------------ full blackout
    Section("end to end: a 60 s blackout with map matching");
    {
        const std::string path = (argc > 1)
            ? argv[1]
            : std::string("../../../data/artifacts/edge/road_graph.sqlite");
        MapMatcher matcher;
        DeadReckoningEkf ekf;
        ekf.Reset(kStartLat, kStartLon, 45.0, 12.0, 0.0);

        const bool have_graph = matcher.Open(path);
        ImuDecimator decimator(100, kModelRateHz);
        double t = 0.0;
        int matched = 0;

        // Cadence is counted in DECIMATED samples, not raw ones. Keying it to
        // the raw index is how the first version of this test silently made
        // zero map matches: the decimator emits on raw steps 9, 19, 29 ...,
        // so `step % 1000 == 0` never once coincided with an emission.
        int decimated_count = 0;
        for (int step = 0; step < 6000; ++step) {   // 60 s at 100 Hz
            t += 0.01;
            ImuSample s{};
            s.ax = 0.05f;
            s.az = 9.81f;
            s.gyro_yaw = 0.002f;       // a gentle drift, as a real gyro has
            s.timestamp_s = t;
            if (auto d = decimator.Push(s)) {
                ekf.Predict(d->gyro_yaw, d->timestamp_s);
                ++decimated_count;
                // The model produces one speed per 50-step window at 10 Hz.
                if (decimated_count % 50 == 0) ekf.UpdateSpeed(12.0);
                // Map matching every 5 s of blackout.
                if (have_graph && decimated_count % 50 == 0) {
                    const DrFix f = ekf.Current();
                    MapMatch m;
                    if (matcher.Match(f.latitude_deg, f.longitude_deg, 60.0, &m)
                            == MatchStatus::kOk) {
                        ekf.UpdateMapMatch(m.latitude_deg, m.longitude_deg, m.bearing_deg);
                        ++matched;
                    }
                }
            }
        }

        const DrFix fix = ekf.Current();
        const double travelled = HaversineM(kStartLat, kStartLon,
                                            fix.latitude_deg, fix.longitude_deg);
        Check(std::isfinite(fix.latitude_deg) && std::isfinite(fix.longitude_deg),
              "position stayed finite through 6000 samples");
        Check(travelled > 100.0, "the truck actually moved");
        Check(travelled < 2000.0, "and did not teleport (12 m/s x 60 s is ~720 m)");
        Check(fix.covariance_m2 > 0.0 && fix.covariance_m2 < 1e6,
              "covariance stayed bounded and positive");
        Check(matched > 0, "map matching actually engaged during the blackout");
        // The whole point of map matching: unaided, 60 s of dead reckoning
        // leaves a position variance in the hundreds of thousands of m^2.
        Check(fix.covariance_m2 < 50000.0,
              "map matching kept the uncertainty far below an unaided coast");
        std::printf("       %.0f m travelled, %d map matches, final var %.1f m^2\n",
                    travelled, matched, fix.covariance_m2);
    }

    // ------------------------------------------------------------- C API
    Section("the flat C API the JNI / Objective-C++ shims bind to");
    {
        const std::string path = (argc > 1)
            ? argv[1]
            : std::string("../../../data/artifacts/edge/road_graph.sqlite");

        DrishtiEdgeEngine* engine = DrishtiEdge_Create(path.c_str(), nullptr);
        Check(engine != nullptr, "engine created");

        DrishtiEdgeFix fix{};
        DrishtiEdge_GetFix(engine, &fix);
        Check(!fix.valid, "fix is invalid before Reset()");

        DrishtiEdge_Reset(engine, kStartLat, kStartLon, 0.0, 20.0, 0.0);

        int advanced = 0;
        for (int i = 1; i <= 50; ++i) {
            if (DrishtiEdge_PushImu(engine, 0.0f, 0.0f, 9.81f, 0.0f, 0.0f, 0.0f,
                                    0.01 * i)) {
                ++advanced;
            }
        }
        Check(advanced == 5, "50 raw samples advanced the filter 5 times");

        DrishtiEdge_GetFix(engine, &fix);
        Check(fix.valid, "fix is valid after 50 samples");
        CheckNear(HaversineM(kStartLat, kStartLon, fix.latitude, kStartLon), 10.0, 0.05,
                  "C API produced the same 10 m as the C++ path");
        Check(fix.covariance_m2 > 0.0, "covariance crosses the C boundary");

        if (DrishtiEdge_HasGraph(engine)) {
            const bool snapped = DrishtiEdge_MapMatch(engine, 100.0);
            Check(snapped, "map matched through the C API");
            DrishtiEdge_GetFix(engine, &fix);
            if (snapped) {
                Check(fix.map_matched, "fix reports map_matched");
                Check(fix.matched_edge_id > 0, "matched edge id is carried out");
            }
        }

        // Every entry point must tolerate a null handle: a JNI call after the
        // module is torn down is a real sequence, not a hypothetical one.
        DrishtiEdge_Reset(nullptr, 0, 0, 0, 0, 0);
        DrishtiEdge_UpdateSpeed(nullptr, 1.0);
        DrishtiEdge_GetFix(nullptr, &fix);
        Check(!DrishtiEdge_PushImu(nullptr, 0, 0, 0, 0, 0, 0, 0), "null handle rejected");
        Check(!DrishtiEdge_MapMatch(nullptr, 50.0), "null handle rejected by MapMatch");
        Check(std::string(DrishtiEdge_LastError(nullptr)).empty(),
              "LastError never returns NULL");

        DrishtiEdge_Destroy(engine);
        DrishtiEdge_Destroy(nullptr);   // must not fault
        Check(true, "destroyed cleanly, including a null handle");
    }

    std::printf("\n%d checks, %d failures\n", g_checks, g_failures);
    if (g_failures == 0) std::printf("all checks passed\n");
    return g_failures == 0 ? 0 : 1;
}
