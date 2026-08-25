// MapMatcher.cpp — R*Tree lookup, WKB decode, and point-to-segment projection.

#include "MapMatcher.h"

#include <sqlite3.h>

#include <cmath>
#include <cstring>
#include <limits>

#include "Geo.h"

namespace drishti {

namespace {

constexpr std::uint32_t kWkbLineString = 2;

/// Decode a little-endian WKB LineString into a flat [x0,y0,x1,y1,...] buffer.
///
/// Hand-rolled rather than linked against GEOS: the app already ships 104 MB
/// of graph, and pulling in a geometry library to read one well-known
/// fixed-layout structure is not worth the binary size or the build surface.
/// Every length is checked against the blob -- a truncated BLOB must return
/// false, not read past the end.
bool DecodeLineString(const unsigned char* blob, std::size_t size,
                      std::vector<double>* out) {
    if (blob == nullptr || size < 9) return false;

    const unsigned char order = blob[0];
    // The extract is written by PostGIS on a little-endian host and read on
    // ARM, also little-endian. Big-endian WKB is rejected rather than
    // byte-swapped: silently mis-reading coordinates would put the truck in
    // the wrong hemisphere, and this has never been produced.
    if (order != 1) return false;

    std::uint32_t type = 0;
    std::memcpy(&type, blob + 1, 4);
    // Mask the SRID and Z/M flags PostGIS may set in the high bits.
    if ((type & 0xFFU) != kWkbLineString) return false;

    std::uint32_t n_points = 0;
    std::memcpy(&n_points, blob + 5, 4);
    if (n_points < 2) return false;

    const std::size_t needed = 9 + static_cast<std::size_t>(n_points) * 16;
    if (size < needed) return false;

    out->resize(static_cast<std::size_t>(n_points) * 2);
    std::memcpy(out->data(), blob + 9, static_cast<std::size_t>(n_points) * 16);
    return true;
}

/// Squared distance from p to segment ab, plus the closest point, in metres.
struct Projection {
    double distance_sq = 0.0;
    double east_m = 0.0;
    double north_m = 0.0;
    double bearing_rad = 0.0;
};

Projection ProjectOntoSegment(double px, double py,
                              double ax, double ay,
                              double bx, double by) noexcept {
    const double abx = bx - ax;
    const double aby = by - ay;
    const double len_sq = abx * abx + aby * aby;

    double t = 0.0;
    if (len_sq > 0.0) {
        t = ((px - ax) * abx + (py - ay) * aby) / len_sq;
        // Clamped, so a point beyond either end snaps to the endpoint rather
        // than to the infinite line -- which would place the truck off the
        // end of the road.
        if (t < 0.0) t = 0.0;
        if (t > 1.0) t = 1.0;
    }

    Projection result;
    result.east_m = ax + t * abx;
    result.north_m = ay + t * aby;
    const double dx = px - result.east_m;
    const double dy = py - result.north_m;
    result.distance_sq = dx * dx + dy * dy;
    // Compass bearing: atan2(east, north), not the usual atan2(y, x).
    result.bearing_rad = std::atan2(abx, aby);
    return result;
}

}  // namespace

const char* ToString(MatchStatus status) noexcept {
    switch (status) {
        case MatchStatus::kOk:          return "ok";
        case MatchStatus::kNotOpen:     return "matcher not open";
        case MatchStatus::kNoCandidate: return "no edge in the search window";
        case MatchStatus::kTooFar:      return "nearest edge is beyond the limit";
        case MatchStatus::kQueryFailed: return "sqlite query failed";
    }
    return "unknown";
}

MapMatcher::MapMatcher() = default;
MapMatcher::~MapMatcher() { Close(); }

bool MapMatcher::Open(const std::string& sqlite_path) {
    Close();
    error_.clear();

    // READONLY: the shipped graph must not be corruptible by the app, and a
    // read-only handle lets sqlite skip journalling entirely.
    int rc = sqlite3_open_v2(sqlite_path.c_str(), &db_, SQLITE_OPEN_READONLY, nullptr);
    if (rc != SQLITE_OK) {
        error_ = std::string("cannot open ") + sqlite_path + ": " +
                 (db_ ? sqlite3_errmsg(db_) : sqlite3_errstr(rc));
        Close();
        return false;
    }

    // Joining the R*Tree to the payload table in ONE prepared statement, so a
    // match is a single round trip through sqlite rather than one query for
    // candidate ids and N more for their geometry.
    static const char* kSql =
        "SELECT e.id, e.geom, e.name, e.is_bridge "
        "FROM road_edges_rtree r JOIN road_edges e ON e.id = r.id "
        "WHERE r.max_lon >= ?1 AND r.min_lon <= ?2 "
        "  AND r.max_lat >= ?3 AND r.min_lat <= ?4";
    rc = sqlite3_prepare_v2(db_, kSql, -1, &query_, nullptr);
    if (rc != SQLITE_OK) {
        error_ = std::string("prepare failed: ") + sqlite3_errmsg(db_);
        Close();
        return false;
    }
    return true;
}

void MapMatcher::Close() noexcept {
    if (query_ != nullptr) {
        sqlite3_finalize(query_);
        query_ = nullptr;
    }
    if (db_ != nullptr) {
        sqlite3_close(db_);
        db_ = nullptr;
    }
}

std::size_t MapMatcher::CandidateCount(double latitude_deg, double longitude_deg,
                                       double radius_m) noexcept {
    if (db_ == nullptr || query_ == nullptr) return 0;

    const double d_lat = (radius_m / kEarthRadiusM) * kRadToDeg;
    const double cos_lat = std::max(1e-12, std::abs(std::cos(latitude_deg * kDegToRad)));
    const double d_lon = (radius_m / (kEarthRadiusM * cos_lat)) * kRadToDeg;

    sqlite3_reset(query_);
    sqlite3_bind_double(query_, 1, longitude_deg - d_lon);
    sqlite3_bind_double(query_, 2, longitude_deg + d_lon);
    sqlite3_bind_double(query_, 3, latitude_deg - d_lat);
    sqlite3_bind_double(query_, 4, latitude_deg + d_lat);

    std::size_t count = 0;
    while (sqlite3_step(query_) == SQLITE_ROW) ++count;
    sqlite3_reset(query_);
    return count;
}

MatchStatus MapMatcher::Match(double latitude_deg, double longitude_deg,
                              double max_distance_m, MapMatch* out,
                              double search_radius_m) noexcept {
    if (out == nullptr) return MatchStatus::kQueryFailed;
    if (db_ == nullptr || query_ == nullptr) return MatchStatus::kNotOpen;
    if (!std::isfinite(latitude_deg) || !std::isfinite(longitude_deg)) {
        return MatchStatus::kQueryFailed;
    }

    // The window is a degree box around the point; the acceptance test below
    // is in metres. Keeping them separate is what stops a wide search from
    // silently becoming a loose match.
    const double d_lat = (search_radius_m / kEarthRadiusM) * kRadToDeg;
    const double cos_lat = std::max(1e-12, std::abs(std::cos(latitude_deg * kDegToRad)));
    const double d_lon = (search_radius_m / (kEarthRadiusM * cos_lat)) * kRadToDeg;

    sqlite3_reset(query_);
    sqlite3_bind_double(query_, 1, longitude_deg - d_lon);
    sqlite3_bind_double(query_, 2, longitude_deg + d_lon);
    sqlite3_bind_double(query_, 3, latitude_deg - d_lat);
    sqlite3_bind_double(query_, 4, latitude_deg + d_lat);

    // Distances are compared on a local plane pinned to the query point, so
    // "nearest" is measured in metres and not in degrees -- a degree of
    // longitude is 10% shorter than a degree of latitude at these latitudes,
    // and comparing raw degrees would bias every match north-south.
    const GeoOrigin origin(latitude_deg, longitude_deg);

    double best_distance_sq = std::numeric_limits<double>::infinity();
    bool found_any = false;
    MapMatch best;

    int rc = SQLITE_OK;
    while ((rc = sqlite3_step(query_)) == SQLITE_ROW) {
        found_any = true;
        const auto* blob = static_cast<const unsigned char*>(sqlite3_column_blob(query_, 1));
        const int blob_size = sqlite3_column_bytes(query_, 1);
        if (blob_size <= 0) continue;
        if (!DecodeLineString(blob, static_cast<std::size_t>(blob_size), &coords_)) continue;

        const std::size_t n_points = coords_.size() / 2;
        for (std::size_t i = 0; i + 1 < n_points; ++i) {
            const LocalPoint a = ToLocal(origin, coords_[i * 2 + 1], coords_[i * 2]);
            const LocalPoint b = ToLocal(origin, coords_[(i + 1) * 2 + 1], coords_[(i + 1) * 2]);
            const Projection p = ProjectOntoSegment(0.0, 0.0, a.east_m, a.north_m,
                                                    b.east_m, b.north_m);
            if (p.distance_sq >= best_distance_sq) continue;

            best_distance_sq = p.distance_sq;
            best.edge_id = sqlite3_column_int64(query_, 0);
            const GeoPoint snapped = ToGeo(origin, p.east_m, p.north_m);
            best.latitude_deg = snapped.latitude_deg;
            best.longitude_deg = snapped.longitude_deg;
            double bearing = p.bearing_rad * kRadToDeg;
            if (bearing < 0.0) bearing += 360.0;
            best.bearing_deg = bearing;
            const auto* name = sqlite3_column_text(query_, 2);
            best.name = (name != nullptr)
                ? std::string(reinterpret_cast<const char*>(name)) : std::string();
            best.is_bridge = sqlite3_column_int(query_, 3) != 0;
        }
    }
    const bool query_ok = (rc == SQLITE_DONE);
    sqlite3_reset(query_);

    if (!query_ok) {
        error_ = std::string("step failed: ") + sqlite3_errmsg(db_);
        return MatchStatus::kQueryFailed;
    }
    if (!found_any || !std::isfinite(best_distance_sq)) return MatchStatus::kNoCandidate;

    best.distance_m = std::sqrt(best_distance_sq);
    if (best.distance_m > max_distance_m) {
        // Reported anyway so a caller can log how far off it was, but the
        // status says do not use it. A silent snap to a road 300 m away puts
        // the truck in a different valley.
        *out = best;
        return MatchStatus::kTooFar;
    }

    *out = best;
    return MatchStatus::kOk;
}

}  // namespace drishti
