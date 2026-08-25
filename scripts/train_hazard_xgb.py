#!/usr/bin/env python3
"""Train the landslide/flood hazard classifier (ML-04).

    ai-services/.venv/bin/python scripts/train_hazard_xgb.py

Reads the pre-split parquet in `data/processed/landslide/` and writes
`data/artifacts/risk/hazard_model.json` plus a sidecar
`hazard_model_meta.json` recording the exact feature order, class order and
held-out metrics.

Three things about this dataset are load-bearing and none of them are
self-evident from the file names:

1.  **X_*.parquet carries 10 columns; the model takes 8.** `latitude` and
    `longitude` are dropped. Keeping them would let the tree memorise *where*
    the training hazards were rather than *what* makes terrain hazardous --
    the positives come from a landslide-event catalogue, so raw coordinates
    are close to the label itself. It would also break inference outright:
    `feature_scaler.joblib` is fitted on exactly 8 features and raises on 10.

2.  **The eight feature columns are ALREADY SCALED.** They are RobustScaler
    output, not metres and degrees -- `elevation_m` has median 0.0 and range
    [-0.61, 6.46]. Only `latitude`/`longitude` are raw, which is what makes
    the file look unscaled at a glance. Re-applying the scaler here would
    centre already-centred data and train a model that disagrees with the
    service. `assert_prescaled` fails the run rather than let that happen
    silently.

3.  **The task is 3-class, not binary.** `y.hazard_type` is
    0=SAFE_TERRAIN, 1=LANDSLIDE_RISK, 2=FLOOD_RISK, and `y.is_hazard` is just
    `hazard_type != 0`. Training the 3-class model loses nothing -- binary
    hazard probability is recoverable as `1 - P(SAFE_TERRAIN)` -- and it
    resolves the open question of which probability the dashboard's 0.85
    threshold refers to by making both available at once.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.metrics import (accuracy_score, classification_report,
                             confusion_matrix, log_loss, roc_auc_score)
from sklearn.tree import DecisionTreeClassifier, export_text

ROOT = Path(__file__).resolve().parent.parent
SPLIT_DIR = ROOT / "data" / "processed" / "landslide"
#: Default. slope_deg/aspect_deg re-sampled from the GeoTIFFs so that training
#: and serving agree on the physical inputs -- see rebuild_hazard_features.py.
REBUILT_SPLIT_DIR = ROOT / "data" / "processed" / "landslide_rebuilt"
SCALER_PATH = ROOT / "data" / "artifacts" / "risk" / "feature_scaler.joblib"
OUT_MODEL = ROOT / "data" / "artifacts" / "risk" / "hazard_model.json"

# Dropped before training. See docstring note 1.
DROP_COLUMNS = ["latitude", "longitude"]

# Index position == class id in y.hazard_type. The order is the model's output
# contract: hazard_model.json emits P(class) in this order, and the API maps
# column i to CLASS_NAMES[i]. Reordering this relabels every prediction.
CLASS_NAMES = ["SAFE_TERRAIN", "LANDSLIDE_RISK", "FLOOD_RISK"]

PARAMS = {
    "objective": "multi:softprob",
    "num_class": len(CLASS_NAMES),
    "eval_metric": ["mlogloss", "merror"],
    "tree_method": "hist",
    "max_depth": 6,
    "eta": 0.05,
    "subsample": 0.8,
    "colsample_bytree": 0.8,
    "min_child_weight": 4,
    # The classes are near-balanced (5645/5691/4200), so no class weighting.
    # L2 only; the feature count is small enough that L1 sparsity buys nothing.
    "reg_lambda": 1.0,
    "seed": 20260825,
}
NUM_ROUNDS = 2000
EARLY_STOPPING = 60


def load_split(name: str, split_dir: Path) -> tuple[pd.DataFrame, pd.DataFrame]:
    X = pd.read_parquet(split_dir / f"X_{name}.parquet")
    y = pd.read_parquet(split_dir / f"y_{name}.parquet")
    if len(X) != len(y):
        sys.exit(f"error: X_{name} has {len(X)} rows but y_{name} has {len(y)}")
    return X, y


#: Physically possible ranges, in real units. Deliberately generous -- this
#: distinguishes "scaled" from "raw", not "plausible" from "unusual".
PHYSICAL_RANGE = {
    "elevation_m": (-500.0, 9000.0),
    "slope_deg": (0.0, 90.0),
    "aspect_deg": (0.0, 360.0),
    "dist_to_river_m": (0.0, 2_000_000.0),
    "dist_to_road_m": (0.0, 2_000_000.0),
    "rainfall_72h_mm": (0.0, 5_000.0),
    "rainfall_24h_mm": (0.0, 5_000.0),
    "rainfall_intensity_mmh": (0.0, 1_000.0),
}


def assert_prescaled(X: pd.DataFrame, features: list[str], scaler) -> None:
    """Fail loudly if the parquet holds raw units rather than scaler output.

    The obvious check -- median 0, IQR 1, which is what RobustScaler produces
    -- only holds for the exact rows the scaler was fitted on. It breaks the
    moment a subset is trained on: dropping the 19% of rows that fall off the
    terrain sheets shifts every surviving quantile, and a guard that fires on
    correctly-scaled data is a guard that gets deleted.

    This instead inverse-transforms and asks whether the result is physically
    possible. It is distribution-independent, so it survives subsetting, and
    it is far more decisive on the failure it exists to catch: a file that is
    already in raw units inverse-transforms `elevation_m` to roughly
    508 + 508 x 830 = 421,000 m, which is not a mountain.
    """
    raw = pd.DataFrame(scaler.inverse_transform(X[features].to_numpy()),
                       columns=features)
    problems = []
    for name in features:
        low, high = PHYSICAL_RANGE.get(name, (float("-inf"), float("inf")))
        column = raw[name]
        if column.min() < low or column.max() > high:
            problems.append(
                f"    {name}: inverse-transforms to "
                f"[{column.min():,.1f}, {column.max():,.1f}], outside the "
                f"physically possible [{low:,.1f}, {high:,.1f}]"
            )
    if problems:
        raise SystemExit(
            "error: these columns do not look like scaler output --\n"
            + "\n".join(problems)
            + "\n  If the split files were regenerated in RAW units, the scaler "
              "must be applied here AND the service's assumption revisited."
        )


def check_split_leakage(splits: dict[str, pd.DataFrame], features: list[str]) -> dict:
    """Count feature rows that appear in more than one split.

    The positives come from a landslide catalogue sampled on a grid, so exact
    duplicate feature vectors are plausible. Any that straddle train and test
    inflate the held-out numbers, so they get counted and reported rather than
    discovered later.
    """
    keys = {name: pd.util.hash_pandas_object(df[features], index=False)
            for name, df in splits.items()}
    train = set(keys["train"])
    return {
        "duplicate_rows_within_train": int(len(keys["train"]) - len(train)),
        "val_rows_also_in_train": int(sum(k in train for k in keys["val"])),
        "test_rows_also_in_train": int(sum(k in train for k in keys["test"])),
    }


def trivial_baseline(Xtr, ytr, Xte, yte, features: list[str]) -> dict:
    """How well a two-split decision tree does on the same task.

    This exists to stop the headline number being misread. The labels in this
    dataset are rule-generated from the features themselves, so a depth-2
    tree -- two thresholds on two features, something you could write as an
    `if` statement -- already reproduces most of them. Reporting XGBoost's
    accuracy without this next to it invites reading 0.99 as landslide
    forecasting skill, which it is not.

    Fitted on train only and scored on test, so it is a fair comparison.
    """
    rows = {}
    for depth in (1, 2, 3):
        tree = DecisionTreeClassifier(max_depth=depth, random_state=0).fit(Xtr, ytr)
        rows[f"depth_{depth}"] = float(accuracy_score(yte, tree.predict(Xte)))

    readable = DecisionTreeClassifier(max_depth=2, random_state=0).fit(Xtr, ytr)
    return {
        "test_accuracy": rows,
        "depth_2_rule": export_text(readable, feature_names=list(features), decimals=2),
        "note": ("thresholds are printed in SCALED units because the split "
                 "parquet is already RobustScaler output; inverse-transformed "
                 "they are slope_deg ~15 deg and dist_to_river_m ~800 m"),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=OUT_MODEL)
    ap.add_argument("--split-dir", type=Path, default=REBUILT_SPLIT_DIR,
                    help="defaults to the raster-rebuilt splits; pass "
                         "data/processed/landslide for the original synthetic ones")
    args = ap.parse_args()

    split_dir = args.split_dir
    if not (split_dir / "X_train.parquet").exists():
        sys.exit(f"error: no splits in {split_dir}. "
                 f"Run scripts/rebuild_hazard_features.py first.")

    # Written by rebuild_hazard_features.py; absent for the original splits.
    rebuild_meta_path = split_dir / "rebuild_meta.json"
    rebuild_meta = (json.loads(rebuild_meta_path.read_text())
                    if rebuild_meta_path.exists() else None)
    rebuilt_columns = rebuild_meta["rebuilt_columns"] if rebuild_meta else []

    t0 = time.time()

    scaler = joblib.load(SCALER_PATH)
    features = list(scaler.feature_names_in_)
    print(f"==> scaler: {type(scaler).__name__} over {scaler.n_features_in_} features")

    print(f"==> splits from {split_dir.relative_to(ROOT)}")
    if rebuilt_columns:
        print(f"    {rebuilt_columns} re-sampled from the terrain rasters; "
              f"{rebuild_meta['rows_before']:,} -> {rebuild_meta['rows_after']:,} rows")
    else:
        print("    WARNING: original splits -- slope_deg correlates 0.309 with the "
              "terrain the service samples and aspect_deg is uniform noise.")

    Xtr, ytr = load_split("train", split_dir)
    Xva, yva = load_split("val", split_dir)
    Xte, yte = load_split("test", split_dir)

    # The feature order must come from the scaler, not from the parquet: at
    # inference the service builds a raw vector, scales it, and predicts. If
    # training used the parquet's column order and it differed from the
    # scaler's, every served prediction would silently use permuted features.
    dropped = [c for c in Xtr.columns if c in DROP_COLUMNS]
    extra = [c for c in Xtr.columns if c not in DROP_COLUMNS and c not in features]
    missing = [c for c in features if c not in Xtr.columns]
    if missing:
        sys.exit(f"error: split files are missing scaler features {missing}")
    if extra:
        sys.exit(f"error: unexpected columns {extra} -- not in the scaler and not dropped")
    print(f"==> dropping {dropped} -> {len(features)} features: {features}")

    assert_prescaled(Xtr, features, scaler)
    print("==> verified: feature columns inverse-transform to physically "
          "possible values -- they are scaler output, not raw units"
          + (f"; {rebuilt_columns} re-sampled from rasters"
             if rebuilt_columns else ""))

    leakage = check_split_leakage({"train": Xtr, "val": Xva, "test": Xte}, features)
    print(f"==> split overlap: {leakage}")

    Xtr, Xva, Xte = Xtr[features], Xva[features], Xte[features]
    ytr_c = ytr["hazard_type"].to_numpy()
    yva_c = yva["hazard_type"].to_numpy()
    yte_c = yte["hazard_type"].to_numpy()

    dtrain = xgb.DMatrix(Xtr, label=ytr_c, feature_names=features)
    dval = xgb.DMatrix(Xva, label=yva_c, feature_names=features)
    dtest = xgb.DMatrix(Xte, label=yte_c, feature_names=features)

    print(f"==> training on {len(Xtr):,} rows, early stopping on val mlogloss")
    evals_result: dict = {}
    booster = xgb.train(
        PARAMS, dtrain, num_boost_round=NUM_ROUNDS,
        evals=[(dtrain, "train"), (dval, "val")],
        early_stopping_rounds=EARLY_STOPPING,
        evals_result=evals_result,
        verbose_eval=100,
    )
    print(f"==> best iteration {booster.best_iteration} "
          f"(val mlogloss {booster.best_score:.5f})")

    proba = booster.predict(dtest, iteration_range=(0, booster.best_iteration + 1))
    pred = proba.argmax(axis=1)
    hazard_p = 1.0 - proba[:, CLASS_NAMES.index("SAFE_TERRAIN")]
    landslide_p = proba[:, CLASS_NAMES.index("LANDSLIDE_RISK")]
    is_hazard = (yte_c != 0).astype(int)
    is_landslide = (yte_c == 1).astype(int)

    print("\n" + "=" * 62)
    print("HELD-OUT TEST RESULTS  (n = {:,})".format(len(yte_c)))
    print("=" * 62)
    print(f"3-class accuracy : {accuracy_score(yte_c, pred):.4f}")
    print(f"3-class logloss  : {log_loss(yte_c, proba, labels=[0, 1, 2]):.4f}")
    print(classification_report(yte_c, pred, target_names=CLASS_NAMES, digits=4))
    print("confusion matrix (rows = truth, cols = predicted)")
    cm = confusion_matrix(yte_c, pred, labels=[0, 1, 2])
    print("            " + "".join(f"{c:>22}" for c in CLASS_NAMES))
    for name, row in zip(CLASS_NAMES, cm):
        print(f"{name:>12}" + "".join(f"{v:>22,}" for v in row))

    auc_hazard = roc_auc_score(is_hazard, hazard_p)
    auc_landslide = roc_auc_score(is_landslide, landslide_p)
    print(f"\nROC-AUC  P(hazard) = 1 - P(SAFE_TERRAIN) : {auc_hazard:.4f}")
    print(f"ROC-AUC  P(LANDSLIDE_RISK)               : {auc_landslide:.4f}")

    # RISK_FLAG_THRESHOLD in .env.example is 0.85 and drives WEB-04's red
    # segments, so its operating point is reported explicitly rather than
    # left for someone to rediscover from a ROC curve.
    print("\noperating point of the 0.85 dashboard threshold:")
    thresholds = {}
    for label, score, truth in (("P(hazard)", hazard_p, is_hazard),
                                ("P(landslide)", landslide_p, is_landslide)):
        flag = score >= 0.85
        tp = int((flag & (truth == 1)).sum())
        fp = int((flag & (truth == 0)).sum())
        fn = int((~flag & (truth == 1)).sum())
        prec = tp / (tp + fp) if tp + fp else float("nan")
        rec = tp / (tp + fn) if tp + fn else float("nan")
        print(f"  {label:<14} flagged {flag.sum():>5,}/{len(flag):,}  "
              f"precision {prec:.4f}  recall {rec:.4f}")
        thresholds[label] = {"flagged": int(flag.sum()), "precision": prec, "recall": rec}

    trivial = trivial_baseline(Xtr, ytr_c, Xte, yte_c, features)

    gain = booster.get_score(importance_type="gain")
    total = sum(gain.values()) or 1.0
    print("\n" + "=" * 62)
    print("HOW MUCH OF THIS IS THE MODEL, AND HOW MUCH IS THE DATA?")
    print("=" * 62)
    print("A shallow decision tree on the same 8 features, fitted on train,")
    print("scored on the same test rows:")
    for depth, score in trivial["test_accuracy"].items():
        print(f"  {depth.replace('_', '-'):<10} tree   accuracy {score:.4f}")
    print(f"  xgboost ({booster.best_iteration + 1} trees)  accuracy "
          f"{accuracy_score(yte_c, pred):.4f}")
    print("\nThe labels are generated by thresholding these features, so most of")
    print("the accuracy is rule-recovery, not hazard prediction. The depth-2 rule:")
    print(trivial["depth_2_rule"])

    print("\nfeature importance (gain, normalised)")
    for f, g in sorted(gain.items(), key=lambda kv: -kv[1]):
        print(f"  {f:<24} {g / total:6.2%}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    booster.save_model(args.out)

    meta = {
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "model_file": args.out.name,
        "xgboost_version": xgb.__version__,
        "objective": PARAMS["objective"],
        # The service MUST build its feature vector in this order.
        "features": features,
        "dropped_columns": DROP_COLUMNS,
        "features_are_prescaled_in_parquet": True,
        "split_dir": str(split_dir.relative_to(ROOT)),
        "feature_source": "rebuilt_from_rasters" if rebuilt_columns else "as_shipped",
        "rebuilt_columns": rebuilt_columns,
        # Read by HazardModel and surfaced on every response. Empty once the
        # features the service computes are the ones the model trained on.
        "unvalidated_features": [] if rebuilt_columns else ["slope_deg", "aspect_deg"],
        "scaler_file": SCALER_PATH.name,
        "scaler_type": type(scaler).__name__,
        "classes": CLASS_NAMES,
        "best_iteration": int(booster.best_iteration),
        "best_val_mlogloss": float(booster.best_score),
        "params": PARAMS,
        "split_overlap": leakage,
        "test": {
            "n": int(len(yte_c)),
            "accuracy": float(accuracy_score(yte_c, pred)),
            "logloss": float(log_loss(yte_c, proba, labels=[0, 1, 2])),
            "roc_auc_hazard": float(auc_hazard),
            "roc_auc_landslide": float(auc_landslide),
            "confusion_matrix": cm.tolist(),
            "report": classification_report(yte_c, pred, target_names=CLASS_NAMES,
                                            output_dict=True, digits=4),
            "threshold_0_85": thresholds,
        },
        "feature_importance_gain": {k: v / total for k, v in
                                    sorted(gain.items(), key=lambda kv: -kv[1])},
        "trivial_baseline": trivial,
        # Serving-time out-of-distribution guard. The model is served with
        # features rebuilt from live rasters and KDTrees, which are NOT the
        # same numbers the training columns hold for the same coordinate --
        # `slope_deg` correlates only 0.31 with the terrain rasters and
        # `aspect_deg` is uniform noise (see REVISION.md R8). Recording the
        # training support lets the service say when an input is outside
        # anything it ever saw instead of extrapolating in silence.
        "feature_training_range": {
            name: {
                "min": float(Xtr[name].min()),
                "p01": float(Xtr[name].quantile(0.01)),
                "p50": float(Xtr[name].median()),
                "p99": float(Xtr[name].quantile(0.99)),
                "max": float(Xtr[name].max()),
            }
            for name in features
        },
    }
    meta_path = args.out.with_name(args.out.stem + "_meta.json")
    meta_path.write_text(json.dumps(meta, indent=2, default=float) + "\n")

    print(f"\n==> wrote {args.out.relative_to(ROOT)} "
          f"({args.out.stat().st_size / 1024:.0f} KB)")
    print(f"==> wrote {meta_path.relative_to(ROOT)}")
    print(f"==> total {time.time() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
