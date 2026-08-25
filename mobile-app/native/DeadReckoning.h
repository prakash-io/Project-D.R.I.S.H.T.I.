// DeadReckoning.h — the ISRO IDR core (MOB-04, MOB-06).
//
// An Extended Kalman Filter that keeps a truck positioned through a GNSS
// blackout in a NER valley, using only the phone's IMU and the TFLite forward
// speed model, corrected by map-matching against the offline road graph.
//
// State, in the local East-North plane pinned to the last GPS fix:
//
//     x = [ east_m, north_m, heading_rad, speed_mps ]
//
// heading is measured clockwise from North, the compass convention, so the
// velocity components are (v sin h, v cos h) and NOT (v cos h, v sin h).
// Getting that backwards produces a track that is a perfect mirror of the
// truth, which looks plausible on a map right up until it does not.
//
// What corrects what:
//
//   gyro yaw rate   -> control input on heading (integrated, drifts)
//   TFLite speed    -> measurement on speed, with a LARGE variance
//   map-matching    -> measurement on position, and on heading via the road's
//                      own bearing
//
// The large speed variance is the approved treatment of the speed model as a
// weak secondary measurement (REVISION.md Q3): at 4.0 m/s MAE it integrates to
// roughly 240 m of along-track error per minute, so the filter must not trust
// it. Map-matching is what actually bounds the error, which is why the
// engine refuses to run without a matcher unless explicitly told to.

#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>

#include "Geo.h"
#include "IMU_Constants.h"

namespace drishti {

/// One raw IMU sample as the handset reports it, SI units, device frame.
struct ImuSample {
    float ax = 0.0f;          // m/s^2
    float ay = 0.0f;
    float az = 0.0f;
    float gyro_yaw = 0.0f;    // rad/s, about the vertical axis
    float gyro_pitch = 0.0f;
    float gyro_roll = 0.0f;
    double timestamp_s = 0.0; // monotonic seconds
};

/// A dead-reckoned position estimate.
struct DrFix {
    double latitude_deg = 0.0;
    double longitude_deg = 0.0;
    double heading_deg = 0.0;
    double speed_mps = 0.0;
    /// Position variance in m^2 -- the trace of the position block. The
    /// dashboard draws its uncertainty halo from this, and the schema
    /// REQUIRES it on every 'ekf' row, so it is never optional.
    double covariance_m2 = 0.0;
    bool map_matched = false;
    double timestamp_s = 0.0;
};

/**
 * Decimates the handset's 100 Hz IMU stream to the 10 Hz the model expects.
 *
 * This is not an optimisation, it is a correctness requirement. The IO-VNBD
 * data the model was trained on is 10 Hz (REVISION.md R6), so a 50-step window
 * is 5 seconds. Feeding 100 Hz samples straight in makes every window cover
 * 0.5 s, and the model sees a distribution it has never encountered -- it will
 * still return a confident number.
 *
 * Averaging rather than dropping 9 in 10: an accelerometer at 100 Hz carries
 * engine and road vibration well above 5 Hz, and taking every tenth sample
 * aliases that straight into the band the model reads. The mean over each
 * block is a crude anti-alias filter, and it is what a 10 Hz logger
 * approximates anyway.
 */
class ImuDecimator {
public:
    explicit ImuDecimator(int input_rate_hz = 100, int output_rate_hz = kModelRateHz);

    /// Feed one raw sample. Returns a decimated sample once a block is full.
    std::optional<ImuSample> Push(const ImuSample& sample) noexcept;

    void Reset() noexcept;

    int Factor() const noexcept { return factor_; }

private:
    int factor_ = 10;
    int count_ = 0;
    double sum_ax_ = 0.0, sum_ay_ = 0.0, sum_az_ = 0.0;
    double sum_gy_ = 0.0, sum_gp_ = 0.0, sum_gr_ = 0.0;
    double last_timestamp_s_ = 0.0;
};

/// Tuning. Defaults are derived from the model's own held-out error and from
/// consumer MEMS gyro noise, not chosen to make a demo look good.
struct EkfConfig {
    /// (m/s)^2. From the speed model's held-out RMSE -- see IMU_Constants.h.
    double speed_measurement_variance = kSpeedMeasurementVariance;

    /// (m/s)^2 of the speed seeded at Reset(), which comes from the last GNSS
    /// fix and is good to well under 1 m/s. MUST stay far below
    /// speed_measurement_variance: if the prior is as weak as the model, the
    /// Kalman gain approaches 0.5 and the first model reading drags the
    /// estimate halfway to itself, which is not a weak measurement at all.
    double initial_speed_variance = 1.0;

    /// (rad/s)^2 of gyro noise, integrated into heading each step. The IO-VNBD
    /// yaw channel's own variance, which is what the model was normalised by.
    double gyro_noise_variance = kFeatureVariance[3];

    /// (m/s^2)^2 driving the speed random walk. A truck's acceleration is
    /// bounded; this says the filter expects speed to change by about
    /// 0.5 m/s^2 between updates.
    double speed_process_noise = 0.25;

    /// Position process noise (m^2 per second) beyond what the motion model
    /// explains -- wheel slip, pitch, an IMU that is not quite level.
    double position_process_noise = 0.5;

    /// (m)^2 for a map-matched position. A single carriageway is ~7 m wide, so
    /// a snapped point is good to a few metres ACROSS the road. It says
    /// nothing about position ALONG the road, which is exactly where dead
    /// reckoning drifts -- and why this is applied as a cross-track
    /// correction rather than a full position fix.
    double map_match_variance = 12.0;

    /// (rad)^2 for a heading taken from the matched road's bearing.
    double map_heading_variance = 0.05;

    /// Beyond this, a candidate road is not where the truck is; snapping to it
    /// would teleport the estimate onto an unrelated road.
    double map_match_max_distance_m = 60.0;
};

/**
 * The filter itself.
 *
 * Not thread-safe by design: own it from the single sensor thread. An internal
 * mutex would hide contention rather than remove it.
 */
class DeadReckoningEkf {
public:
    explicit DeadReckoningEkf(EkfConfig config = {});
    ~DeadReckoningEkf();

    DeadReckoningEkf(const DeadReckoningEkf&) = delete;
    DeadReckoningEkf& operator=(const DeadReckoningEkf&) = delete;

    /// Seed from the last trusted GPS fix. Must be called before Predict().
    void Reset(double latitude_deg, double longitude_deg, double heading_deg,
               double speed_mps, double timestamp_s) noexcept;

    bool Initialised() const noexcept;

    /// Propagate to `timestamp_s` using the measured yaw rate.
    void Predict(double gyro_yaw_rate, double timestamp_s) noexcept;

    /// Fold in a speed from the TFLite model. Weak by construction.
    void UpdateSpeed(double speed_mps) noexcept;

    /// Fold in a map-matched position and the matched road's bearing.
    void UpdateMapMatch(double latitude_deg, double longitude_deg,
                        std::optional<double> road_bearing_deg) noexcept;

    DrFix Current() const noexcept;

    /// Trace of the position covariance block, m^2.
    double PositionVarianceM2() const noexcept;

private:
    struct Impl;
    // Eigen types need their alignment respected; keeping them behind a
    // pointer keeps this header free of the Eigen include, so the React
    // Native bridge does not need Eigen on its include path.
    Impl* impl_;
};

}  // namespace drishti
