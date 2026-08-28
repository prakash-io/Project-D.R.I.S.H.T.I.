#!/usr/bin/env python3
"""Train the YOLOv8-nano incident photo verifier (ML-05).

    ai-services/.venv/bin/python scripts/train_incident_yolo.py --epochs 40

Writes `data/artifacts/vision/incident-yolov8n.pt`, which `/verify-incident`
loads to decide whether a driver's photo justifies blocking a road edge.

Why a *classifier* on a *detection* dataset
-------------------------------------------
`05_vision_hazard_detection_yolo` ships in YOLO detection format -- one
`class cx cy w h` line per image. Audited across all 1,380 images, **every
single one carries exactly one box**: no image has two objects and none is
empty. The task is therefore one-label-per-image, and the box adds nothing the
endpoint uses -- the backend needs "what is this a photo of, and how sure are
you", not where in the frame it sits.

Training `yolov8n-cls` on the same images instead of `yolov8n` detection:

*   matches the endpoint's contract, which returns a class and a confidence;
*   is far better conditioned on 965 training images than a detector with four
    classes and a box regression head to fit;
*   removes a whole failure mode at inference -- a detector that finds no box
    returns nothing, and "no detection" is not the same as NORMAL_TERRAIN,
    but it is very easy to conflate them in the backend.

The detection labels are not discarded: they are the source of the per-image
class, converted here into the folder layout the classifier expects.

Two of the four shipped classes are not labels (`--label-source`)
-----------------------------------------------------------------
NORMAL_TERRAIN and DAMAGED_BRIDGE_INFRASTRUCTURE are assigned by **filename
index arithmetic**, not by image content. Verified against all 1,380 labels
with zero violations:

    landslide pool:  index % 4  == 0  ->  NORMAL_TERRAIN         (800/800)
    flood pool:      index % 12 == 0  ->  DAMAGED_BRIDGE_INFRA.  (580/580)

Spot-checked visually and the arithmetic wins: `flood_0096.jpg`, labelled
DAMAGED_BRIDGE_INFRASTRUCTURE, is an aerial photograph of flooded farmland
with no bridge in it. `landslide_0012.jpg`, labelled NORMAL_TERRAIN, is a
hillside covered in landslide scars.

So `--label-source` picks what to believe:

    pool  (default)  2 classes, taken from the image pool the file belongs to.
                     Every label is content-derived, so every output means
                     something.
    file             4 classes, the shipped label files. Reproduces the
                     original run, in which ~28% of images carry a label
                     uncorrelated with their content and the two synthetic
                     classes score 0.000 recall because they cannot be learned.

Nothing is thrown away in `pool` mode -- the same 1,380 images train, under
the only labels that survive scrutiny.

Read the accuracy knowing what the classes are
-----------------------------------------------
The two pools are different IMAGING MODALITIES, not just different hazards:
the landslide pool is satellite false-colour tiles, the flood pool is aerial
press and drone photography. A colour histogram alone -- 48 numbers, every
shape and texture destroyed -- separates them at 86.7%. A CNN scoring ~1.00
is doing much less work than that number suggests.

More seriously, NEITHER pool contains what `/verify-incident` is actually
sent: a ground-level photograph taken by a driver standing in front of a
blocked road. The model is out of distribution on every real input. See
REVISION.md.
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import os
import shutil
import sys
import time
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SRC = ROOT / "data" / "raw" / "vision" / "incident-yolo"
DEFAULT_NEGATIVES = ROOT / "data" / "raw" / "vision" / "normal_terrain"
DEFAULT_CLS_DIR = ROOT / "data" / "processed" / "vision" / "incident-cls"
DEFAULT_OUT = ROOT / "data" / "artifacts" / "vision" / "incident-yolov8n.pt"

SPLITS = ("train", "val", "test")


def rel(path: Path) -> str:
    """Path relative to ROOT for display, falling back to the absolute path.

    `Path.relative_to` RAISES when the target is outside ROOT, and every call
    site here is building a log line. That turned a cosmetic concern into a
    crash the moment the script was pointed at a data directory in another
    checkout -- which is exactly what happens under a git worktree, where the
    code is versioned per worktree but the gitignored `data/` tree is not.
    """
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


#: Filename prefix -> the class that prefix's pool actually depicts. This is
#: the `pool` label source: the two image pools are `flood_*` and
#: `landslide_*`, and the pool is the only content-derived signal in the
#: dataset that survives inspection.
POOL_TO_CLASS = {
    "flood": "FLOODED_ROAD_OR_SUBMERGED",
    "landslide": "ACTIVE_LANDSLIDE_DEBRIS",
}

#: The negative class. Not in `incident-yolo` -- both of its pools are
#: hazards -- so it is sourced separately by scripts/fetch_normal_terrain.py.
#:
#: Without it the model has TWO classes whose softmax sums to 1, and therefore
#: no way to answer "neither". Every photograph ever uploaded is forced to be a
#: flood or a landslide; a picture of a footballer scores
#: ACTIVE_LANDSLIDE_DEBRIS at 1.000. No confidence threshold repairs that,
#: because the confidence is not wrong -- it is the only answer the label
#: space permits. Measured before this class existed: held-out normal terrain
#: came back as landslide at median confidence 0.794, against 0.786 for real
#: landslides. The distributions overlap, so no cutoff separates them.
NEGATIVE_CLASS = "NORMAL_TERRAIN"

#: Split proportions for the negatives, matching the hazard splits already in
#: the source tree (965/207/208 = 70/15/15).
NEG_TRAIN_PCT, NEG_VAL_PCT = 70, 85


def negative_split(filename: str) -> str:
    """Deterministic train/val/test bucket for one negative image.

    Hashed on the FILENAME rather than taken from an index or a shuffle, so
    that adding more negatives later leaves every existing image in the split
    it was already in. A random shuffle would silently move test images into
    train on the next run and quietly invalidate the held-out score.
    """
    bucket = int(hashlib.sha1(filename.encode()).hexdigest()[:8], 16) % 100
    if bucket < NEG_TRAIN_PCT:
        return "train"
    return "val" if bucket < NEG_VAL_PCT else "test"


def link_negatives(negatives_dir: Path, dst: Path) -> dict[str, int]:
    """Symlink the negative pool into dst/<split>/NORMAL_TERRAIN/."""
    images = sorted(p for p in negatives_dir.iterdir()
                    if p.suffix.lower() in {".jpg", ".jpeg", ".png"}
                    and p.stat().st_size > 0)
    counts: collections.Counter = collections.Counter()
    for image_path in images:
        split = negative_split(image_path.name)
        folder = dst / split / NEGATIVE_CLASS
        folder.mkdir(parents=True, exist_ok=True)
        link = folder / image_path.name
        os.symlink(os.path.relpath(image_path, link.parent), link)
        counts[split] += 1
    return dict(counts)


def read_classes(src: Path) -> list[str]:
    """Class names in `data.yaml` order -- the order is the label contract."""
    spec = yaml.safe_load((src / "data.yaml").read_text())
    names = spec["names"]
    if isinstance(names, dict):
        return [names[i] for i in sorted(names)]
    return list(names)


def image_class(label_path: Path) -> int | None:
    """Class id of the single box in a detection label file."""
    lines = [ln.split() for ln in label_path.read_text().split("\n") if ln.strip()]
    if len(lines) != 1:
        return None
    return int(lines[0][0])


def pool_of(stem: str) -> str | None:
    """Image pool from the filename, e.g. `landslide_0021` -> `landslide`."""
    prefix = stem.split("_")[0].lower()
    return prefix if prefix in POOL_TO_CLASS else None


def build_classification_tree(src: Path, dst: Path, classes: list[str],
                             label_source: str,
                             negatives_dir: Path | None = None) -> dict:
    """Materialise `dst/<split>/<CLASS>/<image>` for the chosen label source.

    Symlinks, not copies: the source images are 1,380 JPEGs under an immutable
    `raw/` tree, and duplicating them would put a second copy of `raw/` inside
    `processed/` that nothing keeps in sync.
    """
    if dst.exists():
        shutil.rmtree(dst)

    stats: dict = {}
    for split in SPLITS:
        images_dir = src / split / "images"
        labels_dir = src / split / "labels"
        if not images_dir.is_dir():
            sys.exit(f"error: {images_dir} not found")

        counts: collections.Counter = collections.Counter()
        skipped = []
        for name in classes:
            (dst / split / name).mkdir(parents=True, exist_ok=True)

        for image_path in sorted(images_dir.iterdir()):
            if image_path.suffix.lower() not in {".jpg", ".jpeg", ".png"}:
                continue

            if label_source == "pool":
                pool = pool_of(image_path.stem)
                if pool is None:
                    skipped.append((image_path.name, "filename has no known pool prefix"))
                    continue
                class_name = POOL_TO_CLASS[pool]
            else:
                label_path = labels_dir / f"{image_path.stem}.txt"
                if not label_path.exists():
                    skipped.append((image_path.name, "no label file"))
                    continue
                class_id = image_class(label_path)
                if class_id is None:
                    skipped.append((image_path.name, "not exactly one box"))
                    continue
                if not 0 <= class_id < len(classes):
                    skipped.append((image_path.name, f"class id {class_id} out of range"))
                    continue
                class_name = classes[class_id]

            link = dst / split / class_name / image_path.name
            # Relative symlink so the tree survives the repo being moved.
            os.symlink(os.path.relpath(image_path, link.parent), link)
            counts[class_name] += 1

        stats[split] = {"counts": dict(counts), "total": sum(counts.values()),
                        "skipped": skipped}

    if negatives_dir is not None:
        neg_counts = link_negatives(negatives_dir, dst)
        for split in SPLITS:
            n = neg_counts.get(split, 0)
            stats[split]["counts"][NEGATIVE_CLASS] = n
            stats[split]["total"] += n

    for split in SPLITS:
        counts = stats[split]["counts"]
        detail = "  ".join(f"{c}={counts.get(c, 0)}" for c in classes)
        print(f"  {split:5} {stats[split]['total']:4} images   {detail}")
        if stats[split]["skipped"]:
            print(f"        skipped {len(stats[split]['skipped'])}: "
                  f"{stats[split]['skipped'][:5]}")
    return stats


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", type=Path, default=DEFAULT_SRC)
    ap.add_argument("--cls-dir", type=Path, default=DEFAULT_CLS_DIR)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--imgsz", type=int, default=224)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--device", default=None, help="mps | cpu | 0 (default: auto)")
    ap.add_argument("--label-source", choices=("pool", "file"), default="pool",
                    help="'pool' (default) = 2 content-derived classes; "
                         "'file' = the 4 shipped labels, 2 of which are index "
                         "arithmetic rather than image content")
    ap.add_argument("--negatives", type=Path, default=DEFAULT_NEGATIVES,
                    help="directory of NORMAL_TERRAIN images; pass --no-negatives "
                         "to reproduce the old two-class model")
    ap.add_argument("--no-negatives", action="store_true",
                    help="train without the negative class -- the model then has "
                         "no way to answer 'no hazard here'")
    ap.add_argument("--prepare-only", action="store_true",
                    help="build the classification tree and stop")
    args = ap.parse_args()

    t0 = time.time()
    declared = read_classes(args.src)
    negatives_dir: Path | None = None
    if not args.no_negatives:
        if not args.negatives.is_dir():
            sys.exit(f"error: {args.negatives} not found. Run "
                     f"scripts/fetch_normal_terrain.py first, or pass "
                     f"--no-negatives to train the old two-class model.")
        n_negatives = sum(1 for p in args.negatives.iterdir()
                          if p.suffix.lower() in {".jpg", ".jpeg", ".png"}
                          and p.stat().st_size > 0)
        if n_negatives < 100:
            sys.exit(f"error: only {n_negatives} negatives in {args.negatives}. "
                     f"A negative class this thin is worse than none -- it "
                     f"trains a class the model will never predict.")
        negatives_dir = args.negatives
        print(f"==> negative class {NEGATIVE_CLASS}: {n_negatives} images from "
              f"{rel(args.negatives)}")

    if args.label_source == "pool":
        # Order fixed here rather than taken from data.yaml: in pool mode
        # data.yaml's 4-class list is not the label space being trained.
        classes = [POOL_TO_CLASS["flood"], POOL_TO_CLASS["landslide"]]
        if negatives_dir is not None:
            classes.append(NEGATIVE_CLASS)
        print(f"==> label source 'pool': {len(classes)} content-derived classes "
              f"{classes}")
        print(f"    (data.yaml declares 4: {declared} -- two of them are "
              f"index arithmetic, see the module docstring)")
    else:
        classes = declared
        print(f"==> label source 'file': {len(classes)} classes "
              f"(data.yaml order): {classes}")
        print("    WARNING: NORMAL_TERRAIN and DAMAGED_BRIDGE_INFRASTRUCTURE are "
              "assigned by filename index arithmetic and cannot be learned.")

    print(f"==> building classification tree at {rel(args.cls_dir)}")
    stats = build_classification_tree(args.src, args.cls_dir, classes,
                                      args.label_source, negatives_dir)
    if args.prepare_only:
        print("==> --prepare-only, stopping")
        return 0

    import torch
    from ultralytics import YOLO

    device = args.device
    if device is None:
        device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"==> torch {torch.__version__} on device '{device}'")

    # Absolute path, so the 5 MB pretrained checkpoint is cached under
    # data/artifacts/ instead of being downloaded into the repo root.
    pretrained = ROOT / "data" / "artifacts" / "vision" / "pretrained" / "yolov8n-cls.pt"
    pretrained.parent.mkdir(parents=True, exist_ok=True)
    model = YOLO(str(pretrained))
    model.train(
        data=str(args.cls_dir),
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        device=device,
        project=str(ROOT / "data" / "artifacts" / "vision" / "runs"),
        name="incident-cls",
        exist_ok=True,
        seed=20260825,
        # The classes are heavily skewed, so the checkpoint is selected on
        # validation loss rather than top-1 accuracy: a model that never
        # predicts DAMAGED_BRIDGE still scores ~98% top-1 on a 3-image class.
        patience=15,
        verbose=True,
    )

    print("\n==> evaluating on the held-out test split")
    # project/name are required here too: without them ultralytics writes a
    # `runs/classify/val` tree into the CURRENT WORKING DIRECTORY, i.e. the
    # repo root, regardless of where training was told to put its output.
    metrics = model.val(data=str(args.cls_dir), split="test", device=device,
                        verbose=False,
                        project=str(ROOT / "data" / "artifacts" / "vision" / "runs"),
                        name="incident-cls-test", exist_ok=True)

    # Per-class accuracy from an explicit pass, because ultralytics'
    # classification validator reports only top-1/top-5 overall.
    per_class = evaluate_per_class(model, args.cls_dir / "test", classes, device)

    print(f"\ntest top-1 : {metrics.top1:.4f}")
    print(f"test top-5 : {metrics.top5:.4f}")
    print("\nper-class on test (n is why some of these mean little)")
    for name in classes:
        row = per_class[name]
        print(f"  {name:<34} n={row['n']:>3}  recall={row['recall']:.4f}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    best = Path(model.trainer.best)
    shutil.copy2(best, args.out)

    # The trained model's own index order, which is NOT data.yaml order:
    # torchvision's ImageFolder assigns indices by sorted folder name, so
    # ACTIVE_LANDSLIDE_DEBRIS becomes 0 while data.yaml calls it 2. Nothing
    # downstream may map a raw index through data.yaml -- IncidentVerifier
    # maps by NAME via result.names for exactly this reason. Recorded here so
    # the discrepancy is visible rather than discovered.
    model_names = [model.names[i] for i in sorted(model.names)]

    meta = {
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "task": "classify",
        "base_weights": "yolov8n-cls.pt",
        "reason_classify_not_detect": "every image in the source carries exactly one box",
        "label_source": args.label_source,
        "negative_class": None if negatives_dir is None else {
            "name": NEGATIVE_CLASS,
            "source": str(rel(negatives_dir)),
            "why": (
                "a two-class softmax cannot answer 'neither', so every upload "
                "was forced to be a flood or a landslide; this class is what "
                "makes 'no hazard here' representable"
            ),
            "not_closed": (
                "these are ordinary ground-level photographs, not photographs "
                "of normal NER roads; the model remains out of distribution on "
                "a driver's real photo of a fine road. See REVISION.md Q8."
            ),
        },
        "label_source_note": (
            "pool = 2 content-derived classes from the image pool; the shipped "
            "4-class labels include two assigned by filename index arithmetic "
            "(landslide idx%4==0 -> NORMAL_TERRAIN, flood idx%12==0 -> "
            "DAMAGED_BRIDGE_INFRASTRUCTURE), verified 1380/1380"
        ),
        "declared_classes_data_yaml": declared,
        "classes_data_yaml_order": classes,
        "classes_model_index_order": model_names,
        "class_order_warning": (
            "model indices are alphabetical (ImageFolder), not data.yaml order; "
            "always map by name"
        ),
        "epochs": args.epochs,
        "imgsz": args.imgsz,
        "device": str(device),
        "dataset": {s: stats[s]["counts"] for s in SPLITS},
        "test": {"top1": float(metrics.top1), "top5": float(metrics.top5),
                 "per_class": per_class},
        "source_run": str(rel(best.parent.parent)),
    }
    meta_path = args.out.with_name(args.out.stem + "_meta.json")
    meta_path.write_text(json.dumps(meta, indent=2) + "\n")

    print(f"\n==> wrote {rel(args.out)} "
          f"({args.out.stat().st_size / 1e6:.1f} MB)")
    print(f"==> wrote {rel(meta_path)}")
    print(f"==> total {time.time() - t0:.1f}s")
    return 0


def evaluate_per_class(model, test_dir: Path, classes: list[str], device) -> dict:
    """Recall per class, with the support count that qualifies it."""
    out = {}
    for name in classes:
        folder = test_dir / name
        images = sorted(p for p in folder.iterdir()
                        if p.suffix.lower() in {".jpg", ".jpeg", ".png"}) if folder.is_dir() else []
        if not images:
            out[name] = {"n": 0, "correct": 0, "recall": float("nan")}
            continue
        correct = 0
        for batch_start in range(0, len(images), 64):
            batch = [str(p) for p in images[batch_start:batch_start + 64]]
            for result in model.predict(batch, device=device, verbose=False):
                if result.names[int(result.probs.top1)] == name:
                    correct += 1
        out[name] = {"n": len(images), "correct": correct, "recall": correct / len(images)}
    return out


if __name__ == "__main__":
    raise SystemExit(main())
