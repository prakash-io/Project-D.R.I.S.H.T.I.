#!/usr/bin/env python3
"""Assemble the 3-class ground-level incident dataset for the classifier.

    ai-services/.venv/bin/python scripts/build_vision_dataset.py \
        --out data/processed/vision/incident-cls-v2

Writes `<out>/{train,val,test}/<CLASS>/<image>` as relative symlinks, plus a
`report.json` recording exactly which images went where and why.

What this replaces, and why
---------------------------
The shipped pool (`05_vision_hazard_detection_yolo`) is two imaging
modalities, not two hazards: satellite false-colour tiles labelled landslide,
aerial RGB labelled flood. The 2-class model trained on it scores ~1.00 on its
own test split and is still degenerate -- it returns
FLOODED_ROAD_OR_SUBMERGED at 0.9966 for a solid grey JPEG, 0.9996 for solid
white and 1.0000 for a screenshot of a UI mockup. It learned "false-colour
tile -> landslide, ordinary RGB -> flood". Every real input to
`/verify-incident` is ordinary RGB, so in production it is a constant
function that returns "flood".

This build fixes the input distribution rather than the architecture:

    FLOODED_ROAD_OR_SUBMERGED  data/raw/vision/drive_drop
                               760 real ground-level flood photographs.
    ACTIVE_LANDSLIDE_DEBRIS    data/raw/vision/commons/LANDSLIDE
                               ground-level landslide/debris photographs.
    NORMAL_TERRAIN             data/raw/vision/commons/NORMAL
                               ground-level photographs of passable road.

The legacy satellite/aerial pool is deliberately NOT included
--------------------------------------------------------------
It is 1,380 images and it is tempting to keep them for volume. They are left
out because mixing viewpoints reintroduces the exact shortcut being removed:
if any class contains satellite tiles and the others do not, "is this a
satellite tile" remains a perfectly good separating feature and the model will
find it again. Fewer images from one consistent viewpoint beats more images
across two. Pass `--include-legacy` to override; the report records it.

Why NORMAL_TERRAIN has to exist
--------------------------------
Softmax top-1 over n classes is >= 1/n by construction, so a 2-class model
cannot return less than 0.5 for anything and has no way to say "nothing is
wrong in this photo". Every input must be flood or landslide. NORMAL_TERRAIN
is what lets the model abstain, and it is what makes YOLO_CONF_THRESHOLD
meaningful -- the serving config already maps NORMAL_TERRAIN to `None`, so no
edge can be blocked by it.

Near-duplicates are clustered before splitting, not after
----------------------------------------------------------
Exact sha1 dedup is not enough here. Commons categories are full of photo
*series*: the same landslide, same photographer, same minute, ten frames
apart. Byte-identical they are not, so a hash-only pass keeps all ten and the
random split scatters them across train and test. The test score that comes
back is then partly a memorisation score, which is precisely the kind of
inflated number this whole exercise exists to stop trusting.

So images are grouped by perceptual hash (dHash, Hamming <= --dhash-radius,
banded LSH + union-find) and **whole clusters are assigned to one split**. A
cluster never straddles a split boundary.

Cross-class duplicates are dropped, not assigned
-------------------------------------------------
If the same image appears under two classes -- which happens, since a flooded
road photograph can sit in a Commons road category -- there is no correct
label to give it. It is dropped from both and counted in the report. Guessing
would teach the model that the classes overlap when the routing decision
downstream treats them as exclusive.

Class balance
-------------
Classes are downsampled to the smallest by default. An imbalanced set lets the
model buy accuracy with the prior, which is how a degenerate constant
classifier scores well in the first place. `--no-balance` keeps everything and
records the resulting ratio.
"""
from __future__ import annotations

import argparse
import collections
import csv
import hashlib
import json
import os
import random
import re
import shutil
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent

#: Class name -> source directories. Names match the serving config's
#: YOLO_CLASS_TO_INCIDENT_KIND, which already maps NORMAL_TERRAIN to None.
SOURCES: dict[str, list[Path]] = {
    "FLOODED_ROAD_OR_SUBMERGED": [ROOT / "data/raw/vision/drive_drop"],
    "ACTIVE_LANDSLIDE_DEBRIS": [ROOT / "data/raw/vision/commons/LANDSLIDE"],
    "NORMAL_TERRAIN": [ROOT / "data/raw/vision/commons/NORMAL"],
}

#: Only added with --include-legacy. Satellite/aerial, see the docstring.
LEGACY = {
    "FLOODED_ROAD_OR_SUBMERGED": "flood",
    "ACTIVE_LANDSLIDE_DEBRIS": "landslide",
}

IMG_EXT = {".jpg", ".jpeg", ".png"}
SPLITS = ("train", "val", "test")

#: Source categories to discard wholesale, matched against the `category`
#: column of the harvester's manifest.tsv.
#:
#: The harvester filters by FILE title, which cannot catch a correctly-titled
#: photograph of the wrong thing -- "Landslides in art" contributed six
#: nineteenth-century paintings whose titles are just place names. The
#: category is the signal there, and it is recorded per image precisely so
#: this filter is possible without re-harvesting.
BLOCKED_CATEGORY = re.compile(
    r"\b(art|arts|paintings?|drawings?|engravings?|prints?|illustrations?"
    r"|stamps?|philately|maps?|cartography|diagrams?|models?|monuments?"
    r"|memorials?|museums?|books?|literature|films?|fiction|people"
    r"|scientists?|geologists?|portraits?|logos?|coats of arms"
    r"|icons?|pictograms?|symbols?|signs?|signage|charts?|graphs?"
    r"|analysis|prevention|mitigation|research|conferences?|posters?"
    r"|animations?|videos?|screenshots?)\b",
    re.IGNORECASE,
)


def dhash(path: Path, size: int = 8) -> int | None:
    """64-bit difference hash. None if the file will not decode.

    dHash compares adjacent pixel brightness, so it is stable under the
    re-encoding, mild rescaling and exposure drift that separate two frames of
    the same scene, while still differing sharply between distinct scenes.
    """
    try:
        with Image.open(path) as im:
            g = im.convert("L").resize((size + 1, size), Image.LANCZOS)
            # tobytes() rather than getdata(): same row-major greyscale bytes,
            # and getdata() is deprecated for removal in Pillow 14.
            px = g.tobytes()
    except Exception:  # noqa: BLE001 - an undecodable image is simply excluded
        return None
    bits = 0
    for row in range(size):
        base = row * (size + 1)
        for col in range(size):
            bits = (bits << 1) | int(px[base + col] < px[base + col + 1])
    return bits


class Union:
    """Union-find over image indices, for near-duplicate clustering."""

    def __init__(self, n: int) -> None:
        self.p = list(range(n))

    def find(self, a: int) -> int:
        while self.p[a] != a:
            self.p[a] = self.p[self.p[a]]
            a = self.p[a]
        return a

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[rb] = ra


def cluster(hashes: list[int], radius: int, bands: int = 8) -> list[int]:
    """Cluster ids, one per image, joining any pair within `radius` bits.

    All-pairs Hamming would be O(n^2) over ~2,500 images -- survivable but
    wasteful. Banded LSH restricts comparison to images sharing an 8-bit band,
    which is a necessary condition for being within a small Hamming distance
    of each other in practice.
    """
    uf = Union(len(hashes))
    width = 64 // bands
    for b in range(bands):
        shift = b * width
        buckets: dict[int, list[int]] = collections.defaultdict(list)
        for i, h in enumerate(hashes):
            buckets[(h >> shift) & ((1 << width) - 1)].append(i)
        for members in buckets.values():
            if len(members) < 2 or len(members) > 400:
                # A bucket that large is a degenerate hash (flat sky, blown
                # exposure), not a photo series. Pairing it up would chain
                # unrelated images into one giant cluster.
                continue
            for x in range(len(members)):
                for y in range(x + 1, len(members)):
                    i, j = members[x], members[y]
                    if uf.find(i) == uf.find(j):
                        continue
                    if bin(hashes[i] ^ hashes[j]).count("1") <= radius:
                        uf.union(i, j)
    return [uf.find(i) for i in range(len(hashes))]


def blocked_files(d: Path) -> set[str]:
    """Filenames in `d` whose harvest category is on the blocklist.

    Absent a manifest (the flood drop was supplied directly, not harvested),
    nothing is blocked -- there is no category to judge.
    """
    manifest = d / "manifest.tsv"
    if not manifest.exists():
        return set()
    out: set[str] = set()
    with manifest.open(encoding="utf-8") as fh:
        for row in csv.DictReader(fh, delimiter="\t"):
            if BLOCKED_CATEGORY.search(row.get("category", "")):
                out.add(row["file"])
    return out


def collect(class_name: str, dirs: list[Path]) -> tuple[list[Path], int]:
    out: list[Path] = []
    blocked = 0
    for d in dirs:
        if not d.exists():
            print(f"  ! {class_name}: {d} missing", file=sys.stderr)
            continue
        drop = blocked_files(d)
        for p in sorted(d.rglob("*")):
            if not p.is_file() or p.suffix.lower() not in IMG_EXT:
                continue
            if p.name in drop:
                blocked += 1
                continue
            out.append(p)
    return out, blocked


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path,
                    default=ROOT / "data/processed/vision/incident-cls-v2")
    ap.add_argument("--legacy-src", type=Path,
                    default=ROOT / "data/raw/vision/incident-yolo")
    ap.add_argument("--include-legacy", action="store_true",
                    help="add the satellite/aerial pool; reintroduces the "
                         "modality shortcut, see the docstring")
    # Per-class source overrides. Present so the assembly logic can be
    # exercised on a small fixture without waiting on a full harvest, and so
    # a re-harvest into a new directory does not require editing SOURCES.
    ap.add_argument("--flood-src", type=Path, nargs="*")
    ap.add_argument("--landslide-src", type=Path, nargs="*")
    ap.add_argument("--normal-src", type=Path, nargs="*")
    ap.add_argument("--val-frac", type=float, default=0.15)
    ap.add_argument("--test-frac", type=float, default=0.15)
    ap.add_argument("--dhash-radius", type=int, default=6,
                    help="Hamming distance under which two images are treated "
                         "as the same scene")
    ap.add_argument("--no-balance", action="store_true")
    ap.add_argument("--seed", type=int, default=1729)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    sources = {k: list(v) for k, v in SOURCES.items()}
    for cls, override in (
        ("FLOODED_ROAD_OR_SUBMERGED", args.flood_src),
        ("ACTIVE_LANDSLIDE_DEBRIS", args.landslide_src),
        ("NORMAL_TERRAIN", args.normal_src),
    ):
        if override:
            sources[cls] = list(override)
    if args.include_legacy:
        for cls, prefix in LEGACY.items():
            for split in SPLITS:
                sources[cls].append(args.legacy_src / split / "images")
            print(f"  + legacy {prefix} pool folded into {cls}")

    # ---------------------------------------------------------------- gather
    print("== gathering")
    per_class: dict[str, list[Path]] = {}
    blocked_total = 0
    for cls, dirs in sources.items():
        found, blocked = collect(cls, dirs)
        blocked_total += blocked
        if args.include_legacy:
            prefix = LEGACY.get(cls)
            if prefix:
                found = [p for p in found
                         if p.parent.parent.name != "images"
                         or p.stem.split("_")[0].lower() == prefix]
        per_class[cls] = found
        print(f"  {cls:28s} {len(found):5d} files"
              f"{f'  (-{blocked} blocked category)' if blocked else ''}")
    if not all(per_class.values()):
        empty = [c for c, v in per_class.items() if not v]
        print(f"error: no images for {empty} -- run the harvest first",
              file=sys.stderr)
        return 1

    # ------------------------------------------------------- exact dedup
    # Within a class, keep the first. Across classes, drop entirely: an image
    # holding two labels has no correct label.
    print("== exact dedup (sha1)")
    owner: dict[str, str] = {}
    conflicted: set[str] = set()
    for cls, paths in per_class.items():
        for p in paths:
            d = hashlib.sha1(p.read_bytes()).hexdigest()
            if d in owner and owner[d] != cls:
                conflicted.add(d)
            owner.setdefault(d, cls)

    kept: dict[str, list[tuple[Path, str]]] = {c: [] for c in per_class}
    seen: set[str] = set()
    dropped_dup = collections.Counter()
    dropped_cross = collections.Counter()
    for cls, paths in per_class.items():
        for p in paths:
            d = hashlib.sha1(p.read_bytes()).hexdigest()
            if d in conflicted:
                dropped_cross[cls] += 1
                continue
            if d in seen:
                dropped_dup[cls] += 1
                continue
            seen.add(d)
            kept[cls].append((p, d))
    for cls in kept:
        print(f"  {cls:28s} {len(kept[cls]):5d} kept "
              f"(-{dropped_dup[cls]} dup, -{dropped_cross[cls]} cross-class)")
    if conflicted:
        print(f"  {len(conflicted)} images appeared under more than one class "
              f"and were dropped from all")

    # --------------------------------------------- perceptual clustering
    print(f"== clustering near-duplicates (dHash, radius {args.dhash_radius})")
    flat: list[tuple[str, Path, str]] = [
        (cls, p, d) for cls, items in kept.items() for p, d in items]
    hashes: list[int] = []
    usable: list[tuple[str, Path, str]] = []
    undecodable = 0
    for cls, p, d in flat:
        h = dhash(p)
        if h is None:
            undecodable += 1
            continue
        usable.append((cls, p, d))
        hashes.append(h)
    if undecodable:
        print(f"  {undecodable} files would not decode and were dropped")

    cluster_ids = cluster(hashes, args.dhash_radius)
    groups: dict[tuple[str, int], list[int]] = collections.defaultdict(list)
    for i, (cls, _, _) in enumerate(usable):
        groups[(cls, cluster_ids[i])].append(i)
    multi = sum(1 for g in groups.values() if len(g) > 1)
    collapsed = sum(len(g) - 1 for g in groups.values() if len(g) > 1)
    print(f"  {len(groups)} scene groups; {multi} contain more than one frame "
          f"({collapsed} images share a scene with another)")

    # ------------------------------------------------------------- balance
    by_class: dict[str, list[list[int]]] = collections.defaultdict(list)
    for (cls, _), members in groups.items():
        by_class[cls].append(members)
    for cls in by_class:
        rng.shuffle(by_class[cls])

    sizes = {c: sum(len(g) for g in gs) for c, gs in by_class.items()}
    print(f"== class sizes before balance: {sizes}")
    target = min(sizes.values())
    if not args.no_balance:
        for cls, gs in by_class.items():
            trimmed, total = [], 0
            for g in gs:
                if total >= target:
                    break
                trimmed.append(g)
                total += len(g)
            by_class[cls] = trimmed
        sizes = {c: sum(len(g) for g in gs) for c, gs in by_class.items()}
        print(f"== balanced to ~{target}: {sizes}")

    # --------------------------------------------------------------- split
    # Whole groups are assigned, so a scene cannot appear in two splits.
    print("== splitting (whole scene groups, never individual frames)")
    assignment: dict[str, list[tuple[str, Path]]] = {s: [] for s in SPLITS}
    for cls, gs in by_class.items():
        total = sum(len(g) for g in gs)
        want = {"val": total * args.val_frac, "test": total * args.test_frac}
        got = {"val": 0, "test": 0, "train": 0}
        for g in gs:
            if got["val"] < want["val"]:
                s = "val"
            elif got["test"] < want["test"]:
                s = "test"
            else:
                s = "train"
            got[s] += len(g)
            for i in g:
                assignment[s].append((cls, usable[i][1]))
        print(f"  {cls:28s} train={got['train']:4d} val={got['val']:4d} "
              f"test={got['test']:4d}")

    # ------------------------------------------------------------ materialise
    if args.out.exists():
        shutil.rmtree(args.out)
    report: dict = {
        "seed": args.seed,
        "include_legacy": args.include_legacy,
        "balanced": not args.no_balance,
        "dhash_radius": args.dhash_radius,
        "cross_class_conflicts": len(conflicted),
        "blocked_by_category": blocked_total,
        "undecodable": undecodable,
        "scene_groups": len(groups),
        "splits": {},
    }
    for split in SPLITS:
        counts = collections.Counter()
        for cls, src in assignment[split]:
            dest_dir = args.out / split / cls
            dest_dir.mkdir(parents=True, exist_ok=True)
            link = dest_dir / f"{src.stem[:60]}_{counts[cls]:04d}{src.suffix.lower()}"
            # Relative symlink so the tree survives the repo being moved, and
            # so raw/ is never duplicated into processed/.
            os.symlink(os.path.relpath(src, link.parent), link)
            counts[cls] += 1
        report["splits"][split] = dict(counts)
        print(f"  {split:5s} {sum(counts.values()):5d}  {dict(counts)}")

    (args.out / "report.json").write_text(json.dumps(report, indent=2))
    print(f"== wrote {args.out}")
    print(f"== report {args.out / 'report.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
