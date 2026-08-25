// DeadReckoning.cpp — EKF implementation (MOB-04).

#include "DeadReckoning.h"

#include <Eigen/Dense>

#include <algorithm>
#include <cmath>

namespace drishti {

namespace {
constexpr double kPi = 3.14159265358979323846;

// A ground vehicle. Used to keep the state physically possible after an
// update, because a Kalman update is a linear correction and can push speed
// negative on a bad measurement.
constexpr double kMaxSpeedMps = 60.0;
}  // namespace

// ---------------------------------------------------------------- decimator

ImuDecimator::ImuDecimator(int input_rate_hz, int output_rate_hz) {
    if (input_rate_hz <= 0 || output_rate_hz <= 0) {
        factor_ = 1;
    } else {
        factor_ = std::max(1, input_rate_hz / output_rate_hz);
    }
}

void ImuDecimator::Reset() noexcept {
    count_ = 0;
    sum_ax_ = sum_ay_ = sum_az_ = 0.0;
    sum_gy_ = sum_gp_ = sum_gr_ = 0.0;
    last_timestamp_s_ = 0.0;
}

std::optional<ImuSample> ImuDecimator::Push(const ImuSample& sample) noexcept {
    sum_ax_ += sample.ax;
    sum_ay_ += sample.ay;
    sum_az_ += sample.az;
    sum_gy_ += sample.gyro_yaw;
    sum_gp_ += sample.gyro_pitch;
    sum_gr_ += sample.gyro_roll;
    last_timestamp_s_ = sample.timestamp_s;
    ++count_;

    if (count_ < factor_) return std::nullopt;

    const double n = static_cast<double>(count_);
    ImuSample out;
    out.ax = static_cast<float>(sum_ax_ / n);
    out.ay = static_cast<float>(sum_ay_ / n);
    out.az = static_cast<float>(sum_az_ / n);
    out.gyro_yaw = static_cast<float>(sum_gy_ / n);
    out.gyro_pitch = static_cast<float>(sum_gp_ / n);
    out.gyro_roll = static_cast<float>(sum_gr_ / n);
    // The block's LAST timestamp, not its mean: the decimated sample
    // represents the state at the end of the block, and dt is computed from
    // consecutive timestamps.
    out.timestamp_s = last_timestamp_s_;

    Reset();
    return out;
}

// ---------------------------------------------------------------------- EKF

struct DeadReckoningEkf::Impl {
    EkfConfig config;
    GeoOrigin origin;
    bool initialised = false;
    double last_timestamp_s = 0.0;
    bool last_was_map_matched = false;

    // [east, north, heading, speed]
    Eigen::Vector4d x = Eigen::Vector4d::Zero();
    Eigen::Matrix4d P = Eigen::Matrix4d::Identity();

    explicit Impl(EkfConfig cfg) : config(cfg) {}
};

DeadReckoningEkf::DeadReckoningEkf(EkfConfig config) : impl_(new Impl(config)) {}
DeadReckoningEkf::~DeadReckoningEkf() { delete impl_; }

bool DeadReckoningEkf::Initialised() const noexcept { return impl_->initialised; }

void DeadReckoningEkf::Reset(double latitude_deg, double longitude_deg,
                             double heading_deg, double speed_mps,
                             double timestamp_s) noexcept {
    impl_->origin = GeoOrigin(latitude_deg, longitude_deg);
    impl_->x << 0.0, 0.0, WrapAngle(heading_deg * kDegToRad), speed_mps;

    // Seeded from a GPS fix, so every element is GPS-quality.
    //
    // P(3,3) deliberately does NOT use speed_measurement_variance. Seeding the
    // speed prior with the MODEL's variance says the seed is exactly as bad as
    // the model, which makes the Kalman gain 0.5 and lets the first TFLite
    // reading drag the estimate halfway to itself -- measured: a 0.0 m/s
    // reading pulled 20 m/s down to 9.96 m/s. That is the opposite of treating
    // the model as a weak secondary measurement (REVISION.md Q3).
    //
    // A GNSS speed is good to well under 1 m/s, so 1.0 m^2 is the honest
    // prior. Against R = 27.7 that gives a gain of ~0.04: the model nudges,
    // it does not overrule. The prior then grows through speed_process_noise
    // as the blackout lengthens, so the model earns influence over time --
    // which is the correct behaviour, not a tuned constant.
    impl_->P.setZero();
    impl_->P(0, 0) = 25.0;    // 5 m, a good urban GPS fix
    impl_->P(1, 1) = 25.0;
    impl_->P(2, 2) = 0.05;    // ~13 degrees of heading
    impl_->P(3, 3) = impl_->config.initial_speed_variance;

    impl_->last_timestamp_s = timestamp_s;
    impl_->initialised = true;
    impl_->last_was_map_matched = false;
}

void DeadReckoningEkf::Predict(double gyro_yaw_rate, double timestamp_s) noexcept {
    if (!impl_->initialised) return;

    double dt = timestamp_s - impl_->last_timestamp_s;
    // A non-monotonic or absurd timestamp must not propagate. Clamping to zero
    // freezes the estimate for that step, which is right: the alternative is a
    // negative dt driving the truck backwards along its own track.
    if (!(dt > 0.0) || dt > 5.0) dt = 0.0;
    impl_->last_timestamp_s = timestamp_s;
    if (dt == 0.0) return;

    Eigen::Vector4d& x = impl_->x;
    const double heading = x(2);
    const double speed = x(3);
    const double sin_h = std::sin(heading);
    const double cos_h = std::cos(heading);

    // Compass convention: heading clockwise from North.
    //   east  += v sin(h) dt
    //   north += v cos(h) dt
    x(0) += speed * sin_h * dt;
    x(1) += speed * cos_h * dt;
    x(2) = WrapAngle(heading + gyro_yaw_rate * dt);
    // speed is a random walk: the IMU cannot observe it directly.

    Eigen::Matrix4d F = Eigen::Matrix4d::Identity();
    F(0, 2) = speed * cos_h * dt;
    F(0, 3) = sin_h * dt;
    F(1, 2) = -speed * sin_h * dt;
    F(1, 3) = cos_h * dt;

    Eigen::Matrix4d Q = Eigen::Matrix4d::Zero();
    Q(0, 0) = impl_->config.position_process_noise * dt;
    Q(1, 1) = impl_->config.position_process_noise * dt;
    // Gyro noise is a rate, so its contribution to heading grows as dt^2.
    Q(2, 2) = impl_->config.gyro_noise_variance * dt * dt;
    Q(3, 3) = impl_->config.speed_process_noise * dt;

    impl_->P = F * impl_->P * F.transpose() + Q;
    impl_->last_was_map_matched = false;
}

void DeadReckoningEkf::UpdateSpeed(double speed_mps) noexcept {
    if (!impl_->initialised) return;
    if (!std::isfinite(speed_mps)) return;

    Eigen::RowVector4d H;
    H << 0.0, 0.0, 0.0, 1.0;

    const double R = impl_->config.speed_measurement_variance;
    const double S = (H * impl_->P * H.transpose())(0, 0) + R;
    if (!(S > 0.0)) return;

    const Eigen::Vector4d K = impl_->P * H.transpose() / S;
    const double innovation = speed_mps - impl_->x(3);
    impl_->x += K * innovation;
    impl_->x(2) = WrapAngle(impl_->x(2));
    // A linear correction can drive speed through zero on a bad measurement.
    // The model itself cannot produce a negative speed, so a negative estimate
    // is the filter overshooting, not evidence the truck reversed.
    impl_->x(3) = std::clamp(impl_->x(3), 0.0, kMaxSpeedMps);

    // Joseph form, not (I - KH)P: it stays symmetric and positive-definite
    // under floating-point error, which the short form does not over the
    // thousands of updates a long blackout produces.
    const Eigen::Matrix4d I = Eigen::Matrix4d::Identity();
    const Eigen::Matrix4d IKH = I - K * H;
    impl_->P = IKH * impl_->P * IKH.transpose() + K * R * K.transpose();
}

void DeadReckoningEkf::UpdateMapMatch(double latitude_deg, double longitude_deg,
                                      std::optional<double> road_bearing_deg) noexcept {
    if (!impl_->initialised) return;
    if (!std::isfinite(latitude_deg) || !std::isfinite(longitude_deg)) return;

    const LocalPoint snapped = ToLocal(impl_->origin, latitude_deg, longitude_deg);

    Eigen::Matrix<double, 2, 4> H = Eigen::Matrix<double, 2, 4>::Zero();
    H(0, 0) = 1.0;
    H(1, 1) = 1.0;

    Eigen::Matrix2d R = Eigen::Matrix2d::Identity() * impl_->config.map_match_variance;
    Eigen::Matrix2d S = H * impl_->P * H.transpose() + R;
    Eigen::Matrix<double, 4, 2> K = impl_->P * H.transpose() * S.inverse();

    Eigen::Vector2d innovation;
    innovation << snapped.east_m - impl_->x(0), snapped.north_m - impl_->x(1);
    impl_->x += K * innovation;
    impl_->x(2) = WrapAngle(impl_->x(2));
    impl_->x(3) = std::clamp(impl_->x(3), 0.0, kMaxSpeedMps);

    const Eigen::Matrix4d I = Eigen::Matrix4d::Identity();
    const Eigen::Matrix4d IKH = I - K * H;
    impl_->P = IKH * impl_->P * IKH.transpose() + K * R * K.transpose();

    if (road_bearing_deg.has_value() && std::isfinite(*road_bearing_deg)) {
        // A road has a bearing but no direction: the truck may be driving
        // either way along it. Pick whichever of the two is nearer the current
        // heading, otherwise every match on a southbound carriageway would
        // spin the estimate 180 degrees.
        const double bearing = WrapAngle(*road_bearing_deg * kDegToRad);
        const double opposite = WrapAngle(bearing + kPi);
        const double to_bearing = std::abs(WrapAngle(bearing - impl_->x(2)));
        const double to_opposite = std::abs(WrapAngle(opposite - impl_->x(2)));
        const double target = (to_bearing <= to_opposite) ? bearing : opposite;

        Eigen::RowVector4d Hh;
        Hh << 0.0, 0.0, 1.0, 0.0;
        const double Rh = impl_->config.map_heading_variance;
        const double Sh = (Hh * impl_->P * Hh.transpose())(0, 0) + Rh;
        if (Sh > 0.0) {
            const Eigen::Vector4d Kh = impl_->P * Hh.transpose() / Sh;
            // Wrapped innovation: 359 degrees of error is really -1.
            impl_->x += Kh * WrapAngle(target - impl_->x(2));
            impl_->x(2) = WrapAngle(impl_->x(2));
            impl_->x(3) = std::clamp(impl_->x(3), 0.0, kMaxSpeedMps);
            const Eigen::Matrix4d IKHh = I - Kh * Hh;
            impl_->P = IKHh * impl_->P * IKHh.transpose() + Kh * Rh * Kh.transpose();
        }
    }

    impl_->last_was_map_matched = true;
}

DrFix DeadReckoningEkf::Current() const noexcept {
    DrFix fix;
    if (!impl_->initialised) return fix;

    const GeoPoint p = ToGeo(impl_->origin, impl_->x(0), impl_->x(1));
    fix.latitude_deg = p.latitude_deg;
    fix.longitude_deg = p.longitude_deg;
    double heading = impl_->x(2) * kRadToDeg;
    if (heading < 0.0) heading += 360.0;
    fix.heading_deg = heading;
    fix.speed_mps = impl_->x(3);
    fix.covariance_m2 = PositionVarianceM2();
    fix.map_matched = impl_->last_was_map_matched;
    fix.timestamp_s = impl_->last_timestamp_s;
    return fix;
}

double DeadReckoningEkf::PositionVarianceM2() const noexcept {
    return impl_->P(0, 0) + impl_->P(1, 1);
}

}  // namespace drishti
