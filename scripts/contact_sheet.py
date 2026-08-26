#!/usr/bin/env python3
"""Tile a sample of images into one grid, for eyeballing a harvested pool.

    ai-services/.venv/bin/python scripts/contact_sheet.py \
        --src data/raw/vision/commons/LANDSLIDE --out /tmp/sheet.jpg --n 60

Why this is a required step and not a nicety
---------------------------------------------
`harvest_commons_vision.py` rejects by file title and
`build_vision_dataset.py` rejects by source category, and between them they
catch maps, icons, diagrams and paintings whose names or categories give them
away. Neither can catch a photograph that is correctly titled, correctly
categorised and still the wrong thing -- a close-up of a rock, a museum
display about a landslide, a portrait of a geologist standing near one.

The only instrument for that is a person looking at the images, and looking at
900 files one at a time is not something anyone actually does. A contact sheet
makes the pool reviewable in a few seconds, which is the difference between a
spot-check happening and a spot-check being skipped.

This is how the shipped model's real problem would have been caught before it
was trained: forty tiles of false-colour satellite squares next to forty tiles
of aerial photographs is instantly, visibly two modalities rather than two
hazards. No metric on the training data showed it -- the test accuracy was
1.00 -- but a glance at the images does.

Sampling is deterministic and spread across the pool
-----------------------------------------------------
An evenly-spaced sample over the sorted file list, not the first N and not a
fresh random draw each run. The first N would be one alphabetical slice, which
on a Commons harvest means one category and one photographer. A fixed seed
makes two runs comparable, so a sheet from before and after a filter change
shows what the change did.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image, ImageDraw

IMG_EXT = {".jpg", ".jpeg", ".png"}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--n", type=int, default=60, help="tiles to show")
    ap.add_argument("--cols", type=int, default=10)
    ap.add_argument("--tile", type=int, default=160, help="tile edge in px")
    ap.add_argument("--label", action="store_true",
                    help="draw an index on each tile, to name a bad one")
    ap.add_argument("--start", type=int, default=None,
                    help="review a contiguous slice from this index instead of "
                         "sampling; indices then match the sorted pool, which "
                         "is what an exclusion list has to refer to")
    args = ap.parse_args()

    files = sorted(p for p in args.src.rglob("*")
                   if p.is_file() and p.suffix.lower() in IMG_EXT)
    if not files:
        print(f"error: no images under {args.src}", file=sys.stderr)
        return 1

    if args.start is not None:
        # Contiguous slice: for an exhaustive review, where every image must
        # be seen exactly once and its index must be stable across sheets.
        step = 1
        offset = args.start
        picked = files[args.start:args.start + args.n]
    else:
        # Evenly spaced across the whole pool rather than the first n.
        step = max(1, len(files) // args.n)
        offset = 0
        picked = files[::step][:args.n]

    cols = args.cols
    rows = (len(picked) + cols - 1) // cols
    t = args.tile
    sheet = Image.new("RGB", (cols * t, rows * t), (24, 24, 24))
    draw = ImageDraw.Draw(sheet)

    for i, path in enumerate(picked):
        try:
            with Image.open(path) as im:
                im = im.convert("RGB")
                # Cover-crop to square so every tile is the same size and the
                # grid stays readable; letterboxing wastes half the sheet.
                w, h = im.size
                side = min(w, h)
                im = im.crop(((w - side) // 2, (h - side) // 2,
                              (w + side) // 2, (h + side) // 2))
                im = im.resize((t, t), Image.LANCZOS)
        except Exception:  # noqa: BLE001 - an unreadable file shows as a blank
            im = Image.new("RGB", (t, t), (80, 0, 0))
        x, y = (i % cols) * t, (i // cols) * t
        sheet.paste(im, (x, y))
        if args.label:
            tag = str(offset + i * step)
            draw.rectangle([x, y, x + 8 + 7 * len(tag), y + 14], fill=(0, 0, 0))
            draw.text((x + 3, y + 3), tag, fill=(255, 255, 0))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(args.out, quality=88)
    print(f"{len(picked)} of {len(files)} images (every {step}) -> {args.out}")
    for i, p in enumerate(picked):
        print(f"  {offset + i * step:4d} {p.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
