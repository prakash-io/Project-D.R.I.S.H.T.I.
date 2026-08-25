"""Tests for the spatial primitives.

These cover the two mistakes that would be hardest to notice in production:
querying a projected KDTree with raw degrees, and measuring a longitude
distance with a flat multiplier.
"""

from __future__ import annotations

import math
import pickle
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "ai-services"))

from drishti_ai import config  # noqa: E402
from drishti_ai.geo import (M_PER_DEG_LAT, M_PER_DEG_LON, NearestIndex,  # noqa: E402
                            haversine_m, project_xy)
from drishti_ai.models import load_index  # noqa: E402


def test_projection_constants_are_the_artefacts_own():
    # 111139 m/deg latitude, scaled by cos(25.5) for longitude. Recovered by
    # least-squares from the shipped indices, so these are facts about the
    # data, not preferences -- a change here silently breaks every lookup.
    assert M_PER_DEG_LAT == 111139.0
    assert M_PER_DEG_LON == pytest.approx(111139.0 * math.cos(math.radians(25.5)))
    assert M_PER_DEG_LON == pytest.approx(100312.425917, abs=1e-5)


def test_haversine_matches_known_distances():
    # One degree of latitude is ~111.19 km everywhere.
    assert haversine_m(25.0, 92.0, 26.0, 92.0) == pytest.approx(111195, rel=1e-3)
    # One degree of longitude shrinks with latitude -- the entire reason a
    # flat degrees-to-metres multiplier is wrong.
    at_25 = float(haversine_m(25.5, 92.0, 25.5, 93.0))
    at_29 = float(haversine_m(29.5, 92.0, 29.5, 93.0))
    assert at_25 == pytest.approx(100363, rel=1e-3)
    assert at_29 == pytest.approx(96779, rel=1e-3)
    assert at_29 < at_25
    # A flat multiplier would be off by >3.5 km over one degree at 29.5.
    assert abs(at_29 - M_PER_DEG_LON) > 3_000


def test_haversine_is_symmetric_and_zero_at_a_point():
    assert float(haversine_m(26.1, 91.7, 26.1, 91.7)) == pytest.approx(0.0, abs=1e-6)
    a = float(haversine_m(26.1, 91.7, 27.2, 93.4))
    b = float(haversine_m(27.2, 93.4, 26.1, 91.7))
    assert a == pytest.approx(b, rel=1e-12)


@pytest.fixture(scope="module")
def river_index():
    if not config.RIVER_KDTREE_PATH.exists():
        pytest.skip("river index not present")
    return load_index("river_waterways", config.RIVER_KDTREE_PATH)


def test_shipped_index_reprojects_onto_its_own_tree(river_index):
    # The strongest available check that this module's projection is the one
    # the index was built with: re-project the index's own lat/lon and land on
    # tree.data. load_index already runs this; asserting the residual makes
    # the tolerance explicit.
    assert river_index.verify_projection() < 1e-3


def test_nearest_is_measured_by_haversine_not_tree_distance(river_index):
    lat, lon = 26.1445, 91.7362  # Guwahati, on the Brahmaputra
    neighbour = river_index.nearest(lat, lon)
    recomputed = float(haversine_m(lat, lon, neighbour.lat, neighbour.lon))
    assert neighbour.distance_m == pytest.approx(recomputed, rel=1e-9)
    # The tree's own Euclidean distance is in the distorted projection and
    # must NOT be what gets reported.
    tree_distance, _ = river_index.tree.query(project_xy(lon, lat), k=1)
    assert neighbour.distance_m != pytest.approx(float(tree_distance), rel=1e-6)


def test_querying_the_tree_with_raw_degrees_is_catastrophically_wrong(river_index):
    """Regression guard for the bug the whole projection dance exists to avoid.

    Feeding (lon, lat) degrees straight into a tree built in metres puts the
    query ~10^7 m from every point in the cloud. It does not raise -- it
    returns a confident, arbitrary neighbour hundreds of km away.
    """
    lat, lon = 27.5, 92.0
    _, naive_position = river_index.tree.query([lon, lat], k=1)
    naive_m = float(haversine_m(lat, lon,
                                river_index.lat[int(naive_position)],
                                river_index.lon[int(naive_position)]))
    correct_m = river_index.nearest(lat, lon).distance_m

    assert correct_m < 20_000
    assert naive_m > 100_000
    assert naive_m > correct_m * 5


def test_index_rejects_inconsistent_arrays():
    class FakeTree:
        n = 3
        data = np.zeros((3, 2))

    with pytest.raises(ValueError, match="inconsistent"):
        NearestIndex("fake", FakeTree(), np.zeros(2), np.zeros(2))


def test_verify_projection_rejects_a_differently_projected_index():
    """A rebuilt index using a different constant must fail loudly at load."""
    lat = np.array([25.0, 26.0, 27.0])
    lon = np.array([92.0, 93.0, 94.0])

    class FakeTree:
        n = 3
        # Built with 111320 m/deg instead of 111139 -- a plausible mistake.
        data = np.column_stack([lon * 111320.0 * math.cos(math.radians(25.5)),
                                lat * 111320.0])

    index = NearestIndex("wrong-projection", FakeTree(), lat, lon)
    with pytest.raises(ValueError, match="projection mismatch"):
        index.verify_projection()
