#!/usr/bin/env python3
"""Acceptance test: does the incident classifier detect hazards, or modality?

    ai-services/.venv/bin/python scripts/probe_vision_degenerate.py \
        --weights data/artifacts/vision/incident-yolov8n-v2.pt

Exits non-zero if the model returns a confident hazard for an image that
contains no hazard. Run it after every retrain, before the weights are
promoted into `ai-services`.

Why a probe and not the test-split accuracy
--------------------------------------------
The shipped 2-class model scored **1.00 top-1 on its own held-out test split**
and was still useless. Its two classes were two imaging modalities -- satellite
false-colour tiles labelled landslide, aerial RGB labelled flood -- so it had
learned "ordinary RGB photograph -> flood" and returned that for everything a
driver could actually photograph. Measured on that model:

    solid grey JPEG        FLOODED_ROAD_OR_SUBMERGED   0.9966
    solid white            FLOODED_ROAD_OR_SUBMERGED   0.9996
    solid black            FLOODED_ROAD_OR_SUBMERGED   0.9989
    random noise           FLOODED_ROAD_OR_SUBMERGED   0.8877
    blue sky               FLOODED_ROAD_OR_SUBMERGED   0.9971
    UI mockup screenshot   FLOODED_ROAD_OR_SUBMERGED   1.0000

A test split drawn from the same two pools cannot see any of that: every image
in it is one of the two modalities, so the shortcut is a perfect predictor
there. The split measures whether the model learned the training distribution.
This measures whether the training distribution was the right one.

What passing means
------------------
For every probe, one of:

  * top-1 is NORMAL_TERRAIN -- the model has somewhere to put "nothing wrong
    here", and used it; or
  * top-1 confidence is below `--threshold` -- the model is a hazard class but
    unsure, so `YOLO_CONF_THRESHOLD` rejects it before it reaches a dispatcher.

Either is an acceptable answer. A confident hazard verdict on a solid grey
rectangle is not, and that is the only thing this fails on.

Note on what it does not prove
-------------------------------
Passing means the model is not the specific degenerate function we caught. It
does not mean the model is accurate on real driver photographs -- nothing here
contains a real hazard, so this probe cannot measure recall. Read it alongside
the per-class test recall, never instead of it.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_WEIGHTS = ROOT / "data/artifacts/vision/incident-yolov8n.pt"

#: Class names that mean "no incident". Kept in sync with the serving config's
#: YOLO_CLASS_TO_INCIDENT_KIND, where these map to None and cannot block an edge.
NON_HAZARD = {"NORMAL_TERRAIN"}


def synthetic_probes(out_dir: Path) -> list[tuple[Path, str]]:
    """Images with no hazard, no road and in most cases no scene at all."""
    rng = np.random.default_rng(0)
    specs = {
        "solid_grey": np.full((480, 640, 3), 128, np.uint8),
        "solid_white": np.full((480, 640, 3), 255, np.uint8),
        "solid_black": np.zeros((480, 640, 3), np.uint8),
        "random_noise": rng.integers(0, 256, (480, 640, 3), dtype=np.uint8),
        "blue_sky": np.dstack([
            np.full((480, 640), 110, np.uint8),
            np.full((480, 640), 160, np.uint8),
            np.full((480, 640), 235, np.uint8)]),
        # A brown field is the adversarial case for a landslide class the same
        # way flat grey is for flood: right colour, no structure.
        "flat_brown": np.dstack([
            np.full((480, 640), 122, np.uint8),
            np.full((480, 640), 96, np.uint8),
            np.full((480, 640), 66, np.uint8)]),
        # Vertical greyscale ramp -- gradient, but not of anything.
        "grey_gradient": np.repeat(
            np.linspace(0, 255, 480, dtype=np.uint8)[:, None, None], 640,
            axis=1).repeat(3, axis=2),
    }
    out: list[tuple[Path, str]] = []
    for name, arr in specs.items():
        p = out_dir / f"{name}.jpg"
        Image.fromarray(arr).save(p, quality=92)
        out.append((p, "synthetic"))
    return out


def screenshot_probes(out_dir: Path, roots: list[Path],
                      limit: int) -> list[tuple[Path, str]]:
    """Real PNGs that are emphatically not hazard photographs.

    Screenshots are the strongest probe in the set: they are real images with
    real structure, real edges and real colour variation, and a model keying on
    anything hazard-shaped has no excuse for calling one a flood.
    """
    out: list[tuple[Path, str]] = []
    for root in roots:
        if not root.exists():
            continue
        for cand in sorted(root.rglob("*.png"))[:limit]:
            try:
                p = out_dir / f"shot_{cand.stem[:40]}.jpg"
                Image.open(cand).convert("RGB").save(p, quality=92)
                out.append((p, "screenshot"))
            except Exception:  # noqa: BLE001 - an unreadable file is skipped
                continue
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--weights", type=Path, default=DEFAULT_WEIGHTS)
    ap.add_argument("--threshold", type=float, default=0.75,
                    help="must match config.YOLO_CONF_THRESHOLD -- below this "
                         "a verdict is rejected before a dispatcher sees it")
    ap.add_argument("--work-dir", type=Path,
                    default=ROOT / "data/processed/vision/probes")
    ap.add_argument("--screenshot-roots", type=Path, nargs="*",
                    default=[ROOT / ".playwright-mcp", ROOT / "dashboard"])
    ap.add_argument("--device", default=None)
    args = ap.parse_args()

    if not args.weights.exists():
        print(f"error: {args.weights} not found", file=sys.stderr)
        return 2

    args.work_dir.mkdir(parents=True, exist_ok=True)
    probes = synthetic_probes(args.work_dir)
    probes += screenshot_probes(args.work_dir, args.screenshot_roots, limit=4)

    import torch
    from ultralytics import YOLO

    device = args.device or ("mps" if torch.backends.mps.is_available() else "cpu")
    model = YOLO(str(args.weights))
    names = model.names
    class_list = [names[i] for i in sorted(names)]
    print(f"weights  {args.weights}")
    print(f"classes  {class_list}")
    print(f"reject   top-1 confidence < {args.threshold} "
          f"or top-1 in {sorted(NON_HAZARD)}\n")

    header = f"{'probe':34s} {'kind':11s} {'prediction':28s} {'conf':>7s}  verdict"
    print(header)
    print("-" * len(header))

    failures: list[str] = []
    for path, kind in probes:
        r = model.predict(str(path), verbose=False, device=device)[0]
        if r.probs is None:
            print(f"error: {args.weights} is not a classification model",
                  file=sys.stderr)
            return 2
        top = names[int(r.probs.top1)]
        conf = float(r.probs.top1conf)
        ok = top in NON_HAZARD or conf < args.threshold
        if not ok:
            failures.append(f"{path.name}: {top} @ {conf:.4f}")
        print(f"{path.name:34s} {kind:11s} {top:28s} {conf:7.4f}  "
              f"{'ok' if ok else 'FAIL'}")

    print()
    if failures:
        print(f"FAIL: {len(failures)}/{len(probes)} hazard-free images came back "
              f"as confident hazards:")
        for f in failures:
            print(f"  {f}")
        print("\nThe model is keying on something other than the hazard. Do not "
              "promote these weights.")
        return 1

    print(f"PASS: all {len(probes)} hazard-free images were either NORMAL_TERRAIN "
          f"or below the {args.threshold} threshold.")
    print("This says the model is not degenerate. It says nothing about recall "
          "on real hazards -- read the per-class test numbers for that.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
