#!/usr/bin/env python3
"""Populate the NORMAL_TERRAIN negative class for the incident classifier (ML-05).

    ai-services/.venv/bin/python scripts/fetch_normal_terrain.py --count 900

Why this script exists
----------------------
The shipped classifier is TWO classes: ACTIVE_LANDSLIDE_DEBRIS and
FLOODED_ROAD_OR_SUBMERGED. A two-way softmax sums to 1, so the model is
structurally incapable of answering "neither" -- every image ever uploaded is
forced into one of the two hazards. That is not a threshold that needs tuning;
it is a missing class. A photograph of a footballer scores
ACTIVE_LANDSLIDE_DEBRIS at 1.000, and no confidence cutoff can fix it,
because the number is not wrong about anything -- it is the only answer the
label space allows.

`data/raw/vision/incident-yolo` contains no negatives at all: both pools are
hazards. So the negative class has to come from somewhere else.

What these images are, and what they are not
--------------------------------------------
Ordinary ground-level photography -- people, interiors, streets, vehicles,
landscapes -- which is exactly the "random photo" in the bug report. Training
on them teaches the model the one thing it currently cannot express: that an
image can depict no hazard at all.

They are NOT photographs of normal NER roads, and this does not close
REVISION.md's open question about the model being out of distribution on its
real input. A driver's photo of a perfectly fine hill road at dusk is neither
a hazard nor a stock photo, and the nearest trained class for it may still be
a hazard. Fixing THAT needs a few hundred real ground-level NER road photos,
which no public source substitutes for.

This directory is therefore a floor, not a ceiling: `train_incident_yolo.py`
reads whatever images are in it, so real NER road photographs can be dropped
in alongside these and picked up on the next training run with no code change.
That is the intended path to closing the open question.

Reproducibility
---------------
Picsum serves a fixed photograph per seed, so `--count N` with the same
`--prefix` fetches the same N images on any machine. Downloads are skipped if
the file already exists, so an interrupted run resumes.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import io
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DIR = ROOT / "data" / "raw" / "vision" / "normal_terrain"

#: Fetched larger than the 224 px training size on purpose: the training
#: pipeline's own augmentation (random resized crop) needs room to crop into,
#: and an image pre-scaled to exactly 224 would be upsampled by every crop.
WIDTH, HEIGHT = 480, 360
TIMEOUT_S = 30
RETRIES = 3

#: Source 1 -- arbitrary photographs, one fixed image per seed. This is the
#: literal "random photo" from the bug report.
RANDOM_URL = "https://picsum.photos/seed/{seed}/{w}/{h}.jpg"

#: Source 2 -- keyword-matched photographs, one fixed image per (keyword, lock).
#: This is the half that matters most. A negative class made only of arbitrary
#: stock photography teaches "hazard vs. stock photo", and a driver's camera
#: roll is not stock photography. These keywords aim at the distribution the
#: endpoint is actually served: a road with nothing wrong on it, seen from
#: standing height.
#:
#: `bridge` is deliberately present. DAMAGED_BRIDGE_INFRASTRUCTURE is a mapped
#: incident kind, so an intact bridge is a negative the model should be able
#: to hold apart from a broken one rather than a gap in the label space.
SCENE_URL = "https://loremflickr.com/{w}/{h}/{keyword}?lock={lock}"
SCENE_KEYWORDS = [
    "road", "highway", "street", "mountain,road", "rural,road", "countryside,road",
    "asphalt,road", "roadsign", "traffic", "truck", "lorry", "bridge",
    "dashboard", "car,interior", "windscreen", "selfie", "portrait",
    "village", "hills", "forest,road", "parking", "roadworks",
]


#: Rows trimmed from the top and bottom of a keyword-sourced image.
#:
#: loremflickr burns an attribution stamp into two corners -- the photographer
#: name bottom-left, a "cc" badge top-right. The hazard pools carry no such
#: mark, so leaving it in hands the classifier a shortcut: it could separate
#: the classes perfectly by looking for a watermark and never learn anything
#: about roads or landslides at all. That failure would show up as a superb
#: test score and a useless model, which is the hardest kind to catch.
#:
#: 34 px off a 360 px image clears both stamps with margin. The classifier
#: resizes to a 224 px square regardless, so the changed aspect ratio does not
#: survive preprocessing and cannot become a shortcut of its own.
ATTRIBUTION_CROP_PX = 34


def strip_attribution(payload: bytes) -> bytes:
    """Crop the attribution bands off a keyword-sourced image."""
    from PIL import Image

    image = Image.open(io.BytesIO(payload)).convert("RGB")
    width, height = image.size
    if height <= 2 * ATTRIBUTION_CROP_PX + 32:
        return payload
    cropped = image.crop((0, ATTRIBUTION_CROP_PX, width, height - ATTRIBUTION_CROP_PX))
    buffer = io.BytesIO()
    cropped.save(buffer, format="JPEG", quality=92)
    return buffer.getvalue()


def fetch_one(url: str, dest: Path, crop: bool = False) -> tuple[str, str]:
    """Download one image. Returns (status, detail). Never raises."""
    if dest.exists() and dest.stat().st_size > 0:
        return ("skip", "already present")

    last = "unknown"
    for attempt in range(RETRIES):
        try:
            with urllib.request.urlopen(url, timeout=TIMEOUT_S) as response:
                payload = response.read()
            # Decode before writing. A truncated download is a file that
            # trains fine and fails at inference, which is the worst kind.
            from PIL import Image
            image = Image.open(io.BytesIO(payload))
            image.verify()
            if len(payload) < 2000:
                last = f"suspiciously small ({len(payload)}B)"
                continue
            if crop:
                payload = strip_attribution(payload)
            dest.write_bytes(payload)
            return ("ok", hashlib.sha256(payload).hexdigest())
        except (urllib.error.URLError, OSError, ValueError) as exc:
            last = f"{type(exc).__name__}: {exc}"
    return ("fail", last)


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--count", type=int, default=900,
                    help="images to fetch (default 900: ~600 train / 150 val / 150 test "
                         "after the split, which balances the 571+394 hazard train set)")
    ap.add_argument("--dir", type=Path, default=DEFAULT_DIR)
    ap.add_argument("--prefix", default="drishti-neg",
                    help="seed prefix; changing it fetches a different photo set")
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--scene-fraction", type=float, default=0.6,
                    help="share of the fetch taken from keyword-matched road/"
                         "vehicle/person scenes rather than arbitrary photos")
    args = ap.parse_args()

    args.dir.mkdir(parents=True, exist_ok=True)
    print(f"==> fetching {args.count} negatives into {args.dir.relative_to(ROOT)}")

    # Split between the two sources. Scene photographs are the more valuable
    # half, so they get the larger share.
    scene_n = int(args.count * args.scene_fraction)
    random_n = args.count - scene_n

    jobs: list[tuple[str, Path]] = []
    jobs_crop: list[bool] = []
    for i in range(random_n):
        jobs.append((RANDOM_URL.format(seed=f"{args.prefix}{i}", w=WIDTH, h=HEIGHT),
                     args.dir / f"normal_rand_{i:05d}.jpg"))
        jobs_crop.append(False)
    for i in range(scene_n):
        keyword = SCENE_KEYWORDS[i % len(SCENE_KEYWORDS)]
        lock = i // len(SCENE_KEYWORDS)
        jobs.append((SCENE_URL.format(w=WIDTH, h=HEIGHT, keyword=keyword, lock=lock),
                     args.dir / f"normal_scene_{i:05d}.jpg"))
        jobs_crop.append(True)

    print(f"    {random_n} arbitrary + {scene_n} scene-matched "
          f"({len(SCENE_KEYWORDS)} keywords)")

    counts = {"ok": 0, "skip": 0, "fail": 0}
    digests: dict[str, str] = {}
    failures: list[tuple[str, str]] = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(fetch_one, url, dest, crop): (url, dest)
                   for (url, dest), crop in zip(jobs, jobs_crop)}
        for done, future in enumerate(concurrent.futures.as_completed(futures), 1):
            url, dest = futures[future]
            status, detail = future.result()
            counts[status] += 1
            if status == "ok":
                digests.setdefault(detail, dest.name)
            elif status == "fail":
                failures.append((dest.name, detail))
            if done % 100 == 0 or done == len(jobs):
                print(f"    {done}/{len(jobs)}  ok={counts['ok']} "
                      f"skip={counts['skip']} fail={counts['fail']}")

    # Picsum can serve the same photograph for different seeds. A duplicate in
    # the negative class is a training image counted twice and, worse, one that
    # can land in both train and test -- so they are removed here rather than
    # silently inflating the count.
    seen: dict[str, Path] = {}
    duplicates = 0
    for path in sorted(args.dir.glob("normal_*.jpg")):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest in seen:
            path.unlink()
            duplicates += 1
        else:
            seen[digest] = path

    remaining = len(list(args.dir.glob("normal_*.jpg")))
    print(f"\n    downloaded {counts['ok']}, already present {counts['skip']}, "
          f"failed {counts['fail']}")
    print(f"    removed {duplicates} duplicate image(s) by content hash")
    print(f"==> {remaining} unique negatives in {args.dir.relative_to(ROOT)}")

    if failures:
        print(f"\n    first failures: {failures[:3]}")
    if remaining < args.count * 0.8:
        print(f"\nerror: only {remaining} of {args.count} usable; refusing to "
              f"report success on a thin negative set", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
