#!/usr/bin/env python3
"""Harvest ground-level road and landslide photographs from Wikimedia Commons.

    ai-services/.venv/bin/python scripts/harvest_commons_vision.py \
        --plan normal --out data/raw/vision/commons/NORMAL_ROAD --limit 900

Why this script exists
----------------------
The shipped vision pool (`05_vision_hazard_detection_yolo`) is not a hazard
detector's training set -- it is two imaging modalities stacked on top of each
other. The landslide half is satellite false-colour tiles; the flood half is
aerial RGB. A classifier trained on it learns "false-colour tile -> landslide,
ordinary RGB photograph -> flood", which is why the shipped 2-class model
returns FLOODED_ROAD_OR_SUBMERGED at 0.99 confidence for a solid grey JPEG.

The endpoint's real input is a driver's phone photo: ground level, handheld,
of a road. Two of the three classes we want to ship are missing from the
corpus entirely at that viewpoint:

    FLOOD      -- covered. 760 real ground-level flood photographs were
                  supplied separately and live in data/raw/vision/drive_drop/.
    LANDSLIDE  -- missing at ground level. Satellite tiles only.
    NORMAL     -- missing entirely. There is no "nothing is wrong here" class,
                  so the model has no way to abstain.

Harvesting NORMAL alone would not fix the model: if NORMAL is ground-level
road photographs while LANDSLIDE stays satellite tiles, the modality shortcut
survives intact and just changes which label it hides behind. Both classes
have to come from the same viewpoint, so this script harvests both.

Why Commons
-----------
It is the only large image source reachable here without credentials. Flickr,
Mapillary and Kaggle all require registration, and no `~/.kaggle/kaggle.json`
exists on this machine. Commons files are freely licensed and the API exposes
sha1 per file, which makes cross-source dedup exact rather than heuristic.

Commons categories are noisy in a specific, predictable way
-----------------------------------------------------------
A category named "Landslides" contains photographs, but also maps, hazard-zone
diagrams, warning signs, scanned reports and portraits of geologists. Some of
that is filtered mechanically here -- SVG and multi-page formats are dropped,
as are files whose title matches the map/diagram/sign patterns below -- but
mechanical filtering cannot tell a photograph of a hillside from a photograph
of a poster about hillsides. **The output of this script is a candidate pool,
not a dataset.** It must be spot-checked before it is trained on.

Recursion is required, not optional
------------------------------------
Direct file counts are small (Landslides: 156, Roads in Assam: 76) but the
subcategory fan-out is large (Landslides: 30 subcats; Landslides by country:
110). The volume lives one to three levels down, so this walks the tree
breadth-first to `--depth`, tracking visited categories -- the Commons
category graph contains cycles, and an unguarded walk does not terminate.

Thumbnails, not originals
--------------------------
Requests are for `iiurlwidth=640` renderings. Originals on Commons are
routinely 20-50 MB; the classifier trains at 224 px. Downloading originals
would cost gigabytes to throw all of it away at the first resize, and it is
inconsiderate to a donated service.

Provenance is written, not assumed
-----------------------------------
Every kept file gets a row in `manifest.tsv` carrying its sha1, source
category, Commons page URL, licence and author. These are freely licensed but
not public domain, and a dataset that cannot say where an image came from
cannot honour the licence it was given under.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import re
import sys
import time
from pathlib import Path

import requests

API = "https://commons.wikimedia.org/w/api.php"
# Wikimedia's etiquette asks for a descriptive User-Agent. Deliberately carries
# no personal contact details -- this is an unattended script, not a person.
UA = "drishti-ner-logistics-research/1.0 (academic hazard-classifier dataset build)"

# Formats a phone camera never produces, and that the classifier cannot read
# without an extra decoder. .tif is excluded on purpose: on Commons it is
# almost always a scanned map or a satellite raster, which is the exact
# distribution shift this harvest exists to correct.
KEEP_EXT = {".jpg", ".jpeg", ".png"}

# Title patterns for the non-photograph material that shares these categories.
# Matched against the lowercased Commons title. Recall matters more than
# precision here -- a wrongly dropped photograph costs one sample, a wrongly
# kept map teaches the model that cartography is a landslide.
REJECT_TITLE = re.compile(
    r"\b(map|karte|mapa|carte|diagram|chart|graph|plot|logo|icon|seal|coat[ _]of[ _]arms"
    r"|sign|signpost|signage|plaque|poster|banner|leaflet|brochure|scan|scanned"
    r"|page|cover|title|document|report|letter|stamp|postcard|drawing|sketch"
    r"|painting|engraving|lithograph|illustration|animation|gif|screenshot"
    r"|portrait|schema|schematic|cross[ _-]?section"
    r"|profile|graphic|infographic|table|timeline|flag|emblem)\b"
)

PLANS: dict[str, dict] = {
    # Ground-level photographs of ordinary, passable road. This is the class
    # the shipped model has no way to express, and its absence is why the
    # model cannot abstain: every input must be landslide or flood.
    "normal": {
        "roots": [
            "Roads in Assam",
            "Roads in Arunachal Pradesh",
            "Roads in Meghalaya",
            "Roads in Nagaland",
            "Roads in Manipur",
            "Roads in Mizoram",
            "Roads in Tripura",
            "Roads in Sikkim",
            "Roads in West Bengal",
            "Roads in India",
            "Highways in India",
            "Streets in India",
            "Roads in Bhutan",
            "Roads in Nepal",
            "Roads in Bangladesh",
            "Mountain passes of India",
        ],
        "depth": 2,
    },
    # Ground-level photographs of landslide debris, slope failure and blocked
    # road. Non-Indian sources are deliberately included: the shortcut being
    # broken is modality, not geography, and a landslide in Nepal or Taiwan
    # photographed from a road is far closer to the endpoint's real input than
    # a Sentinel tile of an Indian hillside.
    "landslide": {
        "roots": [
            "Landslides",
            "Landslides in India",
            "Landslides in Nepal",
            "Landslides by country",
            "Mudslides",
            "Rockfalls",
            "Landslide scars",
            "Rockslides",
            "Debris flow",
            # "Erosion" is NOT a root, though it looks like an obvious one.
            # Measured: it alone contributed 532 of 863 candidates, and its
            # contents are coastal cliffs, river banks and soil gullies --
            # slow geomorphology, not debris sitting on a carriageway. Left
            # in, it would have been the majority of the class and the model
            # would have learned "landslide" to mean "eroded ground".
        ],
        "depth": 3,
    },
    # Not shipped in this round -- the decision was three classes now, bridge
    # later. Probed and wired up so the fourth class is a re-run, not a
    # rewrite, once ground-level bridge imagery is worth the labelling effort.
    "bridge": {
        "roots": [
            "Collapsed bridges",
            "Destroyed bridges",
            "Damaged bridges",
        ],
        "depth": 2,
    },
}


#: Minimum seconds between any two requests to Commons, process-wide.
#:
#: Commons throttles by client, not by connection, so this has to be enforced
#: in one place rather than as a sleep at each call site. Measured the hard
#: way: two copies of this script running at once (one per class) took 429s
#: across every category within a minute and harvested nothing. **Run the
#: plans one after another, not in parallel** -- two processes cannot see each
#: other's limiter, so the guarantee below only holds within a single run.
MIN_REQUEST_GAP_S = 0.35

_last_request = 0.0


def _throttle() -> None:
    global _last_request
    gap = time.monotonic() - _last_request
    if gap < MIN_REQUEST_GAP_S:
        time.sleep(MIN_REQUEST_GAP_S - gap)
    _last_request = time.monotonic()


def make_session() -> requests.Session:
    s = requests.Session()
    s.headers["User-Agent"] = UA
    return s


class HarvestError(RuntimeError):
    """A request that exhausted its retries. Raised so it cannot pass silently."""


def api(session: requests.Session, params: dict, tries: int = 8) -> dict:
    """GET the Commons API, rate-limited, with backoff that obeys Retry-After.

    Commons intermittently answers a valid request with an HTML error page, so
    a JSON decode failure is retried like a network error rather than raised.

    On exhaustion this raises rather than returning `{}`. An empty dict would
    read downstream as "that category is empty", and a throttled root category
    silently contributing zero images is exactly the failure that produced a
    harvest of nothing while every log line looked ordinary.
    """
    params = {**params, "format": "json", "formatversion": "2"}
    last: Exception | None = None
    for attempt in range(tries):
        _throttle()
        try:
            r = session.get(API, params=params, timeout=45)
            if r.status_code in (429, 503):
                # Commons states how long to wait; guessing is what got us
                # throttled in the first place.
                wait = float(r.headers.get("Retry-After", 0) or 0)
                raise _Throttled(f"HTTP {r.status_code}", wait)
            r.raise_for_status()
            return r.json()
        except _Throttled as exc:
            last = exc
            time.sleep(max(exc.retry_after, min(60.0, 2.0 * (2 ** attempt))))
        except Exception as exc:  # noqa: BLE001 - any other failure retries alike
            last = exc
            time.sleep(min(30.0, 1.5 * (attempt + 1)))
    raise HarvestError(
        f"{params.get('cmtitle') or params.get('titles')}: {last}")


class _Throttled(RuntimeError):
    def __init__(self, msg: str, retry_after: float) -> None:
        super().__init__(msg)
        self.retry_after = retry_after


def category_members(session: requests.Session, cat: str, kind: str) -> list[str]:
    """All members of a category of one type ('file' or 'subcat')."""
    out: list[str] = []
    cont: dict = {}
    while True:
        data = api(session, {
            "action": "query", "list": "categorymembers",
            "cmtitle": f"Category:{cat}", "cmtype": kind,
            "cmlimit": "500", **cont,
        })
        out.extend(m["title"] for m in data.get("query", {}).get("categorymembers", []))
        if "continue" not in data:
            return out
        cont = data["continue"]


def walk(session: requests.Session, roots: list[str], depth: int,
         cap: int) -> tuple[list[tuple[str, str]], list[str]]:
    """Breadth-first category walk -> ([(file title, source category)], failures).

    Visited categories are tracked because the Commons category graph is not a
    tree: it has cycles, and an unguarded walk revisits forever.

    A category that exhausts its retries is collected into `failures` and
    reported at the end rather than swallowed. A root failing is a materially
    different outcome from a root being empty, and the caller has to be able
    to tell them apart.
    """
    seen_cat: set[str] = set()
    seen_file: set[str] = set()
    found: list[tuple[str, str]] = []
    failures: list[str] = []
    frontier = [(c, 0) for c in roots]
    root_keys = {c.lower() for c in roots}

    while frontier and len(found) < cap:
        cat, d = frontier.pop(0)
        key = cat.lower()
        if key in seen_cat:
            continue
        seen_cat.add(key)

        try:
            files = category_members(session, cat, "file")
        except HarvestError as exc:
            tag = "ROOT " if key in root_keys else ""
            print(f"  ! {tag}category failed: {exc}", file=sys.stderr)
            failures.append(f"{tag}{cat}")
            continue

        kept = 0
        for t in files:
            if t in seen_file:
                continue
            ext = Path(t).suffix.lower()
            if ext not in KEEP_EXT:
                continue
            if REJECT_TITLE.search(t.lower()):
                continue
            seen_file.add(t)
            found.append((t, cat))
            kept += 1
            if len(found) >= cap:
                break
        print(f"  [{d}] {cat[:56]:56s} {kept:4d} kept / {len(files):4d} files"
              f"  (running {len(found)})")

        if d < depth:
            try:
                subs = category_members(session, cat, "subcat")
            except HarvestError as exc:
                print(f"  ! subcats failed: {exc}", file=sys.stderr)
                failures.append(f"subcats of {cat}")
                subs = []
            for sub in subs:
                name = sub.split(":", 1)[1] if ":" in sub else sub
                if name.lower() not in seen_cat:
                    frontier.append((name, d + 1))

    return found, failures


def image_info(session: requests.Session, titles: list[str], width: int) -> dict[str, dict]:
    """sha1 / thumb URL / licence for up to 50 titles per request."""
    info: dict[str, dict] = {}
    lost = 0
    for i in range(0, len(titles), 50):
        batch = titles[i:i + 50]
        try:
            data = api(session, {
                "action": "query", "prop": "imageinfo",
                "titles": "|".join(batch),
                "iiprop": "url|sha1|size|mime|extmetadata",
                "iiurlwidth": str(width),
                "iiextmetadatafilter": "LicenseShortName|Artist|ImageDescription",
            })
        except HarvestError as exc:
            # One lost batch is 50 candidates out of thousands -- survivable,
            # but counted and printed so the shortfall is never a mystery.
            print(f"\n  ! imageinfo batch failed: {exc}", file=sys.stderr)
            lost += len(batch)
            continue
        for page in data.get("query", {}).get("pages", []):
            ii = (page.get("imageinfo") or [{}])[0]
            if not ii:
                continue
            info[page["title"]] = ii
        print(f"    info {min(i + 50, len(titles))}/{len(titles)}", end="\r")
    print()
    if lost:
        print(f"    ! {lost} titles lost to failed imageinfo batches")
    return info


def slug(title: str) -> str:
    name = title.split(":", 1)[1] if ":" in title else title
    stem = Path(name).stem
    stem = re.sub(r"[^A-Za-z0-9]+", "_", stem).strip("_").lower()[:70]
    return stem or "file"


def strip_html(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s or "")).strip()[:200]


def existing_sha1(paths: list[Path]) -> set[str]:
    """sha1 of every image already held, so the harvest cannot re-add one.

    Commons' sha1 is of the *original* file while we download a *thumbnail*,
    so the two never collide by value. Both are hashed locally instead: the
    only comparison that means anything is between bytes actually on disk.
    """
    out: set[str] = set()
    for root in paths:
        if not root.exists():
            continue
        for p in root.rglob("*"):
            if p.is_file() and p.suffix.lower() in KEEP_EXT:
                out.add(hashlib.sha1(p.read_bytes()).hexdigest())
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--plan", required=True, choices=sorted(PLANS))
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--limit", type=int, default=900, help="images to keep")
    ap.add_argument("--width", type=int, default=640, help="thumbnail width px")
    ap.add_argument("--depth", type=int, default=None, help="override plan depth")
    ap.add_argument("--min-bytes", type=int, default=12_000,
                    help="drop thumbnails below this; they are icons or errors")
    ap.add_argument("--dedup-against", type=Path, nargs="*", default=[],
                    help="existing image trees to hash and exclude")
    args = ap.parse_args()

    plan = PLANS[args.plan]
    depth = args.depth if args.depth is not None else plan["depth"]
    session = make_session()

    print(f"== plan {args.plan}: {len(plan['roots'])} roots, depth {depth}, "
          f"target {args.limit}")

    # Over-collect: title filtering is cheap, but a meaningful share of
    # candidates still fall out at download for size, mime or duplication.
    candidates, failures = walk(session, plan["roots"], depth,
                                cap=int(args.limit * 2.5))
    print(f"== {len(candidates)} candidate titles")
    if failures:
        print(f"== {len(failures)} categories failed: {failures[:8]}"
              f"{' ...' if len(failures) > 8 else ''}")
    if not candidates:
        print("no candidates -- nothing written", file=sys.stderr)
        return 1

    src = dict(candidates)
    info = image_info(session, [t for t, _ in candidates], args.width)
    print(f"== {len(info)} with image info")

    known = existing_sha1(args.dedup_against)
    if known:
        print(f"== {len(known)} sha1s held already; those will be skipped")

    args.out.mkdir(parents=True, exist_ok=True)
    manifest = args.out / "manifest.tsv"
    rows: list[dict] = []
    kept = 0
    stats = {"no_thumb": 0, "not_image": 0, "too_small": 0, "dup": 0, "error": 0}

    for title, ii in info.items():
        if kept >= args.limit:
            break
        url = ii.get("thumburl") or ii.get("url")
        if not url:
            stats["no_thumb"] += 1
            continue
        if not (ii.get("mime") or "").startswith("image/"):
            stats["not_image"] += 1
            continue
        try:
            r = session.get(url, timeout=60)
            r.raise_for_status()
            body = r.content
        except Exception:  # noqa: BLE001
            stats["error"] += 1
            continue
        if len(body) < args.min_bytes:
            stats["too_small"] += 1
            continue
        digest = hashlib.sha1(body).hexdigest()
        if digest in known:
            stats["dup"] += 1
            continue
        known.add(digest)

        ext = ".png" if body[:8] == b"\x89PNG\r\n\x1a\n" else ".jpg"
        path = args.out / f"{slug(title)}_{digest[:8]}{ext}"
        path.write_bytes(body)
        kept += 1

        meta = ii.get("extmetadata", {})
        rows.append({
            "file": path.name,
            "sha1_local": digest,
            "sha1_original": ii.get("sha1", ""),
            "category": src.get(title, ""),
            "commons_title": title,
            "page": ii.get("descriptionurl", ""),
            "licence": strip_html(meta.get("LicenseShortName", {}).get("value", "")),
            "author": strip_html(meta.get("Artist", {}).get("value", "")),
            "description": strip_html(meta.get("ImageDescription", {}).get("value", "")),
        })
        if kept % 25 == 0:
            print(f"    downloaded {kept}/{args.limit}", end="\r")
        time.sleep(0.05)

    print()
    with manifest.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]) if rows else ["file"],
                           delimiter="\t")
        w.writeheader()
        w.writerows(rows)

    print(f"== kept {kept} -> {args.out}")
    print(f"== skipped {stats}")
    if failures:
        print(f"== NOTE {len(failures)} categories were unreachable; the pool "
              f"is smaller than the plan intends: {failures}")
    print(f"== provenance {manifest}")
    return 0 if kept else 1


if __name__ == "__main__":
    raise SystemExit(main())
