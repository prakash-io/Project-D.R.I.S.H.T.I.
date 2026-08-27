"""Feature-assembly, raster and endpoint tests.

Every test here avoids the network: `/predict-hazard` is exercised with all
three rainfall features overridden, which is the documented escape hatch and
also the only way to make a hazard score reproducible.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "ai-services"))

from drishti_ai import config  # noqa: E402
from drishti_ai.features import FeatureBuilder, FeatureUnavailable  # noqa: E402
from drishti_ai.rasters import TerrainSampler  # noqa: E402

# A dry, reproducible rainfall scenario. Overriding all three keeps the test
# off the network and pins the only time-varying inputs.
DRY = {"rainfall_72h_mm": 0.0, "rainfall_24h_mm": 0.0, "rainfall_intensity_mmh": 0.0}

# High Arunachal Himalaya: steep, high, and covered by two overlapping sheets.
HIMALAYA = (27.5, 92.0)


# --------------------------------------------------------------- rasters

@pytest.fixture(scope="module")
def terrain():
    if not config.TERRAIN_RASTER_DIR.is_dir():
        pytest.skip("terrain rasters not present")
    sampler = TerrainSampler(config.TERRAIN_RASTER_DIR)
    yield sampler
    sampler.close()


def test_all_three_layers_load(terrain):
    assert terrain.sheet_count == 27
    for layer in ("dem", "slope", "aspect"):
        assert len(terrain.sheets[layer]) == 9


def test_overlapping_sheets_resolve_to_the_smaller_one(terrain):
    """(27.5, 92.0) is inside both the Assam and Arunachal sheets.

    Without a rule the answer depends on directory order and can differ
    between machines. Smallest-sheet-first makes it deterministic.
    """
    lat, lon = HIMALAYA
    covering = [s.region for s in terrain.sheets["dem"] if s.covers(lon, lat)]
    assert {"assam", "arunachal_pradesh"} <= set(covering)

    _, region = terrain.sample("dem", lat, lon)
    assert region == "arunachal_pradesh"

    areas = {s.region: s.area for s in terrain.sheets["dem"] if s.covers(lon, lat)}
    assert areas["arunachal_pradesh"] < areas["assam"]


def test_sampled_values_are_physically_plausible(terrain):
    lat, lon = HIMALAYA
    elevation, _ = terrain.sample("dem", lat, lon)
    slope, _ = terrain.sample("slope", lat, lon)
    aspect, _ = terrain.sample("aspect", lat, lon)

    assert 3_000 < elevation < 7_000     # high Himalaya, below Everest
    assert 0 <= slope <= 90
    assert 0 <= aspect <= 360


def test_point_outside_every_sheet_returns_none(terrain):
    # Bay of Bengal -- well outside the NER sheets.
    value, region = terrain.sample("dem", 18.0, 89.0)
    assert value is None and region is None


def test_nodata_is_never_returned_as_an_elevation(terrain):
    """A -9999 read must fall through, not become an elevation."""
    for sheet in terrain.sheets["dem"]:
        assert sheet.dataset.nodata == -9999.0
    # Sample a grid across the union of the sheets; nothing may come back as
    # the nodata sentinel.
    for lat in np.arange(22.0, 29.0, 0.9):
        for lon in np.arange(88.5, 97.0, 1.1):
            value, _ = terrain.sample("dem", float(lat), float(lon))
            assert value is None or value > -9998.0


# ------------------------------------------------------- feature assembly

class StubIndex:
    def __init__(self, distance):
        self._d = distance

    def distance_m(self, lat, lon):
        return self._d


class StubTerrain:
    def __init__(self, values):
        self._values = values

    def sample_all(self, lat, lon):
        return {name: {"value": v, "region": "stub", "layer": name}
                for name, v in self._values.items()}


FEATURES = ["elevation_m", "slope_deg", "aspect_deg", "dist_to_river_m",
            "dist_to_road_m", "rainfall_72h_mm", "rainfall_24h_mm",
            "rainfall_intensity_mmh"]


def make_builder(terrain_values):
    return FeatureBuilder(StubTerrain(terrain_values), StubIndex(500.0),
                          StubIndex(120.0), FEATURES)


def test_feature_vector_is_ordered_by_the_scaler_not_insertion():
    builder = make_builder({"elevation_m": 900.0, "slope_deg": 30.0, "aspect_deg": 180.0})
    vector = builder.build(27.0, 92.0, DRY)
    row = vector.ordered(FEATURES)

    assert row.shape == (1, 8)
    # Order is what the model was trained on; a permutation here would be
    # invisible in the output but would change every prediction.
    assert list(row[0]) == [900.0, 30.0, 180.0, 500.0, 120.0, 0.0, 0.0, 0.0]


def test_missing_terrain_refuses_rather_than_imputing():
    builder = make_builder({"elevation_m": None, "slope_deg": None, "aspect_deg": None})
    with pytest.raises(FeatureUnavailable) as exc:
        builder.build(18.0, 89.0, DRY)
    assert "elevation_m" in str(exc.value)
    assert set(exc.value.missing) == {"elevation_m", "slope_deg", "aspect_deg"}


def test_overrides_can_supply_a_feature_the_rasters_lack():
    builder = make_builder({"elevation_m": None, "slope_deg": 12.0, "aspect_deg": 90.0})
    vector = builder.build(18.0, 89.0, DRY, overrides={"elevation_m": 42.0})
    assert vector.raw["elevation_m"] == 42.0


def test_unknown_override_name_is_rejected():
    builder = make_builder({"elevation_m": 1.0, "slope_deg": 1.0, "aspect_deg": 1.0})
    with pytest.raises(FeatureUnavailable, match="unknown feature override"):
        builder.build(27.0, 92.0, DRY, overrides={"rainfall_1h_mm": 5.0})


# ------------------------------------------------------------- endpoints

@pytest.fixture(scope="module")
def client():
    if not config.XGB_MODEL_PATH.exists():
        pytest.skip("hazard model not trained")
    if not config.ROAD_KDTREE_PATH.exists():
        pytest.skip("road index not built")
    from main import app
    with TestClient(app) as test_client:
        yield test_client


def test_health_reports_loaded_artefacts(client):
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["hazard_model"]["classes"] == ["SAFE_TERRAIN", "LANDSLIDE_RISK", "FLOOD_RISK"]
    assert body["hazard_model"]["features"] == FEATURES
    assert body["terrain_sheets"] == 27
    assert body["indices"]["road"] > 6_000_000


def test_predict_hazard_on_steep_high_terrain(client):
    lat, lon = HIMALAYA
    body = client.post("/predict-hazard",
                       json={"latitude": lat, "longitude": lon, "overrides": DRY}).json()

    assert body["predicted_class"] == "LANDSLIDE_RISK"
    assert 0.0 <= body["hazard_probability"] <= 1.0
    # 1 - P(SAFE_TERRAIN) is the contract the dashboard threshold uses.
    assert body["hazard_probability"] == pytest.approx(
        1.0 - body["class_probabilities"]["SAFE_TERRAIN"], rel=1e-6)
    assert sum(body["class_probabilities"].values()) == pytest.approx(1.0, rel=1e-5)
    assert body["high_risk"] is (body["hazard_probability"] >= body["risk_threshold"])
    assert body["provenance"]["weather_source"] == "override"
    assert body["provenance"]["terrain_region"] == "arunachal_pradesh"
    assert body["features"]["slope_deg"] > 30


def test_predict_hazard_is_deterministic(client):
    payload = {"latitude": 27.5, "longitude": 92.0, "overrides": DRY}
    first = client.post("/predict-hazard", json=payload).json()
    second = client.post("/predict-hazard", json=payload).json()
    assert first["class_probabilities"] == second["class_probabilities"]


def test_flat_terrain_near_a_river_is_not_landslide_risk(client):
    # Brahmaputra floodplain at Guwahati: low, flat, beside a major river.
    body = client.post("/predict-hazard",
                       json={"latitude": 26.1445, "longitude": 91.7362,
                             "overrides": DRY}).json()
    assert body["features"]["slope_deg"] < 15
    assert body["predicted_class"] != "LANDSLIDE_RISK"


def test_coordinate_outside_coverage_is_rejected_by_validation(client):
    response = client.post("/predict-hazard",
                           json={"latitude": 48.85, "longitude": 2.35})  # Paris
    assert response.status_code == 422


def test_coordinate_inside_the_box_but_off_the_sheets_gets_422(client):
    # Inside the declared lat/lon box but off every terrain sheet.
    response = client.post("/predict-hazard",
                           json={"latitude": 21.2, "longitude": 97.9, "overrides": DRY})
    assert response.status_code == 422
    assert "outside the terrain rasters" in response.json()["detail"]


def test_verify_incident_rejects_a_non_image(client):
    if not config.YOLO_WEIGHTS.exists():
        pytest.skip("YOLO weights not trained yet")
    response = client.post("/verify-incident",
                           files={"file": ("notes.txt", b"this is not a jpeg", "text/plain")})
    assert response.status_code == 400


def test_verify_incident_without_weights_is_503_not_a_guess(client):
    if config.YOLO_WEIGHTS.exists():
        pytest.skip("weights present; the 503 path is unreachable")
    response = client.post("/verify-incident",
                           files={"file": ("photo.jpg", b"\xff\xd8\xff", "image/jpeg")})
    assert response.status_code == 503


# ------------------------------------------- torch / xgboost process isolation

def test_vision_and_hazard_coexist_in_one_service(client):
    """The regression test for the OpenMP collision.

    torch and xgboost cannot share a macOS process: with xgboost's runtime
    loaded first, torch inference hangs forever; with torch's loaded first,
    xgboost `predict` segfaults. Vision therefore runs in a spawned worker.

    This exercises the exact sequence that used to fail -- an xgboost
    prediction, then a real torch inference, then the same xgboost prediction
    again -- and pins that the hazard answer is unchanged by the torch call.
    """
    if not config.YOLO_WEIGHTS.exists():
        pytest.skip("YOLO weights not trained yet")

    image_dir = ROOT / "data" / "processed" / "vision" / "incident-cls" / "test"
    images = sorted((image_dir / "ACTIVE_LANDSLIDE_DEBRIS").glob("*.jpg"))
    if not images:
        pytest.skip("classification tree not built")

    payload = {"latitude": 27.5, "longitude": 92.0, "overrides": DRY}
    before = client.post("/predict-hazard", json=payload).json()

    response = client.post(
        "/verify-incident",
        files={"file": (images[0].name, images[0].read_bytes(), "image/jpeg")},
    )
    assert response.status_code == 200, response.text
    verdict = response.json()
    assert verdict["predicted_class"] in config.YOLO_CLASSES
    assert 0.0 <= verdict["confidence"] <= 1.0

    after = client.post("/predict-hazard", json=payload).json()
    assert after["class_probabilities"] == before["class_probabilities"]


def test_incident_kind_maps_onto_the_db_constraint(client):
    """`incident_kind` must be a value incidents.kind will accept, or null."""
    if not config.YOLO_WEIGHTS.exists():
        pytest.skip("YOLO weights not trained yet")

    image_dir = ROOT / "data" / "processed" / "vision" / "incident-cls" / "test"
    allowed = {"landslide", "flood", "obstruction", None}
    seen = set()
    for class_name in ("ACTIVE_LANDSLIDE_DEBRIS", "FLOODED_ROAD_OR_SUBMERGED"):
        images = sorted((image_dir / class_name).glob("*.jpg"))[:2]
        for image in images:
            body = client.post(
                "/verify-incident",
                files={"file": (image.name, image.read_bytes(), "image/jpeg")},
            ).json()
            assert body["incident_kind"] in allowed
            seen.add(body["incident_kind"])
    # Both real classes must actually reach a blockable kind, or the endpoint
    # is useless to API-03.
    assert {"landslide", "flood"} <= seen


def test_normal_terrain_is_never_a_blockable_kind():
    """NORMAL_TERRAIN must map to no incident kind, whatever the confidence.

    Asserted against the mapping directly rather than through the model: the
    current model cannot emit this class at all, because the dataset's
    NORMAL_TERRAIN labels are filename index arithmetic rather than image
    content. The mapping still has to be right for any checkpoint that does.
    """
    assert config.YOLO_CLASS_TO_INCIDENT_KIND["NORMAL_TERRAIN"] is None
    for name, kind in config.YOLO_CLASS_TO_INCIDENT_KIND.items():
        assert kind in {"landslide", "flood", "obstruction", None}, name


def test_every_class_the_model_emits_has_a_kind_mapping():
    """The mapping must cover the model, or an incident silently vanishes.

    It is deliberately WIDER than the current model's classes so an older
    4-class checkpoint still maps; what must hold is coverage, not equality.
    """
    assert set(config.YOLO_CLASSES) <= set(config.YOLO_CLASS_TO_INCIDENT_KIND)


def test_current_model_does_not_emit_the_arithmetic_classes(client):
    """The model must not offer a class whose labels were noise.

    DAMAGED_BRIDGE_INFRASTRUCTURE only; NORMAL_TERRAIN is a real class now and
    is asserted present rather than absent.
    """
    if not config.YOLO_WEIGHTS.exists():
        pytest.skip("YOLO weights not trained yet")

    image_dir = ROOT / "data" / "processed" / "vision" / "incident-cls" / "test"
    images = sorted((image_dir / "ACTIVE_LANDSLIDE_DEBRIS").glob("*.jpg"))
    if not images:
        pytest.skip("classification tree not built")

    body = client.post(
        "/verify-incident",
        files={"file": (images[0].name, images[0].read_bytes(), "image/jpeg")},
    ).json()

    emitted = set(body["class_probabilities"])
    assert "DAMAGED_BRIDGE_INFRASTRUCTURE" not in emitted
    assert "NORMAL_TERRAIN" in emitted
    assert emitted == set(config.YOLO_CLASSES)


def test_an_unrelated_photo_is_not_a_hazard(client):
    """THE regression test for the reported bug.

    "Even if I upload a random photo, it classifies it as a flood." The image
    used here ships with ultralytics -- a photograph of footballers, from a
    source entirely disjoint from both the hazard pools and the negative pool,
    so it is held out by construction and cannot have been trained on.

    Before the negative class existed this returned ACTIVE_LANDSLIDE_DEBRIS at
    1.000 confidence, and the backend snapped it to a road edge ready for a
    dispatcher to block. What must hold now is not merely that the verdict is
    unverified -- a confidence threshold could have done that -- but that the
    model NAMES it as normal terrain.
    """
    if not config.YOLO_WEIGHTS.exists():
        pytest.skip("YOLO weights not trained yet")

    import ultralytics
    asset = Path(ultralytics.__file__).parent / "assets" / "zidane.jpg"
    if not asset.exists():
        pytest.skip("ultralytics sample asset not present")

    body = client.post(
        "/verify-incident",
        files={"file": (asset.name, asset.read_bytes(), "image/jpeg")},
    ).json()

    assert body["predicted_class"] == "NORMAL_TERRAIN", (
        f"a photograph of footballers came back as {body['predicted_class']} "
        f"at {body['confidence']:.3f} -- the negative class is not doing its job"
    )
    # The two that actually protect the road graph.
    assert body["verified"] is False
    assert body["incident_kind"] is None


def test_a_verified_incident_demands_human_review(client):
    """No verdict may block a road edge unreviewed while the data is what it is.

    The model has no "no incident" class and was trained on aerial and
    satellite imagery, while the endpoint receives ground-level phone
    photographs. Both are reasons API-03 must not act on this alone.
    """
    if not config.YOLO_WEIGHTS.exists():
        pytest.skip("YOLO weights not trained yet")
    if not config.INCIDENT_REQUIRE_REVIEW:
        pytest.skip("review gate disabled by configuration")

    image_dir = ROOT / "data" / "processed" / "vision" / "incident-cls" / "test"
    images = sorted((image_dir / "FLOODED_ROAD_OR_SUBMERGED").glob("*.jpg"))
    if not images:
        pytest.skip("classification tree not built")

    body = client.post(
        "/verify-incident",
        files={"file": (images[0].name, images[0].read_bytes(), "image/jpeg")},
    ).json()

    assert body["verified"] is True
    assert body["incident_kind"] == "flood"
    assert body["requires_human_review"] is True
    assert body["review_reason"]


def test_vision_pool_recovers_after_the_worker_dies():
    """A crashed worker must not wedge the endpoint permanently.

    `ProcessPoolExecutor` poisons itself when a worker dies: every later
    `submit` raises `BrokenProcessPool` immediately, forever. Since the
    OpenMP collision this design exists to avoid manifests *as* a segfault,
    a dead worker is a realistic state, and 'restart the service' is not an
    acceptable recovery path for a driver reporting a landslide.
    """
    if not config.YOLO_WEIGHTS.exists():
        pytest.skip("YOLO weights not trained yet")

    import os
    import signal

    from drishti_ai.models import IncidentVerifier

    image_dir = ROOT / "data" / "processed" / "vision" / "incident-cls" / "test"
    images = sorted((image_dir / "ACTIVE_LANDSLIDE_DEBRIS").glob("*.jpg"))
    if not images:
        pytest.skip("classification tree not built")
    payload = images[0].read_bytes()

    verifier = IncidentVerifier(config.YOLO_WEIGHTS, config.YOLO_CLASSES,
                               config.YOLO_CONF_THRESHOLD)
    try:
        first = verifier.verify(payload)
        assert first.predicted_class in config.YOLO_CLASSES

        # Kill the warm worker out from under the executor.
        pids = [p.pid for p in verifier._pool._processes.values()]
        assert pids, "expected a live worker process"
        for pid in pids:
            os.kill(pid, signal.SIGKILL)

        # The next call sees the poisoned pool, resets it, and says so.
        with pytest.raises(RuntimeError, match="vision worker died"):
            verifier.verify(payload)

        # And the one after that works again on a fresh pool.
        recovered = verifier.verify(payload)
        assert recovered.predicted_class == first.predicted_class
        assert recovered.confidence == pytest.approx(first.confidence, rel=1e-6)
    finally:
        verifier.shutdown()


# ------------------------------------------------------- trust signals

def test_score_is_trustworthy_now_the_features_are_raster_derived(client):
    """`trustworthy` must be true now that training and serving agree.

    Before the rebuild `slope_deg` correlated 0.309 with the terrain the
    service samples and `aspect_deg` was uniform noise, so every response was
    flagged. After `rebuild_hazard_features.py` both correlate 1.000 exactly
    and the flag must clear -- a warning that never goes away is a warning
    nobody reads.
    """
    body = client.post("/predict-hazard",
                       json={"latitude": 27.5, "longitude": 92.0, "overrides": DRY}).json()

    assert body["unvalidated_features"] == []
    assert body["out_of_distribution_features"] == []
    assert body["trustworthy"] is True


def test_predictions_follow_the_terrain(client):
    """Physical sanity, not accuracy: steep means landslide, flat means not.

    This is the check that caught the relabelling bug. Rebuilding slope while
    leaving labels that were generated from the OLD slope produced a model
    that called a 1.8 deg valley floor LANDSLIDE_RISK and a 23.5 deg ridge
    FLOOD_RISK, all while scoring 0.907 against those same broken labels.
    No accuracy number would have caught it.
    """
    steep = client.post("/predict-hazard",
                        json={"latitude": 27.5, "longitude": 92.0,
                              "overrides": DRY}).json()
    flat = client.post("/predict-hazard",
                       json={"latitude": 24.8170, "longitude": 93.9368,
                             "overrides": DRY}).json()

    assert steep["features"]["slope_deg"] > 30
    assert flat["features"]["slope_deg"] < 5
    assert steep["predicted_class"] == "LANDSLIDE_RISK"
    assert flat["predicted_class"] != "LANDSLIDE_RISK"
    assert steep["hazard_probability"] > flat["hazard_probability"]


def test_out_of_distribution_input_is_named_not_extrapolated(client):
    """Trees do not extrapolate -- an input past the training range must say so.

    `dist_to_road_m` tops out at 408 km in training. A point 4,000 km from a
    road lands in the same leaf as the most distant training row, so the model
    returns a confident answer that contains no information about the
    difference. The response names the feature instead of hiding it.
    """
    absurd = dict(DRY)
    absurd["dist_to_road_m"] = 4_000_000.0

    body = client.post("/predict-hazard",
                       json={"latitude": 27.5, "longitude": 92.0,
                             "overrides": absurd}).json()

    assert "dist_to_road_m" in body["out_of_distribution_features"]
    assert body["trustworthy"] is False


def test_in_range_features_are_not_flagged_out_of_distribution(client):
    """The guard must not cry wolf on ordinary inputs."""
    body = client.post("/predict-hazard",
                       json={"latitude": 26.1445, "longitude": 91.7362,
                             "overrides": DRY}).json()
    assert body["out_of_distribution_features"] == []
