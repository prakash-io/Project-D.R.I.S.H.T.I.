#!/usr/bin/env python3
"""Build the offline road-graph extract for the driver app (DB-02 / MOB-06).

    ai-services/.venv/bin/python scripts/build_mobile_extract.py

Writes `data/artifacts/edge/road_graph.sqlite`, which the app ships and
queries by bounding box to map-match dead-reckoned coordinates during a GNSS
blackout.

SQLite + R*Tree, not SpatiaLite
-------------------------------
The plan asks for a SpatiaLite extract. This is plain SQLite with an R*Tree
index instead, and the reason is the target: **React Native's SQLite does not
load `mod_spatialite`.** WatermelonDB runs on the stock sqlite the OS ships,
so a SpatiaLite file would need a native extension bundled and loaded on both
platforms before a single query could run -- and if it failed to load, the
map-matcher would fail exactly when the truck is in a valley with no network.

R*Tree is compiled into stock SQLite on iOS and Android, needs no extension,
and answers the only spatial question the app asks:

    SELECT e.id, e.geom
    FROM road_edges_rtree r JOIN road_edges e ON e.id = r.id
    WHERE r.max_lon >= :min_lon AND r.min_lon <= :max_lon
      AND r.max_lat >= :min_lat AND r.min_lat <= :max_lat;

Geometry is WKB in a BLOB, EPSG:4326, decoded on device.

Simplification
--------------
The full network is ~118 MB of geometry across 12.65 M vertices, which is not
something to put in an app bundle. Geometry is simplified with
ST_SimplifyPreserveTopology, which cannot collapse a line to fewer than two
points or move an endpoint, so the graph stays connected and source/target
stay valid.

The default tolerance is ~11 m. That is far below the error it has to
correct: the IDR speed model carries 4.0 m/s MAE, which integrates to roughly
240 m of along-track drift per minute of blackout (R6). Shaving 11 m off a
road's shape costs nothing against that, and the snap target is the road's
centreline either way.
"""

from __future__ import annotations

import argparse
import csv
import json
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "artifacts" / "edge" / "road_graph.sqlite"

CONTAINER = "drishti-postgis"
DB_USER = "drishti"
DB_NAME = "drishti"

#: ~11 m at these latitudes. See the note above on why this is safe.
DEFAULT_TOLERANCE_DEG = 1e-4


def export_edges(tolerance: float, highways: list[str] | None, csv_path: Path) -> int:
    where = ""
    if highways:
        classes = ",".join(f"'{h}'" for h in highways)
        where = f"WHERE highway IN ({classes})"

    query = f"""
        COPY (
            SELECT id, source, target, osm_id,
                   coalesce(name, ''), coalesce(highway, ''),
                   CASE WHEN is_bridge THEN 1 ELSE 0 END,
                   round(length_m::numeric, 1),
                   ST_XMin(geom), ST_YMin(geom), ST_XMax(geom), ST_YMax(geom),
                   encode(ST_AsBinary(ST_SimplifyPreserveTopology(geom, {tolerance})), 'hex')
            FROM road_edges
            {where}
        ) TO STDOUT WITH (FORMAT csv)
    """
    with open(csv_path, "wb") as fh:
        result = subprocess.run(
            ["docker", "exec", "-i", CONTAINER, "psql", "-v", "ON_ERROR_STOP=1",
             "-U", DB_USER, "-d", DB_NAME, "-c", query],
            stdout=fh, stderr=subprocess.PIPE,
        )
    if result.returncode != 0:
        raise RuntimeError(f"export failed: {result.stderr.decode().strip()}")
    with open(csv_path) as fh:
        return sum(1 for _ in fh)


def build_sqlite(csv_path: Path, out: Path, tolerance: float,
                 highways: list[str] | None) -> dict:
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()

    connection = sqlite3.connect(out)
    cursor = connection.cursor()
    cursor.executescript("""
        PRAGMA journal_mode = OFF;
        PRAGMA synchronous  = OFF;

        CREATE TABLE road_edges (
            id        INTEGER PRIMARY KEY,
            source    INTEGER NOT NULL,
            target    INTEGER NOT NULL,
            osm_id    INTEGER,
            name      TEXT,
            highway   TEXT,
            is_bridge INTEGER NOT NULL DEFAULT 0,
            length_m  REAL,
            geom      BLOB NOT NULL      -- WKB LineString, EPSG:4326
        );

        -- Stock-SQLite spatial index. This is what makes the bounding-box
        -- lookup a tree descent rather than a scan of every edge.
        CREATE VIRTUAL TABLE road_edges_rtree USING rtree(
            id, min_lon, max_lon, min_lat, max_lat
        );

        -- The map-matcher walks the graph from the last matched edge, so it
        -- needs the endpoints indexed as well as the geometry.
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    """)

    rows = 0
    with open(csv_path, newline="") as fh:
        for record in csv.reader(fh):
            (edge_id, source, target, osm_id, name, highway, is_bridge,
             length_m, min_lon, min_lat, max_lon, max_lat, wkb_hex) = record
            cursor.execute(
                "INSERT INTO road_edges (id, source, target, osm_id, name, highway,"
                " is_bridge, length_m, geom) VALUES (?,?,?,?,?,?,?,?,?)",
                (int(edge_id), int(source), int(target),
                 int(osm_id) if osm_id else None, name or None, highway or None,
                 int(is_bridge), float(length_m), bytes.fromhex(wkb_hex)))
            cursor.execute(
                "INSERT INTO road_edges_rtree (id, min_lon, max_lon, min_lat, max_lat)"
                " VALUES (?,?,?,?,?)",
                (int(edge_id), float(min_lon), float(max_lon),
                 float(min_lat), float(max_lat)))
            rows += 1

    cursor.executescript("""
        CREATE INDEX road_edges_source_idx ON road_edges (source);
        CREATE INDEX road_edges_target_idx ON road_edges (target);
        CREATE INDEX road_edges_highway_idx ON road_edges (highway);
    """)

    info = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "source": "PostGIS road_edges (scripts/ingest_geo.py)",
        "crs": "EPSG:4326",
        "geometry_encoding": "WKB LineString in a BLOB",
        "simplify_tolerance_deg": tolerance,
        "highway_filter": ",".join(highways) if highways else "all",
        "edges": rows,
        "spatial_index": "rtree(id, min_lon, max_lon, min_lat, max_lat)",
    }
    cursor.executemany("INSERT INTO meta (key, value) VALUES (?,?)",
                       [(k, str(v)) for k, v in info.items()])
    connection.commit()
    cursor.execute("VACUUM")
    connection.commit()
    connection.close()
    return info


def verify(out: Path) -> None:
    """Prove the index is used and a realistic query is fast."""
    connection = sqlite3.connect(out)
    cursor = connection.cursor()

    # A 2 km box around Guwahati -- the size a map-matcher would ask for.
    box = (91.72, 91.74, 26.13, 26.15)
    query = ("SELECT count(*) FROM road_edges_rtree "
             "WHERE max_lon >= ? AND min_lon <= ? AND max_lat >= ? AND min_lat <= ?")
    plan = cursor.execute("EXPLAIN QUERY PLAN " + query,
                          (box[0], box[1], box[2], box[3])).fetchall()

    start = time.perf_counter()
    for _ in range(100):
        cursor.execute(query, (box[0], box[1], box[2], box[3])).fetchone()
    elapsed_ms = (time.perf_counter() - start) * 10  # /100 then *1000

    hits = cursor.execute(query, (box[0], box[1], box[2], box[3])).fetchone()[0]
    total = cursor.execute("SELECT count(*) FROM road_edges").fetchone()[0]
    connection.close()

    print(f"    bbox query plan: {plan[0][-1]}")
    print(f"    2 km box near Guwahati -> {hits} of {total:,} edges in "
          f"{elapsed_ms:.3f} ms/query")
    # SQLite words this as "SCAN <table> VIRTUAL TABLE INDEX <n>:<blob>" -- the
    # marker is "VIRTUAL TABLE INDEX", with no "USING". A plain "SCAN
    # road_edges_rtree" with no index term would mean the R*Tree was ignored
    # and every edge is being examined.
    if "VIRTUAL TABLE INDEX" not in plan[0][-1].upper():
        raise SystemExit(
            f"    ERROR: the R*Tree index is not being used -- plan was "
            f"{plan[0][-1]!r}. The extract would be a linear scan on device.")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--tolerance", type=float, default=DEFAULT_TOLERANCE_DEG,
                    help="ST_SimplifyPreserveTopology tolerance in degrees")
    ap.add_argument("--highway", nargs="*", default=None,
                    help="restrict to these OSM highway classes (default: all)")
    ap.add_argument("--scratch", type=Path,
                    default=Path("/private/tmp/claude-501/-Users-prakash-drishti/"
                                 "23bc32d8-7d43-4ded-85f9-b6d3f3828efb/scratchpad"))
    args = ap.parse_args()
    args.scratch.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    csv_path = args.scratch / "mobile_edges.csv"
    print(f"==> exporting from PostGIS (tolerance {args.tolerance} deg"
          f"{', ' + ','.join(args.highway) if args.highway else ', all classes'})")
    rows = export_edges(args.tolerance, args.highway, csv_path)
    print(f"    {rows:,} edges ({time.time() - t0:.1f}s)")

    print(f"==> building {args.out.name}")
    info = build_sqlite(csv_path, args.out, args.tolerance, args.highway)
    size_mb = args.out.stat().st_size / 1e6
    print(f"    {info['edges']:,} edges, {size_mb:.1f} MB")

    print("==> verifying")
    verify(args.out)

    meta_path = args.out.with_suffix(".json")
    info["size_mb"] = round(size_mb, 2)
    meta_path.write_text(json.dumps(info, indent=2) + "\n")
    # relative_to raises for a path outside the repo, which --out routinely is.
    try:
        shown = args.out.relative_to(ROOT)
    except ValueError:
        shown = args.out
    print(f"==> wrote {shown} and {meta_path.name} in {time.time() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
