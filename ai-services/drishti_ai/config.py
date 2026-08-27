"""Resolved paths and tunables for the AI service.

Everything is read from the environment with a repo-relative default, so the
service runs from a clean checkout with no `.env` and still picks up
deployment overrides. Paths are resolved once, at import, and validated at
startup by `main.lifespan` rather than on first request -- a missing raster
should fail the container's readiness probe, not the dispatcher's first click.
"""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent


def _path(env: str, default: str) -> Path:
    raw = os.getenv(env, default)
    p = Path(raw)
    return p if p.is_absolute() else ROOT / p


# ------------------------------------------------------------------ risk model
XGB_MODEL_PATH = _path("XGB_MODEL_PATH", "data/artifacts/risk/hazard_model.json")
FEATURE_SCALER_PATH = _path("FEATURE_SCALER_PATH", "data/artifacts/risk/feature_scaler.joblib")

#: Probability at or above which a segment is flagged red on the dashboard
#: (WEB-04). Compared against `hazard_probability`, i.e. 1 - P(SAFE_TERRAIN).
RISK_FLAG_THRESHOLD = float(os.getenv("RISK_FLAG_THRESHOLD", "0.85"))

#: Fallback for a model whose metadata predates `unvalidated_features`.
#:
#: The authoritative list now lives in `hazard_model_meta.json`, written by
#: train_hazard_xgb.py: it is empty when the model was trained from
#: raster-rebuilt features and ["slope_deg", "aspect_deg"] when it was trained
#: from the splits as shipped. Keeping it model-derived means retraining
#: cannot leave a stale warning behind, in either direction.
#:
#: History: as shipped, `slope_deg` correlated 0.309 with the terrain the
#: service samples and `aspect_deg` was uniform noise (KS p=0.33 over 22,195
#: rows), while `slope_deg` carried 61% of the model's gain. After
#: scripts/rebuild_hazard_features.py both correlate 1.000 exactly.
UNVALIDATED_FEATURES = [c.strip() for c in
                        os.getenv("UNVALIDATED_FEATURES", "").split(",") if c.strip()]

# ------------------------------------------------------------- spatial indices
INDEX_DIR = _path("INDEX_DIR", "data/processed/indices")
RIVER_KDTREE_PATH = _path("RIVER_KDTREE_PATH", "data/processed/indices/river_waterways_spatial_index.pkl")
BRIDGE_KDTREE_PATH = _path("BRIDGE_KDTREE_PATH", "data/processed/indices/bridges_spatial_index.pkl")
PINCH_KDTREE_PATH = _path("PINCH_KDTREE_PATH", "data/processed/indices/hazard_pinch_points_spatial_index.pkl")
#: Built by scripts/build_road_index.py -- did not ship with the other three.
ROAD_KDTREE_PATH = _path("ROAD_KDTREE_PATH", "data/processed/indices/road_network_spatial_index.pkl")

#: The pinch-point index is 133 MB of per-vertex dicts and is not needed by
#: either endpoint -- it is a dashboard overlay. Off by default so the service
#: starts lean; set to 1 when the overlay is wired up.
LOAD_PINCH_INDEX = os.getenv("LOAD_PINCH_INDEX", "0") == "1"

# ------------------------------------------------------------------- terrain
TERRAIN_RASTER_DIR = _path("TERRAIN_RASTER_DIR", "data/raw/terrain")

# ------------------------------------------------------------------- weather
OPEN_METEO_URL = os.getenv("OPEN_METEO_URL", "https://api.open-meteo.com/v1/forecast")

#: Which 24/72-hour window the rainfall features describe.
#:
#:   'forecast'    the next N hours. What workflow section 5 needs -- the whole
#:                 point is to reroute before a truck is stuck.
#:   'antecedent'  the previous N hours. What physically triggers a landslide:
#:                 rain that has already fallen and saturated the slope.
#:
#: The training features' provenance is not recorded, so which of the two they
#: were built from is unknown (REVISION.md open question 7). Both windows come
#: back in one API call, so this is a config switch rather than a code change.
RAINFALL_WINDOW = os.getenv("RAINFALL_WINDOW", "forecast")
OPEN_METEO_TIMEOUT_S = float(os.getenv("OPEN_METEO_TIMEOUT_S", "10"))
#: Open-Meteo's grid is ~11 km, so caching on a 0.1 deg key costs no accuracy
#: and collapses a dispatcher sweeping a corridor into one upstream call.
WEATHER_CACHE_PRECISION = int(os.getenv("WEATHER_CACHE_PRECISION", "1"))
WEATHER_CACHE_TTL_S = float(os.getenv("WEATHER_CACHE_TTL_S", "900"))

# -------------------------------------------------------------------- vision
YOLO_WEIGHTS = _path("YOLO_WEIGHTS", "data/artifacts/vision/incident-yolov8n.pt")
YOLO_DATASET = _path("YOLO_DATASET", "data/raw/vision/incident-yolo")
#: Minimum top-1 confidence for a verdict to count as verified.
#:
#: MUST be greater than 1/len(YOLO_CLASSES) or it can never reject anything:
#: softmax top-1 over n classes is >= 1/n by construction, so the 0.45 that
#: was inherited from the 4-class spec became dead code the moment the model
#: dropped to 2 classes (top-1 >= 0.5 always). Validated at startup.
YOLO_CONF_THRESHOLD = float(os.getenv("YOLO_CONF_THRESHOLD", "0.75"))

#: Classes the CURRENT model emits. Three, not the dataset's four.
#:
#: NORMAL_TERRAIN is real now, and it is the class that makes the endpoint
#: safe. It is NOT the dataset's shipped NORMAL_TERRAIN label -- that one is
#: filename index arithmetic, verified noise on 1380/1380 labels. This one is
#: a separately sourced pool of ordinary ground-level photographs (see
#: scripts/fetch_normal_terrain.py), so the label means what it says.
#:
#: Why it had to exist: with two hazard classes the softmax sums to 1 and the
#: model has no way to answer "neither". Every upload was forced to be a flood
#: or a landslide, and a photograph of a footballer scored
#: ACTIVE_LANDSLIDE_DEBRIS at 1.000. That is a missing class, not a threshold
#: that needs tuning.
#:
#: DAMAGED_BRIDGE_INFRASTRUCTURE stays out: its labels are still arithmetic.
#: It remains in YOLO_CLASS_TO_INCIDENT_KIND so an older 4-class checkpoint
#: still maps rather than raising.
YOLO_CLASSES = [
    c.strip() for c in os.getenv(
        "YOLO_CLASSES",
        "FLOODED_ROAD_OR_SUBMERGED,ACTIVE_LANDSLIDE_DEBRIS,NORMAL_TERRAIN",
    ).split(",") if c.strip()
]

#: Every class name that has ever been trained, mapped to the value
#: `incidents.kind` accepts. Deliberately wider than YOLO_CLASSES so that a
#: previously-trained 4-class checkpoint still maps correctly instead of
#: falling through to None and silently refusing every incident.
#:
#: Mapping is always BY NAME, never by index: ImageFolder orders classes
#: alphabetically, which is a different order from the dataset's data.yaml.
#:
#: NORMAL_TERRAIN -> None on purpose: it means "no incident here" and must
#: never reach the edge-blocking path. A damaged bridge is an obstruction as
#: far as routing is concerned -- the edge is impassable either way.
YOLO_CLASS_TO_INCIDENT_KIND: dict[str, str | None] = {
    "NORMAL_TERRAIN": None,
    "FLOODED_ROAD_OR_SUBMERGED": "flood",
    "ACTIVE_LANDSLIDE_DEBRIS": "landslide",
    "DAMAGED_BRIDGE_INFRASTRUCTURE": "obstruction",
}

#: Require a dispatcher to confirm before a verdict may block a road edge.
#:
#: ON by default. There were two independent reasons, both measured. One is
#: now closed and one is not, so the gate stays.
#:
#:   1. CLOSED. The model had no "no incident" class, and the confidence
#:      threshold could not stand in for one -- held-out normal terrain came
#:      back as landslide at median confidence 0.794 against 0.786 for real
#:      landslides, distributions that no cutoff separates. NORMAL_TERRAIN is
#:      now a trained, content-derived class.
#:   2. STANDS. The hazard training images are aerial and satellite, while
#:      `/verify-incident` receives ground-level photographs from a driver's
#:      phone. The negative class is ground-level, but the two hazard classes
#:      are not, so a driver's photo of a REAL landslide is still out of
#:      distribution. Closing this needs ground-level NER hazard photographs,
#:      not more negatives. See REVISION.md Q8.
#:
#: So the model can now decline to see a hazard that is not there, which is
#: what reason 1 was about. It still cannot be trusted to recognise one that
#: is. Those are different claims, and only the first has been fixed.
#:
#: WEB-05 already specifies a dispatcher incident-review panel, so honouring
#: this costs no new UI.
INCIDENT_REQUIRE_REVIEW = os.getenv("INCIDENT_REQUIRE_REVIEW", "1") == "1"

# ---------------------------------------------------------------------- misc
SERVICE_NAME = "drishti-ai"
PORT = int(os.getenv("AI_SERVICE_PORT", "8000"))
