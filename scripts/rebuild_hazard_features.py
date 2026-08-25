#!/usr/bin/env python3
"""Re-derive slope_deg and aspect_deg from the terrain rasters (ML-04 fix).

    ai-services/.venv/bin/python scripts/rebuild_hazard_features.py

Writes `data/processed/landslide_rebuilt/`, which `train_hazard_xgb.py` then
trains from.

Why
---
The shipped feature table does not describe the coordinate it is attached to.
Re-deriving every feature through the serving pipeline at the training rows'
own lat/lon (REVISION.md R8) gives:

    elevation_m      corr  0.979   real
    dist_to_road_m   corr  0.999   real
    dist_to_river_m  corr  0.844   real
    slope_deg        corr  0.309   NOT the terrain slope
    aspect_deg       corr -0.018   uniform noise, KS p=0.33

`slope_deg` carries ~61% of the model's gain, so the input the model leaned on
hardest was one the service could not reproduce: it learned a
class-conditioned synthetic slope and was served a real raster slope. This
replaces those two columns with what the GeoTIFFs actually say at each
coordinate, so training and serving finally agree on the physical inputs.

The labels have to move with the feature
----------------------------------------
The labels were generated FROM the old slope, so replacing the feature and
keeping the label breaks the correspondence between them. Measured, that is
not a small effect -- it inverts the model:

    mean slope_deg per label   original (synthetic)   rebuilt, labels kept
    FLOOD_RISK                         1.4 deg               16.5 deg
    SAFE_TERRAIN                       8.1 deg               17.0 deg
    LANDSLIDE_RISK                    32.0 deg               27.6 deg

In the original the label tracks steepness, which is why a model trained on
synthetic slope still gave sensible answers when served a real one. With the
labels left in place the three classes become indistinguishable by slope
(real slope predicts the label at 0.545, down from 0.934) and the retrained
model called a 1.8 deg valley floor LANDSLIDE_RISK and a 23.5 deg ridge
FLOOD_RISK.

So the dataset's own labelling rule is recovered from the original data -- a
decision tree fitted on the ORIGINAL raw features against the ORIGINAL labels,
which is the generative rule, not an invention of mine -- and re-applied to
the rebuilt features. Thresholds come from the data; nothing is hand-chosen.

The result is still a synthetic demonstrator (REVISION.md Q6): the model
recovers a rule rather than forecasting landslides. But it is now a coherent
one, in which training and serving agree on the inputs AND the labels
describe the terrain those inputs measure. `--no-relabel` keeps the old
behaviour for comparison.

Rows that cannot be rebuilt
---------------------------
18.3% of the training coordinates fall outside every terrain sheet, so no
real slope exists for them. They are **dropped** rather than kept at their
synthetic values -- keeping them would leave the fabricated feature in the
training set, which is the entire thing being removed. Split membership is
otherwise preserved exactly, so train/val/test never mix.
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

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "ai-services"))

from sklearn.metrics import accuracy_score  # noqa: E402
from sklearn.tree import DecisionTreeClassifier, export_text  # noqa: E402

from drishti_ai import config  # noqa: E402
from drishti_ai.rasters import TerrainSampler  # noqa: E402

SPLIT_DIR = ROOT / "data" / "processed" / "landslide"
OUT_DIR = ROOT / "data" / "processed" / "landslide_rebuilt"

#: Columns replaced with raster samples. Only these two: elevation and the two
#: distances already reproduce, so rewriting them would add churn and risk
#: without changing what the model sees.
REBUILT = {"slope_deg": "slope_deg", "aspect_deg": "aspect_deg"}

SPLITS = ("train", "val", "test")

#: Depth of the tree used to recover the dataset's labelling rule. Deep enough
#: to reproduce it faithfully, shallow enough that it stays a rule rather than
#: memorising rows; the fidelity achieved is printed and recorded.
RULE_DEPTH = 6

CLASS_NAMES = {0: "SAFE_TERRAIN", 1: "LANDSLIDE_RISK", 2: "FLOOD_RISK"}


def recover_labelling_rule(split_dir: Path, features: list[str], scaler):
    """Fit the dataset's own feature -> label rule on the ORIGINAL data.

    Fitted on the original TRAIN split and scored on original val+test, so the
    reported fidelity is a held-out measure of how faithfully the rule was
    recovered rather than how well a tree can memorise.
    """
    def raw_of(split):
        X = pd.read_parquet(split_dir / f"X_{split}.parquet")
        y = pd.read_parquet(split_dir / f"y_{split}.parquet")
        raw = pd.DataFrame(scaler.inverse_transform(X[features].to_numpy()),
                           columns=features)
        return raw, y["hazard_type"].to_numpy()

    Xtr, ytr = raw_of("train")
    rule = DecisionTreeClassifier(max_depth=RULE_DEPTH, random_state=0).fit(Xtr, ytr)

    held_out = [raw_of(s) for s in ("val", "test")]
    Xho = pd.concat([h[0] for h in held_out], ignore_index=True)
    yho = np.concatenate([h[1] for h in held_out])
    fidelity = float(accuracy_score(yho, rule.predict(Xho)))
    return rule, fidelity


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--split-dir", type=Path, default=SPLIT_DIR)
    ap.add_argument("--no-relabel", action="store_true",
                    help="keep the original labels. They were generated from the "
                         "OLD synthetic slope, so leaving them attached to real "
                         "terrain produces a physically inverted model -- see the "
                         "module docstring.")
    ap.add_argument("--out", type=Path, default=OUT_DIR)
    args = ap.parse_args()

    t0 = time.time()
    scaler = joblib.load(config.FEATURE_SCALER_PATH)
    features = list(scaler.feature_names_in_)
    terrain = TerrainSampler(config.TERRAIN_RASTER_DIR)
    print(f"==> {terrain.sheet_count} terrain sheets, {len(features)} model features")

    rule = None
    rule_fidelity = None
    if not args.no_relabel:
        rule, rule_fidelity = recover_labelling_rule(args.split_dir, features, scaler)
        print(f"==> recovered the dataset's labelling rule "
              f"(depth-{RULE_DEPTH} tree, held-out fidelity {rule_fidelity:.4f})")
        print("    it will be re-applied to the rebuilt features")
    else:
        print("==> --no-relabel: keeping labels generated from the OLD slope; "
              "expect a physically inverted model")

    args.out.mkdir(parents=True, exist_ok=True)
    summary: dict = {}
    frames: dict = {}
    total_before = total_after = 0

    for split in SPLITS:
        X = pd.read_parquet(args.split_dir / f"X_{split}.parquet")
        y = pd.read_parquet(args.split_dir / f"y_{split}.parquet")
        if len(X) != len(y):
            sys.exit(f"error: X_{split} has {len(X)} rows, y_{split} has {len(y)}")

        # Back to real units so the rebuilt columns can be dropped in beside
        # the originals before the whole frame is re-scaled together.
        raw = pd.DataFrame(scaler.inverse_transform(X[features].to_numpy()),
                           columns=features)
        raw["latitude"] = X["latitude"].to_numpy()
        raw["longitude"] = X["longitude"].to_numpy()

        sampled = {name: [] for name in REBUILT}
        for lat, lon in zip(raw["latitude"], raw["longitude"]):
            layers = terrain.sample_all(float(lat), float(lon))
            for name in REBUILT:
                sampled[name].append(layers[name]["value"])

        rebuilt = pd.DataFrame(sampled)
        covered = rebuilt.notna().all(axis=1).to_numpy()

        before = len(raw)
        correlations = {
            name: float(pd.Series(raw.loc[covered, name].to_numpy())
                        .corr(pd.Series(rebuilt.loc[covered, name].to_numpy())))
            for name in REBUILT
        }

        for name in REBUILT:
            raw[name] = rebuilt[name]
        raw = raw[covered].reset_index(drop=True)
        y = y[covered].reset_index(drop=True)
        after = len(raw)
        total_before += before
        total_after += after

        # Re-scale the whole frame with the SAME scaler the service uses.
        # Not refitted: the service loads this exact artefact, so refitting
        # here would put training and serving back out of agreement -- which
        # is the problem being fixed. RobustScaler is affine and trees are
        # invariant to monotonic transforms, so a non-zero median on the
        # rebuilt columns costs nothing.
        scaled = pd.DataFrame(scaler.transform(raw[features]), columns=features)
        scaled["latitude"] = raw["latitude"].to_numpy()
        scaled["longitude"] = raw["longitude"].to_numpy()

        if rule is not None:
            # Re-apply the dataset's own rule to the rebuilt features, so the
            # label describes the terrain the features now measure.
            hazard_type = rule.predict(raw[features])
            y = pd.DataFrame({
                "is_hazard": (hazard_type != 0).astype(int),
                "hazard_type": hazard_type.astype(int),
                "hazard_label": [CLASS_NAMES[int(t)] for t in hazard_type],
            })

        frames[split] = (scaled, y)

        dropped = before - after
        dist = y["hazard_label"].value_counts().to_dict()
        summary[split] = {"rows_before": before, "rows_after": after,
                          "dropped_off_raster": dropped,
                          "old_vs_new_corr": correlations,
                          "class_distribution": dist}
        print(f"  {split:5} {before:6,} -> {after:6,} rows "
              f"({dropped:,} off-raster dropped)")
        for name, corr in correlations.items():
            print(f"        {name:<12} old vs new corr = {corr:+.3f}")
        print(f"        classes {dist}")

    terrain.close()

    # Replacing slope/aspect with raster samples collapses rows that differ
    # only in those two columns: neighbouring coordinates land in the same
    # 30 m pixel and become identical feature vectors. Some of those pairs
    # straddle the splits, which is leakage -- a test row the model has
    # already seen is not held out. The originals had none of this (checked),
    # so it is created by the rebuild and has to be undone by it.
    train_keys = set(pd.util.hash_pandas_object(frames["train"][0][features],
                                                index=False))
    leakage = {}
    for split in ("val", "test"):
        X_split, y_split = frames[split]
        keys = pd.util.hash_pandas_object(X_split[features], index=False)
        keep = ~keys.isin(train_keys).to_numpy()
        removed = int((~keep).sum())
        leakage[split] = removed
        if removed:
            frames[split] = (X_split[keep].reset_index(drop=True),
                             y_split[keep].reset_index(drop=True))
            summary[split]["rows_after"] = len(frames[split][0])
            summary[split]["dropped_leaked_into_train"] = removed
            total_after -= removed
        print(f"  {split:5} dropped {removed} row(s) whose feature vector "
              f"also appears in train")

    for split in SPLITS:
        X_split, y_split = frames[split]
        X_split.to_parquet(args.out / f"X_{split}.parquet", index=False)
        y_split.to_parquet(args.out / f"y_{split}.parquet", index=False)

    meta = {
        "leaked_rows_removed": leakage,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "source_split_dir": str(args.split_dir.relative_to(ROOT)),
        "rebuilt_columns": sorted(REBUILT),
        "relabelled": rule is not None,
        "rule_depth": RULE_DEPTH if rule is not None else None,
        "rule_holdout_fidelity": rule_fidelity,
        "rule": (export_text(rule, feature_names=list(features), decimals=2)
                 if rule is not None else None),
        "scaler_file": config.FEATURE_SCALER_PATH.name,
        "scaler_refitted": False,
        "rows_before": total_before,
        "rows_after": total_after,
        "splits": summary,
        "note": (
            "slope_deg and aspect_deg re-sampled from the terrain GeoTIFFs at "
            "each row's own lat/lon. The scaler was NOT refitted, so these two "
            "columns no longer have median 0 / IQR 1 -- that is expected and "
            "train_hazard_xgb.py exempts them. Labels remain synthetic and were "
            "generated from the OLD slope, so accuracy will fall."
        ),
    }
    (args.out / "rebuild_meta.json").write_text(json.dumps(meta, indent=2) + "\n")

    print(f"\n==> {total_before:,} -> {total_after:,} rows "
          f"({total_before - total_after:,} dropped, "
          f"{(total_before - total_after) / total_before:.1%})")
    print(f"==> wrote {args.out.relative_to(ROOT)}/ in {time.time() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
