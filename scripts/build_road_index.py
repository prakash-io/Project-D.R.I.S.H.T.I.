#!/usr/bin/env python3
"""Build the missing road-network spatial index (ML-02).

`dist_to_road_m` is one of the eight features the hazard model consumes, but
`data/processed/indices/` shipped only three indices -- rivers, bridges and
hazard pinch points. There is no `road_network_spatial_index.pkl`, so
`/predict-hazard` has no way to produce that feature for a live coordinate.
This builds one from `road_network.parquet` in the *same projection* as the
three that shipped, so all four are queried identically.

    ai-services/.venv/bin/python scripts/build_road_index.py

Design notes
------------
*   **Vertices, not lines.** A KDTree indexes points, so the road geometry is
    reduced to its vertices. The error that introduces is bounded by half the
    vertex spacing, and this source is already atomised into 2-point segments
    averaging ~26 m, so the worst case is ~13 m against a feature whose
    training-set median is 1778 m. Irrelevant.

*   **Deduplicated.** The 238,170 ways carry 12.65 M vertices but only
    ~6.25 M distinct ones -- every interior vertex is shared by the two
    segments that meet there. Deduplicating halves both the tree and the
    pickle for no loss.

*   **Lean payload.** The upstream indices carry a `feature_records` list with
    one dict per point, which is why the pinch-point index is 133 MB for
    609 k points. `dist_to_road_m` needs no attributes, so this stores plain
    lat/lon arrays instead -- 6.25 M points in less space than 609 k dicts.

*   **float32 storage, float64 tree.** Coordinates are stored as float32
    (~7 significant digits, i.e. ~1 cm at these latitudes) and promoted on
    load. cKDTree requires float64 internally.
"""

from __future__ import annotations

import argparse
import json
import pickle
import sys
import time
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import shapely
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "ai-services"))

from drishti_ai.geo import CENTER_LAT_DEG, M_PER_DEG_LAT, project  # noqa: E402

DEFAULT_SOURCE = ROOT / "data" / "raw" / "geo" / "road_network.parquet"
DEFAULT_OUT = ROOT / "data" / "processed" / "indices" / "road_network_spatial_index.pkl"

# Read the parquet in chunks: the WKB column expands to ~12.65 M coordinate
# pairs and holding every batch's decoded geometry at once is wasteful.
BATCH_ROWS = 20_000


class LeanSpatialIndex:
    """Pickled payload. Deliberately a plain class with no behaviour.

    `drishti_ai.geo.NearestIndex` is what queries it. Keeping the pickled
    object dumb means a change to query logic never invalidates the artefact,
    and unpickling never runs project code.
    """

    def __init__(self, layer_name, tree, lat, lon, center_lat, m_per_deg_lat, source, created_at):
        self.layer_name = layer_name
        self.tree = tree
        self.lat = lat
        self.lon = lon
        self.center_lat = center_lat
        self.m_per_deg_lat = m_per_deg_lat
        self.source = source
        self.created_at = created_at


def iter_vertices(source: Path):
    """Yield (lon, lat) float64 arrays, one per parquet batch."""
    pf = pq.ParquetFile(source)
    for batch in pf.iter_batches(batch_size=BATCH_ROWS, columns=["geometry"]):
        wkb = batch.column("geometry").to_pylist()
        geoms = shapely.from_wkb([w for w in wkb if w is not None])
        # get_coordinates flattens every ring/part of every geometry into one
        # (N, 2) array of (x, y) = (lon, lat). GeometryCollections included --
        # three rows in this source are collections, and their line parts
        # carry vertices that belong in the index like any other.
        coords = shapely.get_coordinates(geoms)
        if coords.size:
            yield coords


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args()

    if not args.source.exists():
        sys.exit(f"error: {args.source} not found")

    t0 = time.time()
    print(f"==> reading {args.source.name}")
    chunks = list(iter_vertices(args.source))
    coords = np.concatenate(chunks) if chunks else np.empty((0, 2))
    del chunks
    print(f"    {len(coords):,} raw vertices in {time.time() - t0:.1f}s")

    # Deduplicate on the exact float64 bit pattern. Shared vertices come from
    # the same source coordinate, so they are bit-identical -- no rounding
    # tolerance is needed and any tolerance would risk merging genuinely
    # distinct nearby vertices.
    coords = np.unique(coords, axis=0)
    print(f"    {len(coords):,} distinct vertices")

    lon = coords[:, 0].astype(np.float32)
    lat = coords[:, 1].astype(np.float32)

    # Build the tree from the float32-rounded values, not the float64
    # originals: the artefact stores float32, so the tree must agree with what
    # a reader will re-project, or geo.NearestIndex.verify_projection fails.
    x, y = project(lon.astype(np.float64), lat.astype(np.float64))
    print("==> building cKDTree")
    t1 = time.time()
    tree = cKDTree(np.column_stack([x, y]))
    print(f"    built in {time.time() - t1:.1f}s")

    payload = LeanSpatialIndex(
        layer_name="NER Road Network (vertices)",
        tree=tree,
        lat=lat,
        lon=lon,
        center_lat=CENTER_LAT_DEG,
        m_per_deg_lat=M_PER_DEG_LAT,
        source=str(args.source.relative_to(ROOT)),
        created_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
    )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "wb") as fh:
        pickle.dump(payload, fh, protocol=pickle.HIGHEST_PROTOCOL)
    size_mb = args.out.stat().st_size / 1e6

    meta = {
        "index_file": args.out.name,
        "layer_name": payload.layer_name,
        "indexed_points": int(len(lat)),
        "source_records": pq.ParquetFile(args.source).metadata.num_rows,
        "size_mb": round(size_mb, 2),
        "projection": {
            "center_lat": CENTER_LAT_DEG,
            "m_per_deg_lat": M_PER_DEG_LAT,
            "formula": "x = lon * m_per_deg_lat * cos(center_lat); y = lat * m_per_deg_lat",
        },
        "bbox": {
            "min_lat": float(lat.min()), "max_lat": float(lat.max()),
            "min_lon": float(lon.min()), "max_lon": float(lon.max()),
        },
        "created_at": payload.created_at,
    }
    meta_path = args.out.with_suffix(".json")
    meta_path.write_text(json.dumps(meta, indent=2) + "\n")

    print(f"==> wrote {args.out} ({size_mb:.1f} MB) and {meta_path.name}")
    print(f"==> total {time.time() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
