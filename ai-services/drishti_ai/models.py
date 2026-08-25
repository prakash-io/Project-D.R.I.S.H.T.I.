"""Model wrappers: the XGBoost hazard classifier and the YOLOv8 verifier.

Both are deliberately thin. The interesting decisions live here rather than in
the endpoints so the same behaviour is available to a test or a batch job.
"""

from __future__ import annotations

import concurrent.futures
import json
import multiprocessing
import pickle
from dataclasses import dataclass
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import xgboost as xgb

from . import config
from .geo import NearestIndex


# --------------------------------------------------------------- unpickling

class SpatialFeatureIndex:  # noqa: D101 - stub, see below
    pass


class LeanSpatialIndex:  # noqa: D101 - stub, see below
    pass


# The three shipped indices were pickled from a build script whose
# `SpatialFeatureIndex` class lived in `__main__`, so unpickling them needs a
# class of that name importable here. These stubs exist only to satisfy the
# pickle machinery -- the objects are read through `NearestIndex`, never used
# directly, so the stubs deliberately have no behaviour of their own.
def _install_pickle_stubs() -> None:
    import __main__

    for cls in (SpatialFeatureIndex, LeanSpatialIndex):
        if not hasattr(__main__, cls.__name__):
            setattr(__main__, cls.__name__, cls)


def load_index(name: str, path: Path) -> NearestIndex:
    """Load a pickled spatial index and wrap it, verifying its projection."""
    if not path.exists():
        raise FileNotFoundError(
            f"spatial index '{name}' not found at {path}. "
            f"The road index is built by scripts/build_road_index.py."
        )
    _install_pickle_stubs()
    with open(path, "rb") as fh:
        obj = pickle.load(fh)

    if hasattr(obj, "feature_records"):
        # Shipped format: one dict per indexed point, carrying lat/lon.
        lat = np.array([r["lat"] for r in obj.feature_records], dtype=np.float64)
        lon = np.array([r["lon"] for r in obj.feature_records], dtype=np.float64)
        records = obj.feature_records
    else:
        # Lean format from build_road_index.py: plain float32 arrays.
        lat = np.asarray(obj.lat, dtype=np.float64)
        lon = np.asarray(obj.lon, dtype=np.float64)
        records = None

    index = NearestIndex(name, obj.tree, lat, lon, records)
    # Fails startup if the artefact was rebuilt with a different projection,
    # which would otherwise show up only as quietly wrong distances.
    index.verify_projection()
    return index


# ------------------------------------------------------------- hazard model

@dataclass
class HazardPrediction:
    hazard_probability: float
    predicted_class: str
    class_probabilities: dict[str, float]
    high_risk: bool
    #: Features whose value fell outside the model's entire training support.
    #: A tree model does not extrapolate -- it returns the leaf for the edge
    #: of the range -- so these scores are pinned, not predicted.
    out_of_distribution: list[str] = None  # type: ignore[assignment]
    #: Features known not to correspond to what the service computes. See
    #: config.UNVALIDATED_FEATURES.
    unvalidated_features: list[str] = None  # type: ignore[assignment]


class HazardModel:
    """XGBoost 3-class classifier over the eight scaled terrain/rain features.

    The class order in `hazard_model_meta.json` is the output contract: column
    i of `predict` is `classes[i]`. It is read from the sidecar rather than
    hardcoded, and the feature order comes from the same file, so a retrain
    that changes either is picked up instead of silently permuting inputs.
    """

    def __init__(self, model_path: Path, scaler_path: Path):
        if not model_path.exists():
            raise FileNotFoundError(
                f"hazard model not found at {model_path}. "
                f"Train it with scripts/train_hazard_xgb.py."
            )
        self.booster = xgb.Booster()
        self.booster.load_model(str(model_path))
        self.scaler = joblib.load(scaler_path)

        meta_path = model_path.with_name(model_path.stem + "_meta.json")
        if not meta_path.exists():
            raise FileNotFoundError(
                f"{meta_path.name} is missing. It carries the feature and class "
                f"order, without which the model's output cannot be interpreted."
            )
        self.meta = json.loads(meta_path.read_text())
        self.features: list[str] = self.meta["features"]
        self.classes: list[str] = self.meta["classes"]
        self.best_iteration = int(self.meta.get("best_iteration", 0))
        # The model's own metadata is authoritative; config is only a fallback
        # for a checkpoint trained before the field existed.
        declared = self.meta.get("unvalidated_features")
        source = declared if declared is not None else config.UNVALIDATED_FEATURES
        self.unvalidated_features = [f for f in source if f in self.features]
        self.feature_source = self.meta.get("feature_source", "unknown")

        scaler_features = list(self.scaler.feature_names_in_)
        if scaler_features != self.features:
            raise ValueError(
                "feature order mismatch between the scaler and the model metadata.\n"
                f"  scaler: {scaler_features}\n  model : {self.features}\n"
                "Serving with these permuted would produce confident nonsense."
            )
        if self.safe_class_index is None:
            raise ValueError(f"no SAFE_TERRAIN class in {self.classes}")

    @property
    def safe_class_index(self) -> int | None:
        return self.classes.index("SAFE_TERRAIN") if "SAFE_TERRAIN" in self.classes else None

    def predict(self, raw_row: np.ndarray) -> HazardPrediction:
        """Scale a raw (1, 8) feature row and classify it."""
        # Named columns rather than a bare array: the scaler was fitted with
        # feature names, so sklearn validates the order for us and raises on a
        # mismatch. A bare array only warns, and a permuted one would not even
        # do that -- it would just return wrong numbers.
        frame = pd.DataFrame(raw_row, columns=self.features)
        scaled = self.scaler.transform(frame)
        dmatrix = xgb.DMatrix(scaled, feature_names=self.features)
        # Trees past `best_iteration` were fitted after early stopping said
        # the model had stopped improving; including them changes the answer
        # from the one the reported metrics were measured on.
        proba = self.booster.predict(
            dmatrix, iteration_range=(0, self.best_iteration + 1)
        )[0]

        probabilities = {name: float(p) for name, p in zip(self.classes, proba)}
        hazard_p = float(1.0 - proba[self.safe_class_index])
        return HazardPrediction(
            hazard_probability=hazard_p,
            predicted_class=self.classes[int(np.argmax(proba))],
            class_probabilities=probabilities,
            high_risk=hazard_p >= config.RISK_FLAG_THRESHOLD,
            out_of_distribution=self.out_of_distribution(scaled),
            unvalidated_features=self.unvalidated_features,
        )

    def out_of_distribution(self, scaled_row) -> list[str]:
        """Features outside the training support, in the scaler's own units.

        Gradient-boosted trees do not extrapolate: a value beyond the training
        range lands in the same leaf as the most extreme value ever seen, so
        the model returns a confident answer that carries no information about
        how far outside it was. Naming those features is the difference
        between a score that is wrong and a score that is wrong *and silent*.
        """
        ranges = self.meta.get("feature_training_range")
        if not ranges:
            return []
        row = np.asarray(scaled_row).reshape(-1)
        flagged = []
        for name, value in zip(self.features, row):
            bounds = ranges.get(name)
            if bounds is None:
                continue
            if value < bounds["min"] or value > bounds["max"]:
                flagged.append(name)
        return flagged


# ------------------------------------------------------------- vision model

@dataclass
class IncidentVerdict:
    verified: bool
    incident_kind: str | None
    predicted_class: str
    confidence: float
    class_probabilities: dict[str, float]
    reason: str
    #: True when a dispatcher must confirm before this may block a road edge.
    requires_human_review: bool = False
    review_reason: str | None = None


class IncidentVerifier:
    """YOLOv8-nano classifier for driver-uploaded incident photos (ML-05).

    Inference runs in a **spawned worker process**, not here. torch and
    xgboost cannot share a macOS process -- their OpenMP runtimes collide and
    one of them hangs or segfaults depending on import order. This class holds
    the pool and the decision logic; `vision_worker` holds everything that
    touches torch, and nothing in the parent ever imports it.

    The pool is created on first use, keeps a single warm worker, and is shut
    down with the app.
    """

    #: A cold worker pays the torch import plus the checkpoint load. Generous
    #: enough to cover that without letting a wedged worker hold the request
    #: open indefinitely -- the driver is waiting on this to report a landslide.
    FIRST_CALL_TIMEOUT_S = 120.0
    CALL_TIMEOUT_S = 30.0

    def __init__(self, weights_path: Path, classes: list[str], conf_threshold: float):
        self.weights_path = weights_path
        self.classes = classes
        self.conf_threshold = conf_threshold
        self._pool: concurrent.futures.ProcessPoolExecutor | None = None
        self._warm = False

    @property
    def available(self) -> bool:
        return self.weights_path.exists()

    def check_threshold(self, n_classes: int) -> str | None:
        """Warn if the confidence threshold cannot reject anything.

        Softmax top-1 over n classes is at least 1/n, so a threshold at or
        below 1/n never fires and the endpoint silently verifies everything
        the model is asked about. Returns a message when that is the case.
        """
        floor = 1.0 / max(n_classes, 1)
        if self.conf_threshold <= floor:
            return (
                f"YOLO_CONF_THRESHOLD={self.conf_threshold} can never reject a "
                f"prediction: with {n_classes} classes the top-1 confidence is "
                f"always >= {floor:.3f}. Raise it above {floor:.3f} or the "
                f"threshold is doing nothing."
            )
        return None

    def _ensure_pool(self) -> concurrent.futures.ProcessPoolExecutor:
        if self._pool is None:
            if not self.available:
                raise FileNotFoundError(
                    f"YOLO weights not found at {self.weights_path}. "
                    f"Train them with scripts/train_incident_yolo.py."
                )
            from . import vision_worker

            # `spawn`, not `fork`: a forked child inherits the parent's
            # already-loaded xgboost OpenMP runtime, which is exactly the
            # collision this exists to avoid.
            self._pool = concurrent.futures.ProcessPoolExecutor(
                max_workers=1,
                mp_context=multiprocessing.get_context("spawn"),
                initializer=vision_worker.init,
                initargs=(str(self.weights_path),),
            )
        return self._pool

    def shutdown(self) -> None:
        if self._pool is not None:
            self._pool.shutdown(wait=False, cancel_futures=True)
            self._pool = None
            self._warm = False

    def verify(self, image_bytes: bytes) -> IncidentVerdict:
        """Classify encoded image bytes. Blocking -- call it off the event loop."""
        from . import vision_worker

        pool = self._ensure_pool()
        timeout = self.CALL_TIMEOUT_S if self._warm else self.FIRST_CALL_TIMEOUT_S
        try:
            future = pool.submit(vision_worker.classify, image_bytes)
            result = future.result(timeout=timeout)
        except concurrent.futures.TimeoutError:
            # A wedged worker never recovers, and the executor would queue
            # every later request behind it. Drop the pool so the next call
            # starts a fresh one.
            self.shutdown()
            raise TimeoutError(
                f"vision worker did not answer within {timeout:.0f}s"
            ) from None
        except concurrent.futures.process.BrokenProcessPool as exc:
            # A worker that segfaults (which is exactly what the OpenMP
            # collision does) poisons its executor permanently: every
            # subsequent submit raises immediately. Without this the endpoint
            # would 500 forever after one crash, with no path back short of
            # restarting the service.
            self.shutdown()
            raise RuntimeError(
                f"vision worker died while classifying ({exc}); "
                f"the pool has been reset and the next request will retry"
            ) from exc
        self._warm = True

        probabilities = result["class_probabilities"]
        predicted = result["predicted_class"]
        confidence = result["confidence"]

        if predicted not in config.YOLO_CLASS_TO_INCIDENT_KIND:
            # An unmapped class would fall through to None and silently
            # refuse every incident. Fail loudly instead.
            raise ValueError(
                f"model emitted class {predicted!r}, which has no "
                f"incidents.kind mapping. Known: "
                f"{sorted(config.YOLO_CLASS_TO_INCIDENT_KIND)}"
            )
        kind = config.YOLO_CLASS_TO_INCIDENT_KIND[predicted]

        if predicted == "NORMAL_TERRAIN":
            reason = ("photo classified as normal terrain -- no incident to verify. "
                      "This must never block a road edge.")
            verified = False
        elif confidence < self.conf_threshold:
            reason = (f"top class {predicted} at {confidence:.3f} is below the "
                      f"{self.conf_threshold} confidence threshold")
            verified = False
        elif kind is None:
            reason = f"class {predicted} has no incidents.kind mapping"
            verified = False
        else:
            reason = f"verified as {predicted} at {confidence:.3f}"
            verified = True

        review_reason = None
        if verified and config.INCIDENT_REQUIRE_REVIEW:
            review_reason = (
                "the model has no 'no incident' class and was trained on aerial "
                "and satellite imagery, not ground-level driver photographs; a "
                "dispatcher must confirm before this blocks a road edge"
            )

        return IncidentVerdict(
            verified=verified,
            incident_kind=kind if verified else None,
            predicted_class=predicted,
            confidence=confidence,
            class_probabilities=probabilities,
            reason=reason,
            requires_human_review=bool(review_reason),
            review_reason=review_reason,
        )
