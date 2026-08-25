"""Tests that pin what is wrong with the training data.

These do not test code. They assert facts about the datasets that were
established by measurement and that silently invalidate the models built on
them. Each one exists so that:

*   the finding cannot be quietly forgotten, and
*   if someone regenerates a dataset and fixes the problem, the test FAILS and
    says so -- which is the signal to retrain and to relax the corresponding
    guard in the service.

A failure here is therefore not necessarily bad news. Read the message.
"""

from __future__ import annotations

import glob
import os
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "ai-services"))

from drishti_ai import config  # noqa: E402

VISION_ROOT = ROOT / "data" / "raw" / "vision" / "incident-yolo"
SPLIT_DIR = ROOT / "data" / "processed" / "landslide"

CLASS_BY_ID = {
    0: "NORMAL_TERRAIN",
    1: "FLOODED_ROAD_OR_SUBMERGED",
    2: "ACTIVE_LANDSLIDE_DEBRIS",
    3: "DAMAGED_BRIDGE_INFRASTRUCTURE",
}


# ------------------------------------------------------- vision label source

def load_vision_labels() -> list[tuple[str, int, str]]:
    rows = []
    for split in ("train", "val", "test"):
        for path in glob.glob(str(VISION_ROOT / split / "labels" / "*.txt")):
            stem = os.path.basename(path)[:-4]
            match = re.match(r"([a-z]+)_(\d+)$", stem)
            if match is None:
                continue
            class_id = int(Path(path).read_text().split()[0])
            rows.append((match.group(1), int(match.group(2)), CLASS_BY_ID[class_id]))
    return rows


@pytest.fixture(scope="module")
def vision_labels():
    if not VISION_ROOT.is_dir():
        pytest.skip("vision dataset not present")
    rows = load_vision_labels()
    if not rows:
        pytest.skip("no vision labels found")
    return rows


def test_two_vision_classes_are_filename_arithmetic(vision_labels):
    """NORMAL_TERRAIN and DAMAGED_BRIDGE are index arithmetic, not content.

    If this FAILS, the dataset has been relabelled from image content. Retrain
    with `--label-source file` to get all four classes back, and revisit
    config.INCIDENT_REQUIRE_REVIEW -- a real NORMAL_TERRAIN class is exactly
    the guard whose absence forces the review gate.
    """
    rules = [
        ("landslide", 4, "NORMAL_TERRAIN"),
        ("flood", 12, "DAMAGED_BRIDGE_INFRASTRUCTURE"),
    ]
    for pool, modulus, minority in rules:
        rows = [r for r in vision_labels if r[0] == pool]
        assert rows, f"no images in the {pool} pool"
        violations = [(i, c) for _, i, c in rows if (c == minority) != (i % modulus == 0)]
        assert not violations, (
            f"{pool}: 'index % {modulus} == 0 -> {minority}' now has "
            f"{len(violations)} exceptions -- the labels may have become real"
        )


def test_the_model_does_not_emit_the_arithmetic_classes():
    """Whatever the dataset says, the served model must not offer noise."""
    assert "NORMAL_TERRAIN" not in config.YOLO_CLASSES
    assert "DAMAGED_BRIDGE_INFRASTRUCTURE" not in config.YOLO_CLASSES


def test_review_gate_is_on_while_there_is_no_no_incident_class():
    """The gate may only be lifted once the model can say 'no incident'."""
    if "NORMAL_TERRAIN" in config.YOLO_CLASSES:
        pytest.skip("model has a NORMAL_TERRAIN class; the gate may be reconsidered")
    assert config.INCIDENT_REQUIRE_REVIEW, (
        "INCIDENT_REQUIRE_REVIEW was disabled while the model still has no "
        "'no incident' class -- a photo of an empty road can only come back "
        "as flood or landslide, and API-03 would block the edge."
    )


# ------------------------------------------------- hazard feature provenance

@pytest.fixture(scope="module")
def hazard_raw():
    if not (SPLIT_DIR / "X_train.parquet").exists():
        pytest.skip("landslide splits not present")
    import joblib

    scaler = joblib.load(config.FEATURE_SCALER_PATH)
    features = list(scaler.feature_names_in_)
    X = pd.concat([pd.read_parquet(SPLIT_DIR / f"X_{s}.parquet")
                   for s in ("train", "val", "test")], ignore_index=True)
    raw = pd.DataFrame(scaler.inverse_transform(X[features].to_numpy()), columns=features)
    raw["latitude"] = X["latitude"].to_numpy()
    raw["longitude"] = X["longitude"].to_numpy()
    return raw


def test_shipped_aspect_was_uniform_noise(hazard_raw):
    """The ORIGINAL `aspect_deg` is not terrain aspect, and still isn't.

    Over 22,195 rows it is statistically indistinguishable from
    Uniform(0, 360) -- KS p = 0.33 -- and correlates -0.018 with the aspect
    the service samples at the same coordinate. This asserts the shipped file,
    which is why the rebuild exists; the SERVED model no longer uses it (see
    the test below).
    """
    from scipy import stats

    aspect = hazard_raw["aspect_deg"].to_numpy()
    normalised = (aspect - aspect.min()) / (aspect.max() - aspect.min())
    result = stats.kstest(normalised, "uniform")
    assert result.pvalue > 0.05, (
        f"the shipped aspect_deg no longer looks uniform (KS p={result.pvalue:.4g}) "
        f"-- it may have been regenerated as real terrain aspect"
    )


def test_served_model_is_trained_on_raster_derived_features():
    """The model in use must be the rebuilt one, not the shipped features.

    `slope_deg`/`aspect_deg` in the shipped table do not describe the
    coordinate they are attached to (0.309 and -0.018 against the rasters),
    and slope carried ~61% of the model's gain. The served model must
    therefore come from `landslide_rebuilt`, and must declare that it has no
    unvalidated features left.
    """
    import json

    meta_path = config.XGB_MODEL_PATH.with_name(config.XGB_MODEL_PATH.stem + "_meta.json")
    if not meta_path.exists():
        pytest.skip("hazard model not trained")
    meta = json.loads(meta_path.read_text())

    assert meta["feature_source"] == "rebuilt_from_rasters", (
        "the served model was trained on the shipped features, whose slope and "
        "aspect are synthetic. Run scripts/rebuild_hazard_features.py."
    )
    assert sorted(meta["rebuilt_columns"]) == ["aspect_deg", "slope_deg"]
    assert meta["unvalidated_features"] == []


def test_rebuilt_labels_track_real_terrain():
    """Relabelling must have restored the physical ordering of the classes.

    The labels were generated from the OLD slope, so carrying them onto real
    terrain unchanged makes the classes indistinguishable by slope --
    FLOOD_RISK averaged 16.5 deg against SAFE_TERRAIN's 17.0 deg, and the
    model called a valley floor a landslide. After relabelling, mean slope
    must again rise FLOOD < SAFE < LANDSLIDE.
    """
    import joblib

    rebuilt = ROOT / "data" / "processed" / "landslide_rebuilt"
    if not (rebuilt / "X_train.parquet").exists():
        pytest.skip("rebuilt splits not present")

    scaler = joblib.load(config.FEATURE_SCALER_PATH)
    features = list(scaler.feature_names_in_)
    X = pd.concat([pd.read_parquet(rebuilt / f"X_{s}.parquet")
                   for s in ("train", "val", "test")], ignore_index=True)
    y = pd.concat([pd.read_parquet(rebuilt / f"y_{s}.parquet")
                   for s in ("train", "val", "test")], ignore_index=True)
    raw = pd.DataFrame(scaler.inverse_transform(X[features].to_numpy()), columns=features)

    mean_slope = {c: raw.loc[(y["hazard_label"] == c).to_numpy(), "slope_deg"].mean()
                  for c in ("FLOOD_RISK", "SAFE_TERRAIN", "LANDSLIDE_RISK")}
    assert mean_slope["FLOOD_RISK"] < mean_slope["SAFE_TERRAIN"] < mean_slope["LANDSLIDE_RISK"], (
        f"labels no longer track slope: {mean_slope}"
    )


def test_labels_are_recoverable_by_a_two_split_rule(hazard_raw):
    """A depth-2 tree reproduces most labels, so 0.99 is not hazard skill.

    If this FAILS the labels have stopped being a threshold rule, which would
    be very good news and warrants re-reading the reported accuracy.
    """
    from sklearn.metrics import accuracy_score
    from sklearn.tree import DecisionTreeClassifier

    y = pd.concat([pd.read_parquet(SPLIT_DIR / f"y_{s}.parquet")
                   for s in ("train", "val", "test")], ignore_index=True)
    features = [c for c in hazard_raw.columns if c not in ("latitude", "longitude")]
    tree = DecisionTreeClassifier(max_depth=2, random_state=0)
    tree.fit(hazard_raw[features], y["hazard_type"])
    accuracy = accuracy_score(y["hazard_type"], tree.predict(hazard_raw[features]))
    assert accuracy > 0.90, (
        f"a depth-2 tree now only reaches {accuracy:.3f}; the labels may no "
        f"longer be a simple threshold rule"
    )
