// Geo.h — local tangent-plane conversion for the dead-reckoning engine.
//
// The EKF works in METRES on a local plane, not in degrees. Running a Kalman
// filter directly on lat/lon would make the state's units inconsistent (a
// degree of longitude is 100 km at the equator and 0 at the pole), so the
// covariance would mean different things along each axis.
//
// The plane is pinned to the last known GPS fix, which is by definition where
// the blackout began, so the truck is never far from the origin while dead
// reckoning is running. Over the tens of kilometres that covers, the flat
// approximation costs far less than the 240 m/minute the speed model already
// contributes.
//
// EARTH_RADIUS_M matches drishti_ai/geo.py exactly. The device and the server
// must agree on what a metre is, or a map-matched point that looks correct on
// the phone lands somewhere else on the dispatcher's map.

#pragma once

#include <cmath>

namespace drishti {

inline constexpr double kEarthRadiusM = 6371008.8;  // IUGG mean radius

inline constexpr double kDegToRad = 3.14159265358979323846 / 180.0;
inline constexpr double kRadToDeg = 180.0 / 3.14159265358979323846;

/// Origin of the local East-North plane: the last trusted GPS fix.
struct GeoOrigin {
    double latitude_deg = 0.0;
    double longitude_deg = 0.0;
    // cos(latitude) is cached: it is needed on every single conversion, and
    // this runs inside the navigation loop.
    double cos_latitude = 1.0;

    GeoOrigin() = default;
    GeoOrigin(double lat_deg, double lon_deg)
        : latitude_deg(lat_deg),
          longitude_deg(lon_deg),
          cos_latitude(std::cos(lat_deg * kDegToRad)) {}
};

struct LocalPoint {
    double east_m = 0.0;
    double north_m = 0.0;
};

struct GeoPoint {
    double latitude_deg = 0.0;
    double longitude_deg = 0.0;
};

inline LocalPoint ToLocal(const GeoOrigin& origin, double lat_deg, double lon_deg) noexcept {
    const double d_lat = (lat_deg - origin.latitude_deg) * kDegToRad;
    const double d_lon = (lon_deg - origin.longitude_deg) * kDegToRad;
    return LocalPoint{d_lon * kEarthRadiusM * origin.cos_latitude,
                      d_lat * kEarthRadiusM};
}

inline GeoPoint ToGeo(const GeoOrigin& origin, double east_m, double north_m) noexcept {
    const double lat = origin.latitude_deg + (north_m / kEarthRadiusM) * kRadToDeg;
    // Guard the pole: cos(latitude) -> 0 would divide by zero. Nothing in NER
    // comes close, but a filter that divides by zero somewhere on Earth is a
    // filter that will eventually do it.
    const double cos_lat = (std::abs(origin.cos_latitude) < 1e-12) ? 1e-12 : origin.cos_latitude;
    const double lon = origin.longitude_deg +
                       (east_m / (kEarthRadiusM * cos_lat)) * kRadToDeg;
    return GeoPoint{lat, lon};
}

/// Great-circle distance in metres. Used for reporting, never inside the filter.
inline double HaversineM(double lat1, double lon1, double lat2, double lon2) noexcept {
    const double p1 = lat1 * kDegToRad;
    const double p2 = lat2 * kDegToRad;
    const double dp = (lat2 - lat1) * kDegToRad;
    const double dl = (lon2 - lon1) * kDegToRad;
    const double a = std::sin(dp / 2) * std::sin(dp / 2) +
                     std::cos(p1) * std::cos(p2) * std::sin(dl / 2) * std::sin(dl / 2);
    return 2.0 * kEarthRadiusM * std::asin(std::sqrt(a < 0.0 ? 0.0 : (a > 1.0 ? 1.0 : a)));
}

/// Wrap to (-pi, pi]. Every heading arithmetic result must go through this:
/// an unwrapped innovation of 359 degrees is really -1, and feeding the raw
/// value to the filter swings the heading the wrong way around the circle.
inline double WrapAngle(double radians) noexcept {
    constexpr double kPi = 3.14159265358979323846;
    constexpr double kTwoPi = 2.0 * kPi;
    radians = std::fmod(radians + kPi, kTwoPi);
    if (radians < 0.0) radians += kTwoPi;
    return radians - kPi;
}

}  // namespace drishti
