#!/usr/bin/env python3
"""Train the IDR forward-speed model (MOB-05) on IO-VNBD.

Maps a 5-second window of smartphone IMU (3-axis accelerometer + 3-axis
gyroscope, 10 Hz) to the vehicle's forward speed in m/s. The prediction is
the velocity input to the C++ EKF during a GNSS blackout, where no GPS fix
is available and dead reckoning is the only source of position.

    python scripts/train_idr_speed.py --data-root data/raw/imu/IO-VNBD
    python scripts/train_idr_speed.py --epochs 60 --stride 3
    python scripts/train_idr_speed.py --limit-sessions 4   # fast smoke run

Outputs, all under data/artifacts/edge/:
    speed_model.tflite        full-int8 model, bundled into the app binary
    speed_model_float.tflite  float fallback, for accuracy comparison
    speed_model.keras         the unquantised Keras model
    speed_model_meta.json     normalisation + quantisation params for C++

Three things about this dataset that are not obvious, all verified against
the files rather than the paper:

  1. The smartphone column `GPS SPEED (Kmh)` is actually in **m/s** -- the
     median V/S ratio is 3.58, i.e. 3.6. It is also only ~0.84 correlated
     with the vehicle's own velocity. We take the target from the vehicle
     file instead, which is correctly labelled km/hr.

  2. S- and V- files for a session are row-aligned: identical row counts,
     both resampled to 10 Hz. A positional join is correct; no timestamp
     merge is needed. This is asserted at load time rather than assumed.

  3. `ACCELEROMETER *` still contains gravity (Z averages ~9.85). The phone
     orientation in the vehicle is arbitrary and not recorded, so the model
     has to learn to be robust to a constant per-session offset. Gravity is
     deliberately NOT subtracted -- the separate GRAVITY columns come from
     Android's fused sensor, which the C++ edge path does not have.

Splitting is by **session**, never by window. Consecutive windows overlap and
come from the same drive, so a random split leaks the target and reports an
R^2 that collapses in the field.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import OrderedDict
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA = ROOT / "data" / "raw" / "imu" / "IO-VNBD"
OUT_DIR = ROOT / "data" / "artifacts" / "edge"

# Smartphone feature channels, in the exact order the C++ bridge feeds them.
# Changing this order silently invalidates every exported model.
#
# Matched by pattern rather than by literal name, for two reasons:
#
#   * The two halves of the dataset name the same three gyro channels
#     differently -- "GYROSCOPE Yaw/Pitch/Roll" under Categorised, but
#     "GYROSCOPE X/Y/Z" under Uncategorised. They are the same columns in the
#     same positions (15, 16, 17); only the header text differs.
#   * The unit suffixes carry non-ASCII (m/s², µT, °) whose byte encoding is
#     not consistent across files. Anchoring on the ASCII prefix avoids
#     depending on how a given file spells its superscript.
FEATURE_PATTERNS = [
    r"^ACCELEROMETER\s+X\b",
    r"^ACCELEROMETER\s+Y\b",
    r"^ACCELEROMETER\s+Z\b",
    r"^GYROSCOPE\s+(?:Yaw|X)\b",
    r"^GYROSCOPE\s+(?:Pitch|Y)\b",
    r"^GYROSCOPE\s+(?:Roll|Z)\b",
]
FEATURE_NAMES = ["ax", "ay", "az", "gyro_yaw", "gyro_pitch", "gyro_roll"]
TARGET_PATTERN = r"^Velocity\s*\(km/hr\)"   # from the V- (vehicle) file
KMH_TO_MS = 1.0 / 3.6


def resolve_columns(columns: list[str], patterns: list[str]) -> list[str] | None:
    """Map each pattern to exactly one column, preserving pattern order.

    Returns None if any pattern matches zero or more than one column — an
    ambiguous match must fail loudly, because silently taking the first hit
    would put the wrong physical channel in a feature slot and the model would
    still train.
    """
    resolved: list[str] = []
    for pat in patterns:
        hits = [c for c in columns if re.match(pat, c, flags=re.IGNORECASE)]
        if len(hits) != 1:
            return None
        resolved.append(hits[0])
    return resolved

WINDOW = 50          # 50 samples @ 10 Hz = 5 s of context
N_FEATURES = len(FEATURE_PATTERNS)


# --------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------

def _read_csv(path: Path) -> pd.DataFrame:
    """Read one IO-VNBD CSV.

    The files are UTF-8 but carry degree signs and superscripts that trip a
    strict decode on some rows, so fall back to latin-1 rather than dropping
    the session. Column names carry leading spaces in the headers.
    """
    for encoding in ("utf-8", "latin-1"):
        try:
            df = pd.read_csv(path, encoding=encoding, low_memory=False)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise UnicodeDecodeError(f"could not decode {path}")

    df.columns = [c.strip() for c in df.columns]
    return df


def find_sessions(data_root: Path) -> "OrderedDict[str, tuple[Path, Path]]":
    """Pair every S-<name>.csv with its V-<name>.csv under the synchronised tree.

    Only the synchronised half of the dataset is usable here: the
    unsynchronised S and V recordings are not row-aligned, so there is no
    correct way to attach a vehicle velocity to a phone IMU window.

    Two traps in the file naming, both of which quietly shrink or corrupt the
    training set rather than raising:

      1. Case is inconsistent between the two halves -- the phone files are
         `S-Vta10.csv` but the vehicle files are `V-vta10.csv`. Matching
         case-sensitively pairs only 32 of 72 sessions and silently discards
         the rest. Keys are casefolded.

      2. Every session appears TWICE, once under `Uncategorised/{S,V}-Dataset/`
         and again under `Categorised/<driver>/<session>/`, at slightly
         different lengths (the categorised copies are trimmed). Loading both
         puts the same drive in two splits, which leaks the target and inflates
         the held-out score. We keep the uncategorised copy: it is the full
         recording, and one consistent choice is what makes the split honest.
    """
    sync_root = data_root / "Synchronised V abd S datasets"
    if not sync_root.is_dir():
        sys.exit(
            f"synchronised tree not found at {sync_root}\n"
            "Clone with LFS: git lfs install && "
            "git clone https://github.com/onyekpeu/IO-VNBD"
        )

    def is_uncategorised(path: Path) -> bool:
        # Substring, not `in path.parts`: the directory is named
        # "Uncategorised IOVNB Dataset", so an equality test against a whole
        # path component never matches. "Categorised" is not a substring of
        # "Uncategorised" (case differs), so this stays unambiguous.
        return any("Uncategorised" in part for part in path.parts)

    def preferred(existing: Path, candidate: Path) -> Path:
        """Uncategorised wins; it is the untrimmed recording."""
        return candidate if is_uncategorised(candidate) else existing

    phone: dict[str, Path] = {}
    vehicle: dict[str, Path] = {}
    for path in sync_root.rglob("*.csv"):
        m = re.match(r"^([SV])-(.+)\.csv$", path.name)
        if not m:
            continue
        table = phone if m.group(1) == "S" else vehicle
        key = m.group(2).casefold()
        table[key] = preferred(table[key], path) if key in table else path

    paired = OrderedDict(
        (s, (phone[s], vehicle[s])) for s in sorted(phone) if s in vehicle
    )
    if not paired:
        sys.exit(f"no S-/V- pairs found under {sync_root}")

    orphans = set(phone) ^ set(vehicle)
    if orphans:
        print(f"  note: {len(orphans)} unpaired session(s) skipped: "
              f"{', '.join(sorted(orphans)[:6])}"
              f"{' ...' if len(orphans) > 6 else ''}")
    return paired


def load_session(s_path: Path, v_path: Path) -> tuple[np.ndarray, np.ndarray] | None:
    """Return (features[n,6], speed_ms[n]) for one drive, or None if unusable."""
    s = _read_csv(s_path)
    v = _read_csv(v_path)

    feature_cols = resolve_columns(list(s.columns), FEATURE_PATTERNS)
    target_cols = resolve_columns(list(v.columns), [TARGET_PATTERN])
    if feature_cols is None:
        print(f"  skip {s_path.name}: cannot resolve the 6 IMU channels")
        return None
    if target_cols is None:
        print(f"  skip {v_path.name}: cannot resolve the velocity column")
        return None
    target_col = target_cols[0]

    # The synchronised pairs are row-aligned by construction. Trim rather than
    # interpolate if they ever disagree -- a silent off-by-N would shift every
    # target relative to its window.
    n = min(len(s), len(v))
    if len(s) != len(v):
        print(f"  note {s_path.name}: row mismatch {len(s)} vs {len(v)}, "
              f"trimming to {n}")
    if n <= WINDOW:
        return None

    X = s.loc[: n - 1, feature_cols].to_numpy(dtype=np.float32)
    y = v.loc[: n - 1, target_col].to_numpy(dtype=np.float32) * KMH_TO_MS

    # Drop rows where any channel or the target is absent. Interpolating IMU
    # gaps would invent motion that never happened.
    ok = np.isfinite(X).all(axis=1) & np.isfinite(y)
    if ok.sum() <= WINDOW:
        return None
    return X[ok], y[ok]


def make_windows(X: np.ndarray, y: np.ndarray, stride: int
                 ) -> tuple[np.ndarray, np.ndarray]:
    """Rolling windows of WINDOW timesteps, target = speed at the LAST step.

    Causal on purpose: at inference the app has the preceding 5 seconds and
    needs the speed *now*. Targeting the window centre would need future
    samples and could not be reproduced on-device.
    """
    n_windows = (len(X) - WINDOW) // stride + 1
    if n_windows <= 0:
        return np.empty((0, WINDOW, N_FEATURES), np.float32), np.empty((0,), np.float32)

    idx = np.arange(n_windows) * stride
    windows = np.stack([X[i:i + WINDOW] for i in idx]).astype(np.float32)
    targets = y[idx + WINDOW - 1].astype(np.float32)
    return windows, targets


# --------------------------------------------------------------------------
# Model
# --------------------------------------------------------------------------

def stratified_sample(y: np.ndarray, n: int, bins: int,
                      rng: np.random.Generator) -> np.ndarray:
    """Indices spread evenly across the range of `y`, not across its density.

    Guarantees the extremes are present: the calibration set decides the
    quantised output range, and anything the converter never sees becomes a
    clipping ceiling at inference time.
    """
    edges = np.linspace(y.min(), y.max(), bins + 1)
    per_bin = max(1, n // bins)
    picked: list[np.ndarray] = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        # Closed on the right for the last bin so y.max() is never dropped.
        members = np.flatnonzero((y >= lo) & (y <= hi if hi == edges[-1] else y < hi))
        if members.size == 0:
            continue
        take = min(per_bin, members.size)
        picked.append(rng.choice(members, size=take, replace=False))
    if not picked:
        return rng.choice(len(y), size=n)
    # Pin the true extremes. Sampling *within* the end bins still leaves the
    # converter a range slightly narrower than the data, and the ceiling it
    # picks is a hard clip -- so hand it the actual endpoints.
    extremes = np.array([int(np.argmin(y)), int(np.argmax(y))])
    return np.unique(np.concatenate([*picked, extremes]))


def build_model(keras):
    """Small 1D-CNN. Kept deliberately narrow -- this runs on a phone CPU
    inside a navigation loop, alongside the EKF."""
    L = keras.layers
    return keras.Sequential([
        L.Input(shape=(WINDOW, N_FEATURES), name="imu_window"),

        L.Conv1D(32, 5, padding="same", activation="relu"),
        L.MaxPooling1D(2),                       # 50 -> 25

        L.Conv1D(64, 3, padding="same", activation="relu"),
        L.MaxPooling1D(2),                       # 25 -> 12

        L.Conv1D(64, 3, padding="same", activation="relu"),
        L.GlobalAveragePooling1D(),              # order-agnostic, keeps params low

        L.Dropout(0.3),
        L.Dense(32, activation="relu"),
        L.Dropout(0.2),
        # Linear: speed is a continuous, unbounded regression target. A relu
        # here would pin every underestimate to exactly 0 and kill the gradient.
        L.Dense(1, activation="linear", name="speed_ms"),
    ], name="idr_speed_cnn")


def convert_tflite(tf, model, rep_windows: np.ndarray, out_dir: Path) -> dict:
    """Emit a float16-weight model and a fully-integer-quantised model.

    `Optimize.DEFAULT` alone gives *dynamic-range* quantisation: int8 weights
    but float activations, and a float32 input tensor. That is not what the
    C++ bridge wants. Supplying a representative dataset and pinning
    inference_input/output_type to int8 gives a genuinely full-integer graph,
    which is what makes the model cheap enough to run every EKF tick.
    """
    float_path = out_dir / "speed_model_float.tflite"
    conv = tf.lite.TFLiteConverter.from_keras_model(model)
    conv.optimizations = [tf.lite.Optimize.DEFAULT]
    float_path.write_bytes(conv.convert())

    def representative_dataset():
        # A few hundred real windows is enough to fix the activation ranges;
        # feeding synthetic noise here produces a valid model that scores
        # badly, which is the hardest failure of the two to notice.
        for w in rep_windows:
            yield [w.reshape(1, WINDOW, N_FEATURES).astype(np.float32)]

    int_path = out_dir / "speed_model.tflite"
    conv = tf.lite.TFLiteConverter.from_keras_model(model)
    conv.optimizations = [tf.lite.Optimize.DEFAULT]
    conv.representative_dataset = representative_dataset
    conv.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS_INT8]
    conv.inference_input_type = tf.int8
    conv.inference_output_type = tf.int8
    int_path.write_bytes(conv.convert())

    # The C++ side must de/quantise by hand, so the scales travel with the model.
    interp = tf.lite.Interpreter(model_path=str(int_path))
    interp.allocate_tensors()
    inp, out = interp.get_input_details()[0], interp.get_output_details()[0]
    return {
        "int8_model": int_path.name,
        "float_model": float_path.name,
        "int8_bytes": int_path.stat().st_size,
        "float_bytes": float_path.stat().st_size,
        "input_quantization": {
            "scale": float(inp["quantization"][0]),
            "zero_point": int(inp["quantization"][1]),
            "dtype": str(np.dtype(inp["dtype"])),
        },
        "output_quantization": {
            "scale": float(out["quantization"][0]),
            "zero_point": int(out["quantization"][1]),
            "dtype": str(np.dtype(out["dtype"])),
        },
    }


# --------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-root", type=Path, default=DEFAULT_DATA)
    ap.add_argument("--out-dir", type=Path, default=OUT_DIR)
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch-size", type=int, default=256)
    ap.add_argument("--stride", type=int, default=5,
                    help="window hop. 1 keeps every window but they overlap 98%%")
    ap.add_argument("--limit-sessions", type=int, default=0,
                    help="use only the first N sessions (smoke test)")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    np.random.seed(args.seed)
    args.out_dir.mkdir(parents=True, exist_ok=True)

    # TF is imported late so --help works without a 2-second import.
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
    import tensorflow as tf
    from tensorflow import keras
    tf.random.set_seed(args.seed)

    print(f"tensorflow {tf.__version__}\n")

    sessions = find_sessions(args.data_root)
    if args.limit_sessions:
        sessions = OrderedDict(list(sessions.items())[: args.limit_sessions])
    print(f"found {len(sessions)} paired session(s)\n")

    # --- split by session, before any windowing --------------------------
    names = list(sessions)
    rng = np.random.default_rng(args.seed)
    rng.shuffle(names)
    n_test = max(1, round(0.15 * len(names)))
    n_val = max(1, round(0.15 * len(names)))
    if len(names) < 3:
        sys.exit("need at least 3 sessions for a session-level split")
    split = {
        "test": set(names[:n_test]),
        "val": set(names[n_test:n_test + n_val]),
        "train": set(names[n_test + n_val:]),
    }

    data: dict[str, list] = {"train": [], "val": [], "test": []}
    for name, (s_path, v_path) in sessions.items():
        part = next(p for p in split if name in split[p])
        loaded = load_session(s_path, v_path)
        if loaded is None:
            continue
        X, y = loaded
        # Stride 1 for val/test: evaluate on every window, not a subsample.
        w, t = make_windows(X, y, args.stride if part == "train" else 1)
        if len(w):
            data[part].append((w, t))
        print(f"  {part:5s}  {name:22s} {len(X):7d} rows -> {len(w):6d} windows")

    out = {}
    for part in ("train", "val", "test"):
        if not data[part]:
            sys.exit(f"no usable windows in the {part} split")
        out[part] = (np.concatenate([w for w, _ in data[part]]),
                     np.concatenate([t for _, t in data[part]]))
    (Xtr, ytr), (Xva, yva), (Xte, yte) = out["train"], out["val"], out["test"]

    # --- normalise using TRAIN statistics only ---------------------------
    # Fitting on everything leaks test-set distribution into the model, and
    # the C++ side has to reproduce these exact constants anyway.
    mean = Xtr.reshape(-1, N_FEATURES).mean(axis=0)
    std = Xtr.reshape(-1, N_FEATURES).std(axis=0)
    std[std < 1e-6] = 1.0                       # a dead channel must not divide by ~0

    def norm(a):
        return ((a - mean) / std).astype(np.float32)

    Xtr, Xva, Xte = norm(Xtr), norm(Xva), norm(Xte)

    print(f"\nwindows  train={len(Xtr):,}  val={len(Xva):,}  test={len(Xte):,}")
    print(f"target m/s  mean={ytr.mean():.2f}  std={ytr.std():.2f}  "
          f"max={ytr.max():.2f}")

    model = build_model(keras)
    model.compile(optimizer=keras.optimizers.Adam(1e-3),
                  loss="mse", metrics=["mae"])
    model.summary()

    hist = model.fit(
        Xtr, ytr,
        validation_data=(Xva, yva),
        epochs=args.epochs,
        batch_size=args.batch_size,
        verbose=2,
        callbacks=[
            keras.callbacks.EarlyStopping(monitor="val_loss", patience=8,
                                          restore_best_weights=True),
            keras.callbacks.ReduceLROnPlateau(monitor="val_loss", factor=0.5,
                                              patience=4, min_lr=1e-5),
        ],
    )

    # --- evaluate --------------------------------------------------------
    pred = model.predict(Xte, batch_size=args.batch_size, verbose=0).ravel()
    mae = float(np.mean(np.abs(pred - yte)))
    rmse = float(np.sqrt(np.mean((pred - yte) ** 2)))
    ss_res = float(np.sum((yte - pred) ** 2))
    ss_tot = float(np.sum((yte - yte.mean()) ** 2))
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else float("nan")
    # Predicting the training mean is the bar any useful model must clear.
    baseline_mae = float(np.mean(np.abs(ytr.mean() - yte)))

    print(f"\nheld-out sessions ({len(split['test'])}): {sorted(split['test'])}")
    print(f"  MAE   {mae:6.3f} m/s   ({mae * 3.6:5.2f} km/h)")
    print(f"  RMSE  {rmse:6.3f} m/s")
    print(f"  R^2   {r2:6.3f}")
    print(f"  baseline MAE (predict train mean): {baseline_mae:.3f} m/s")

    keras_path = args.out_dir / "speed_model.keras"
    model.save(keras_path)

    # --- quantise --------------------------------------------------------
    # Stratify the calibration sample across the speed range, rather than
    # sampling uniformly at random. TFLite fixes the output tensor's range from
    # whatever these windows produce; a uniform draw is dominated by the common
    # mid-range speeds, leaves the fast tail unrepresented, and the resulting
    # graph then *clips* every speed above the highest it was shown. That
    # clipping is invisible in aggregate MAE but is exactly wrong at the speeds
    # where dead-reckoning error accumulates fastest.
    rep_idx = stratified_sample(ytr, n=1000, bins=20, rng=rng)
    print(f"calibration windows: {len(rep_idx)}, "
          f"speed range {ytr[rep_idx].min():.1f}..{ytr[rep_idx].max():.1f} m/s "
          f"(train range {ytr.min():.1f}..{ytr.max():.1f})")
    quant = convert_tflite(tf, model, Xtr[rep_idx], args.out_dir)

    # Measure what quantisation actually cost, on real data.
    interp = tf.lite.Interpreter(model_path=str(args.out_dir / quant["int8_model"]))
    interp.allocate_tensors()
    inp, outp = interp.get_input_details()[0], interp.get_output_details()[0]
    i_scale, i_zero = inp["quantization"]
    o_scale, o_zero = outp["quantization"]

    n_check = min(2000, len(Xte))
    q_pred = np.empty(n_check, np.float32)
    for i in range(n_check):
        q = np.clip(np.round(Xte[i] / i_scale + i_zero), -128, 127).astype(np.int8)
        interp.set_tensor(inp["index"], q.reshape(1, WINDOW, N_FEATURES))
        interp.invoke()
        raw = interp.get_tensor(outp["index"]).astype(np.float32).ravel()[0]
        q_pred[i] = (raw - o_zero) * o_scale
    q_mae = float(np.mean(np.abs(q_pred - yte[:n_check])))
    print(f"\nint8 MAE {q_mae:.3f} m/s vs float {mae:.3f} "
          f"(+{(q_mae - mae) * 1000:.0f} mm/s from quantisation)")

    meta = {
        "task": "MOB-05",
        "description": "IMU window -> vehicle forward speed (m/s)",
        "window": WINDOW,
        "n_features": N_FEATURES,
        "sample_rate_hz": 10,
        "feature_patterns": FEATURE_PATTERNS,
        "feature_order": ["ax", "ay", "az", "gyro_yaw", "gyro_pitch", "gyro_roll"],
        "target": "vehicle Velocity (km/hr) -> m/s",
        "normalization": {"mean": mean.tolist(), "std": std.tolist()},
        "metrics": {
            "test_mae_ms": mae, "test_rmse_ms": rmse, "test_r2": r2,
            "baseline_mae_ms": baseline_mae, "int8_mae_ms": q_mae,
        },
        "splits": {k: sorted(v) for k, v in split.items()},
        "windows": {"train": len(Xtr), "val": len(Xva), "test": len(Xte)},
        "epochs_run": len(hist.history["loss"]),
        "tensorflow": tf.__version__,
        **quant,
    }
    meta_path = args.out_dir / "speed_model_meta.json"
    meta_path.write_text(json.dumps(meta, indent=2))

    print(f"\nwrote:")
    for p in (args.out_dir / quant["int8_model"], args.out_dir / quant["float_model"],
              keras_path, meta_path):
        print(f"  {p.relative_to(ROOT)}  ({p.stat().st_size / 1024:.1f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
