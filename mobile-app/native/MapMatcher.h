// MapMatcher.h — snap a drifted dead-reckoned fix onto the road (MOB-06).
//
// This is what actually bounds the error during a blackout. The speed model
// is 4.0 m/s out on average, which integrates to ~240 m of along-track drift
// per minute (REVISION.md R6/Q3), so the EKF alone walks off the map. The
// road graph is the only external information the phone still has, and a
// truck is on a road.
//
// Reads `road_graph.sqlite`, built by scripts/build_mobile_extract.py:
//
//   road_edges(id, source, target, osm_id, name, highway, is_bridge,
//              length_m, geom BLOB)     -- geom is WKB LineString, EPSG:4326
//   road_edges_rtree(id, min_lon, max_lon, min_lat, max_lat)
//
// SQLite + R*Tree rather than SpatiaLite, because React Native's SQLite
// cannot load mod_spatialite -- and a matcher that fails to initialise is a
// matcher that fails exactly when the truck is in a valley with no network.
// R*Tree is compiled into stock SQLite on both platforms.

#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

struct sqlite3;
struct sqlite3_stmt;

namespace drishti {

/// The result of snapping a point to the road network.
struct MapMatch {
    std::int64_t edge_id = 0;
    double latitude_deg = 0.0;     // the snapped point, on the centreline
    double longitude_deg = 0.0;
    double distance_m = 0.0;       // how far the input was from that point
    double bearing_deg = 0.0;      // of the matched segment, 0 = North
    std::string name;              // road name, for the driver's alert
    bool is_bridge = false;
};

enum class MatchStatus : std::uint8_t {
    kOk = 0,
    kNotOpen,        ///< Match() called before a successful Open()
    kNoCandidate,    ///< the R*Tree window held no edge
    kTooFar,         ///< nearest edge is beyond max_distance_m
    kQueryFailed,    ///< sqlite returned an error
};

const char* ToString(MatchStatus status) noexcept;

/**
 * Read-only map matcher over the offline extract.
 *
 * Opened SQLITE_OPEN_READONLY: the app must never be able to corrupt the
 * shipped graph, and a read-only handle also lets sqlite skip journalling.
 *
 * Not thread-safe -- one instance per thread, as with the rest of the engine.
 */
class MapMatcher {
public:
    MapMatcher();
    ~MapMatcher();

    MapMatcher(const MapMatcher&) = delete;
    MapMatcher& operator=(const MapMatcher&) = delete;

    /// Open the extract. Returns false and sets Error() on failure.
    bool Open(const std::string& sqlite_path);
    void Close() noexcept;
    bool IsOpen() const noexcept { return db_ != nullptr; }

    const std::string& Error() const noexcept { return error_; }

    /**
     * Nearest road centreline point to (lat, lon).
     *
     * `search_radius_m` sizes the R*Tree window. It is a search hint, not the
     * acceptance test: `max_distance_m` decides whether the result is used.
     * They are separate because widening the search is cheap while accepting a
     * distant match is not -- snapping to the wrong road puts the truck on a
     * different valley.
     */
    MatchStatus Match(double latitude_deg, double longitude_deg,
                      double max_distance_m, MapMatch* out,
                      double search_radius_m = 150.0) noexcept;

    /// Edges whose bounding box intersects the window. Exposed for tests.
    std::size_t CandidateCount(double latitude_deg, double longitude_deg,
                               double radius_m) noexcept;

private:
    sqlite3* db_ = nullptr;
    sqlite3_stmt* query_ = nullptr;
    std::string error_;
    // Reused across calls so a match in the navigation loop does not allocate.
    std::vector<double> coords_;
};

}  // namespace drishti
