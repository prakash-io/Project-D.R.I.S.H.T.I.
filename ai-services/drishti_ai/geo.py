"""Spatial primitives shared by the index builder and the API.

Two facts about the pre-built `*_spatial_index.pkl` artefacts drive everything
in this module, and both are silently wrong if assumed otherwise:

1.  **The KDTrees are NOT in degrees.** Their `.data` holds projected metres.
    Querying them with a raw (lon, lat) pair returns an essentially random
    neighbour -- the query point lands ~10^7 metres from the data cloud, so
    every candidate is equidistant and the tree returns whichever leaf it
    reaches first. The projection was recovered by least-squares fit against
    the `lat`/`lon` carried in each index's own `feature_records`, and it
    reproduces `tree.data` to ~1e-9 m on all three indices:

        x = lon_deg * 111139 * cos(25.5 deg)
        y = lat_deg * 111139

    That is an equirectangular projection about the NER centre latitude with
    111139 m per degree of latitude. `verify_projection()` re-checks this at
    load time so a rebuilt index that changed the constant cannot pass
    unnoticed.

2.  **That projection is only locally accurate.** It is fine for *finding*
    candidates but not for *measuring* them: the cos(25.5 deg) factor is exact
    only at 25.5 deg, so an east-west distance is off by ~1.4% at the 29.5 deg
    top of the data bbox. Distances are therefore always reported by
    `haversine_m` against the neighbour's true lat/lon, never by scaling the
    tree's own Euclidean distance. `NearestIndex.nearest` queries k>1 and
    re-ranks by haversine so the projection's distortion cannot pick the
    wrong neighbour either.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

# Metres per degree of latitude used by the upstream index builder. Not the
# WGS84 value (111319.49) and not R*pi/180 for R=6371 km (111194.93) -- it is
# 111139, an older spherical approximation. Recovered from the artefacts, so
# it is a fact about them, not a choice.
M_PER_DEG_LAT = 111139.0

# Reference latitude for the equirectangular x-scale. Carried in every index
# as `center_lat`; asserted rather than assumed at load time.
CENTER_LAT_DEG = 25.5

_COS_CENTER_LAT = math.cos(math.radians(CENTER_LAT_DEG))
M_PER_DEG_LON = M_PER_DEG_LAT * _COS_CENTER_LAT

# Mean Earth radius (IUGG). Used only by haversine, which is what every
# user-visible distance is measured with.
EARTH_RADIUS_M = 6371008.8


def project(lon_deg, lat_deg):
    """(lon, lat) degrees -> (x, y) index metres. Accepts scalars or arrays."""
    return np.asarray(lon_deg) * M_PER_DEG_LON, np.asarray(lat_deg) * M_PER_DEG_LAT


def project_xy(lon_deg: float, lat_deg: float) -> tuple[float, float]:
    """Scalar form of `project`, for building a single query point."""
    return lon_deg * M_PER_DEG_LON, lat_deg * M_PER_DEG_LAT


def haversine_m(lat1, lon1, lat2, lon2):
    """Great-circle distance in metres. Vectorised over the second point.

    This is the only distance the service reports. A flat degrees-to-metres
    multiplier would be wrong by the cos(latitude) factor in longitude, which
    across the 21.5-29.5 deg data bbox is a 5% error -- enough to move a
    `dist_to_river_m` feature by hundreds of metres and shift the model's
    output.
    """
    lat1_r, lon1_r = math.radians(lat1), math.radians(lon1)
    lat2_r = np.radians(np.asarray(lat2, dtype=float))
    lon2_r = np.radians(np.asarray(lon2, dtype=float))

    dlat = lat2_r - lat1_r
    dlon = lon2_r - lon1_r
    a = np.sin(dlat / 2.0) ** 2 + math.cos(lat1_r) * np.cos(lat2_r) * np.sin(dlon / 2.0) ** 2
    return 2.0 * EARTH_RADIUS_M * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0)))


@dataclass(frozen=True)
class Neighbour:
    """Nearest indexed vertex to a query point."""

    lat: float
    lon: float
    distance_m: float
    position: int


class NearestIndex:
    """Read-only nearest-neighbour lookup over one pre-built spatial index.

    Wraps the pickled `SpatialFeatureIndex` (or a lean index built by
    `scripts/build_road_index.py`) so callers never touch `tree.data` or the
    projection directly.
    """

    #: How many candidates to pull before re-ranking by haversine. The
    #: projection compresses longitude by a fixed cos(25.5 deg) while the true
    #: factor varies with latitude, so the tree's own ordering can be wrong by
    #: ~1.4% at the bbox edges. 8 candidates makes a mis-pick require eight
    #: near-ties, which no realistic geometry produces.
    K_CANDIDATES = 8

    def __init__(self, name: str, tree, lat: np.ndarray, lon: np.ndarray, records=None):
        if len(lat) != len(lon) or len(lat) != tree.n:
            raise ValueError(
                f"{name}: index is inconsistent -- tree has {tree.n} points "
                f"but {len(lat)} lat / {len(lon)} lon values"
            )
        self.name = name
        self.tree = tree
        self.lat = lat
        self.lon = lon
        self.records = records

    def __len__(self) -> int:
        return int(self.tree.n)

    def verify_projection(self, sample: int = 4096, tol_m: float = 1e-3) -> float:
        """Re-project the stored lat/lon and compare against `tree.data`.

        Returns the max absolute residual in metres. Raises if the index was
        built with a different projection than this module assumes -- which
        would otherwise surface as plausible-looking but wrong distances.
        """
        data = np.asarray(self.tree.data)
        n = len(self.lat)
        idx = np.arange(n) if n <= sample else np.linspace(0, n - 1, sample).astype(int)
        x, y = project(self.lon[idx], self.lat[idx])
        residual = float(max(np.abs(data[idx, 0] - x).max(), np.abs(data[idx, 1] - y).max()))
        if residual > tol_m:
            raise ValueError(
                f"{self.name}: projection mismatch -- re-projecting the index's own "
                f"lat/lon misses tree.data by {residual:.4g} m (tolerance {tol_m} m). "
                f"The index was not built with x=lon*{M_PER_DEG_LON:.6f}, "
                f"y=lat*{M_PER_DEG_LAT:.6f}."
            )
        return residual

    def nearest(self, lat_deg: float, lon_deg: float) -> Neighbour:
        """Nearest indexed vertex, measured by haversine."""
        k = min(self.K_CANDIDATES, len(self))
        _, positions = self.tree.query(project_xy(lon_deg, lat_deg), k=k)
        positions = np.atleast_1d(positions).astype(int)
        # cKDTree pads with tree.n when fewer than k neighbours exist.
        positions = positions[positions < len(self)]
        if positions.size == 0:
            raise ValueError(f"{self.name}: index is empty")

        distances = haversine_m(lat_deg, lon_deg, self.lat[positions], self.lon[positions])
        best = int(np.argmin(distances))
        pos = int(positions[best])
        return Neighbour(
            lat=float(self.lat[pos]),
            lon=float(self.lon[pos]),
            distance_m=float(distances[best]),
            position=pos,
        )

    def distance_m(self, lat_deg: float, lon_deg: float) -> float:
        return self.nearest(lat_deg, lon_deg).distance_m
