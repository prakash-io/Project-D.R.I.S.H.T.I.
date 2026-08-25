#!/usr/bin/env python3
"""Report which datasets in data/MANIFEST.yml are present on disk.

Every AI and routing task in the checklist is blocked on some subset of these
files, so this answers "what can I actually work on right now".

    python3 scripts/check_data.py            # full table
    python3 scripts/check_data.py --missing  # only what is absent
    python3 scripts/check_data.py --task DB-02

Exits 1 if any required dataset is missing, so CI can gate on it.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    sys.exit("PyYAML is required: pip install pyyaml")

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "data" / "MANIFEST.yml"

GREEN, RED, YELLOW, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"


def human_size(n: int) -> str:
    step = 1024.0
    size = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if size < step:
            return f"{size:.0f}{unit}" if unit == "B" else f"{size:.1f}{unit}"
        size /= step
    return f"{size:.1f}TB"


def measure(path: Path) -> tuple[bool, int]:
    """Return (exists, size). Directory datasets report their recursive size."""
    if not path.exists():
        return False, 0
    if path.is_dir():
        total = sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
        # A directory holding only .gitkeep is a placeholder, not a dataset.
        return total > 0, total
    return True, path.stat().st_size


def missing_members(entry: dict, path: Path) -> list[str]:
    """Named files a directory dataset promises but does not contain.

    A directory dataset can exist and still be unusable — IO-VNBD arrives as a
    complete-looking tree of Git LFS pointer stubs. Presence of the directory
    is not evidence the data is there, so check the members the manifest names.
    """
    files = entry.get("files")
    if not isinstance(files, dict) or not path.is_dir():
        return []
    return [name for name in files if not (path / name).exists()]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--missing", action="store_true", help="show only absent datasets")
    ap.add_argument("--task", help="filter to datasets a checklist task consumes, e.g. ML-04")
    args = ap.parse_args()

    if not MANIFEST.exists():
        sys.exit(f"manifest not found: {MANIFEST}")

    entries = yaml.safe_load(MANIFEST.read_text())["datasets"]

    if args.task:
        task = args.task.upper()
        entries = [e for e in entries if task in e.get("consumed_by", [])]
        if not entries:
            sys.exit(f"no dataset in the manifest is consumed by {task}")

    rows, unusable_required = [], []
    for e in entries:
        path = ROOT / e["path"]
        exists, size = measure(path)
        gaps = missing_members(e, path)

        # `status:` is the manifest saying "this file is on disk but is not the
        # thing it claims to be" -- an LFS stub, or an artifact not yet trained.
        # Trusting st_size here is exactly how a blocked task looks unblocked.
        status = e.get("status")
        usable = exists and not gaps and not status

        if not usable and e.get("required", False):
            unusable_required.append(e)
        if args.missing and usable:
            continue
        rows.append((e, usable, size, status, gaps))

    if not rows:
        print(f"{GREEN}all datasets present{RESET}")
        return 0

    width = max(len(e["id"]) for e, *_ in rows)
    for e, usable, size, status, gaps in rows:
        mark = f"{GREEN}ok{RESET}" if usable else f"{RED}--{RESET}"
        detail = human_size(size) if size else ("required" if e.get("required") else "optional")
        origin = f" {YELLOW}(source unrecorded){RESET}" if e.get("source") == "TODO" else ""
        print(f" {mark}  {e['id']:<{width}}  {detail:>9}  {DIM}{e['path']}{RESET}{origin}")
        if status:
            print(f"     {YELLOW}{status}{RESET}")
        if gaps:
            shown = ", ".join(gaps[:4]) + (f" (+{len(gaps) - 4})" if len(gaps) > 4 else "")
            print(f"     {YELLOW}missing members: {shown}{RESET}")

    if unusable_required:
        blocked = sorted({t for e in unusable_required for t in e.get("consumed_by", [])})
        names = ", ".join(e["id"] for e in unusable_required)
        print(f"\n{RED}{len(unusable_required)} required dataset(s) unusable{RESET}: {names}")
        if blocked:
            print(f"blocked tasks: {', '.join(blocked)}")
        return 1

    print(f"\n{GREEN}all required datasets present{RESET}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
