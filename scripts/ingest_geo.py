#!/usr/bin/env python3
"""Build the routing topology and load it into PostGIS (DB-02).

    ai-services/.venv/bin/python scripts/ingest_geo.py            # full load
    ai-services/.venv/bin/python scripts/ingest_geo.py --limit 20000

Loads `road_network.parquet` as a routable graph, `bridges.parquet` as an
attribute on it, and `districts.parquet` as polygons.

Why this is not a `ST_Dump` into a table
----------------------------------------
The plan says "import road_network.parquet, establishing the routing
topology", which reads like a straight load. It is not, because of what the
file actually contains: its 238,170 rows are not 238,170 road segments. Each
row is a MultiLineString of individual **2-point segments** -- 6,326,609 of
them, 12.65 M vertices, 162,051 km of road.

Loading those as edges would hand pgRouting a 6.3 M edge graph. It would be
topologically correct, since every junction is a shared endpoint, and
useless: pgr_aStar reads its entire edge set on every call, so a single
reroute would spend ten seconds fetching rows before it started searching.

So the segments are contracted back into real road links. A vertex is a
**junction** when either:

*   its degree is not 2 -- a fork, a crossing or a dead end; or
*   it joins two segments belonging to different OSM ways, which is where the
    road's name or classification changes and where the attributes would
    otherwise have to be silently picked from one side.

Everything between two junctions is a single edge carrying the full vertex
chain as its geometry, so the drawn route still follows every bend.

Measured on this dataset: 6,252,739 distinct vertices, of which 117,924 are
dead ends (degree 1), 5,884,516 are pass-through (degree 2), and 250,299 are
forks (degree 3+). The contraction is what makes the graph routable at
interactive speed.

One-way streets
---------------
There is no `oneway` column in this extract -- the 13 tag columns are id,
name, highway, surface, smoothness, maxspeed, bridge, tunnel, ford, cutting,
embankment, incline, lanes. Every edge is therefore loaded as bidirectional
(`cost = reverse_cost`). That is the honest reading of the data, and it will
route a truck the wrong way up a one-way street. Flagged in REVISION.md.
"""

from __future__ import annotations

import argparse
import csv
import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import shapely

ROOT = Path(__file__).resolve().parent.parent
GEO = ROOT / "data" / "raw" / "geo"

CONTAINER = "drishti-postgis"
DB_USER = "drishti"
DB_NAME = "drishti"

BATCH_ROWS = 20_000

# OSM tag values that mean "yes" for the boolean bridge/tunnel columns.
TRUTHY = {"yes", "true", "1", "viaduct", "boardwalk", "aqueduct", "cantilever",
          "covered", "movable", "suspension", "trestle", "culvert", "building_passage"}


def psql(sql: str, quiet: bool = True) -> str:
    """Run one statement in the container. Raises on any SQL error."""
    flags = ["-v", "ON_ERROR_STOP=1", "-U", DB_USER, "-d", DB_NAME]
    if quiet:
        flags += ["-qtA"]
    result = subprocess.run(
        ["docker", "exec", "-i", CONTAINER, "psql", *flags, "-c", sql],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"psql failed:\n{sql[:400]}\n{result.stderr.strip()}")
    return result.stdout.strip()


def copy_csv(path: Path, table: str, columns: str) -> None:
    """Stream a CSV into a table with COPY."""
    command = (f"\\copy {table} ({columns}) FROM STDIN WITH (FORMAT csv)")
    with open(path, "rb") as fh:
        result = subprocess.run(
            ["docker", "exec", "-i", CONTAINER, "psql", "-v", "ON_ERROR_STOP=1",
             "-U", DB_USER, "-d", DB_NAME, "-c", command],
            stdin=fh, capture_output=True, text=True,
        )
    if result.returncode != 0:
        raise RuntimeError(f"COPY into {table} failed: {result.stderr.strip()}")


# ------------------------------------------------------------------ reading

def read_road_segments(path: Path, limit: int | None) -> tuple[np.ndarray, np.ndarray, list]:
    """Return (coords, segment_way_index, way_attributes).

    `coords` is (2S, 2): the start points of every segment followed by the end
    points. `segment_way_index` maps each segment to its row in
    `way_attributes`.
    """
    parquet = pq.ParquetFile(path)
    columns = ["id", "name", "highway", "surface", "bridge", "tunnel", "geometry"]

    starts, ends, way_index, attributes = [], [], [], []
    rows_read = 0

    for batch in parquet.iter_batches(batch_size=BATCH_ROWS, columns=columns):
        data = batch.to_pydict()
        geoms = shapely.from_wkb(data["geometry"])
        for i, geom in enumerate(geoms):
            if geom is None or geom.is_empty:
                continue
            parts = _line_parts(geom)
            if parts.size == 0:
                continue

            way_row = len(attributes)
            attributes.append((
                data["id"][i], data["name"][i], data["highway"][i],
                data["surface"][i], data["bridge"][i], data["tunnel"][i],
            ))
            # parts is (P, 2, 2): P two-point segments.
            starts.append(parts[:, 0, :])
            ends.append(parts[:, 1, :])
            way_index.append(np.full(len(parts), way_row, dtype=np.int32))

        rows_read += batch.num_rows
        if limit is not None and rows_read >= limit:
            break

    start = np.concatenate(starts)
    end = np.concatenate(ends)
    return (np.vstack([start, end]),
            np.concatenate(way_index),
            attributes)


def _line_parts(geom) -> np.ndarray:
    """Every 2-point segment of a geometry, as (P, 2, 2).

    `get_parts` twice, deliberately: three rows in this source are
    GeometryCollections whose members are themselves MultiLineStrings, so one
    pass leaves nested geometry behind. Non-line members (the collections also
    carry points) are dropped -- they are not road.
    """
    pieces = []
    for part in shapely.get_parts(shapely.get_parts(geom)):
        if shapely.get_type_id(part) != 1:      # 1 == LineString
            continue
        xy = shapely.get_coordinates(part)
        if len(xy) < 2:
            continue
        pieces.append(np.stack([xy[:-1], xy[1:]], axis=1))
    if not pieces:
        return np.empty((0, 2, 2))
    return np.concatenate(pieces)


# -------------------------------------------------------------- contraction

def build_edges(coords: np.ndarray, way_index: np.ndarray) -> tuple:
    """Contract 2-point segments into junction-to-junction edges."""
    n_segments = len(way_index)

    vertices, inverse = np.unique(coords, axis=0, return_inverse=True)
    inverse = inverse.reshape(-1)
    v_from = inverse[:n_segments]
    v_to = inverse[n_segments:]
    n_vertices = len(vertices)

    degree = np.bincount(np.concatenate([v_from, v_to]), minlength=n_vertices)

    # CSR adjacency: for each vertex, the segments incident to it.
    incident_vertex = np.concatenate([v_from, v_to])
    incident_segment = np.concatenate([np.arange(n_segments), np.arange(n_segments)])
    order = np.argsort(incident_vertex, kind="stable")
    incident_vertex = incident_vertex[order]
    incident_segment = incident_segment[order]
    offsets = np.zeros(n_vertices + 1, dtype=np.int64)
    np.cumsum(np.bincount(incident_vertex, minlength=n_vertices), out=offsets[1:])

    is_junction = degree != 2

    # A degree-2 vertex where the two segments come from different OSM ways is
    # also a junction: it is where name/highway change, and merging across it
    # would force the edge to inherit attributes from an arbitrary side.
    two = np.flatnonzero(degree == 2)
    left = incident_segment[offsets[two]]
    right = incident_segment[offsets[two] + 1]
    is_junction[two[way_index[left] != way_index[right]]] = True

    used = np.zeros(n_segments, dtype=bool)
    chains: list[list[int]] = []
    chain_way: list[int] = []

    def walk(seed_segment: int, seed_vertex: int) -> None:
        path = [seed_vertex]
        vertex = seed_vertex
        segment = seed_segment
        while True:
            used[segment] = True
            nxt = v_to[segment] if v_from[segment] == vertex else v_from[segment]
            path.append(nxt)
            if is_junction[nxt]:
                break
            following = -1
            for slot in range(offsets[nxt], offsets[nxt + 1]):
                candidate = incident_segment[slot]
                if candidate != segment and not used[candidate]:
                    following = candidate
                    break
            if following < 0:
                break
            segment, vertex = following, nxt
        chains.append(path)
        chain_way.append(int(way_index[seed_segment]))

    for vertex in np.flatnonzero(is_junction):
        for slot in range(offsets[vertex], offsets[vertex + 1]):
            segment = incident_segment[slot]
            if not used[segment]:
                walk(segment, int(vertex))

    # Whatever is left is a closed ring of degree-2 vertices with no junction
    # on it -- a roundabout or a loop road. Break each at its first vertex.
    for segment in np.flatnonzero(~used):
        walk(int(segment), int(v_from[segment]))

    return chains, chain_way, vertices


def chains_to_geometry(chains: list[list[int]], vertices: np.ndarray):
    """Build one LineString per chain, vectorised."""
    lengths = np.fromiter((len(c) for c in chains), dtype=np.int64, count=len(chains))
    flat = np.concatenate([np.asarray(c, dtype=np.int64) for c in chains])
    xy = vertices[flat]
    part = np.repeat(np.arange(len(chains), dtype=np.int64), lengths)
    return shapely.linestrings(xy, indices=part)


# ------------------------------------------------------------------- driver

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--limit", type=int, default=None,
                    help="only read this many parquet rows (for a smoke run)")
    ap.add_argument("--scratch", type=Path,
                    default=Path("/private/tmp/claude-501/-Users-prakash-drishti/"
                                 "23bc32d8-7d43-4ded-85f9-b6d3f3828efb/scratchpad"))
    ap.add_argument("--skip-districts", action="store_true")
    args = ap.parse_args()
    args.scratch.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    print(f"==> reading {(GEO / 'road_network.parquet').name}")
    coords, way_index, attributes = read_road_segments(GEO / "road_network.parquet",
                                                       args.limit)
    n_segments = len(way_index)
    print(f"    {len(attributes):,} ways -> {n_segments:,} two-point segments "
          f"({time.time() - t0:.1f}s)")

    t1 = time.time()
    print("==> contracting to junction-to-junction edges")
    chains, chain_way, vertices = build_edges(coords, way_index)
    print(f"    {len(vertices):,} distinct vertices -> {len(chains):,} edges "
          f"({time.time() - t1:.1f}s)")

    geometries = chains_to_geometry(chains, vertices)
    wkb = shapely.to_wkb(geometries, hex=True)

    # Bridges arrive as a separate file with the same schema, filtered to
    # bridge tags -- so they are an attribute of road_network, not a layer.
    bridge_ids = set()
    if (GEO / "bridges.parquet").exists():
        table = pq.read_table(GEO / "bridges.parquet", columns=["id"])
        bridge_ids = set(table.column("id").to_pylist())
        print(f"==> {len(bridge_ids):,} bridge way ids")

    csv_path = args.scratch / "road_edges.csv"
    print(f"==> writing {csv_path.name}")
    with open(csv_path, "w", newline="") as fh:
        writer = csv.writer(fh)
        for i, chain in enumerate(chains):
            osm_id, name, highway, surface, bridge, tunnel = attributes[chain_way[i]]
            writer.writerow([
                chain[0], chain[-1], osm_id, name, highway, surface,
                str(bridge).lower() in TRUTHY or osm_id in bridge_ids,
                str(tunnel).lower() in TRUTHY,
                wkb[i],
            ])

    print("==> loading into PostGIS")
    psql("TRUNCATE road_edges RESTART IDENTITY CASCADE;")
    psql("""
        DROP TABLE IF EXISTS stage_edges;
        CREATE UNLOGGED TABLE stage_edges (
            source BIGINT, target BIGINT, osm_id BIGINT, name TEXT,
            highway TEXT, surface TEXT, is_bridge BOOLEAN, is_tunnel BOOLEAN,
            geom GEOMETRY);
    """)
    t2 = time.time()
    copy_csv(csv_path, "stage_edges",
             "source,target,osm_id,name,highway,surface,is_bridge,is_tunnel,geom")
    print(f"    staged in {time.time() - t2:.1f}s")

    # cost is metres. route_astar's heuristic factor (111320 m/degree) assumes
    # metres, so switching cost to travel time would need that changed too.
    psql("""
        INSERT INTO road_edges
            (source, target, cost, reverse_cost, geom, name, osm_id,
             highway, surface, is_bridge, is_tunnel, length_m)
        SELECT source, target,
               ST_Length(geom::geography), ST_Length(geom::geography),
               ST_SetSRID(geom, 4326)::geometry(LineString, 4326),
               name, osm_id, highway, surface, is_bridge, is_tunnel,
               ST_Length(geom::geography)
        FROM stage_edges
        WHERE ST_NPoints(geom) >= 2 AND NOT ST_IsEmpty(geom);
        DROP TABLE stage_edges;
    """)
    print(f"    road_edges: {psql('SELECT count(*) FROM road_edges;')} rows")
    print(f"    road_nodes: {psql('SELECT rebuild_road_nodes();')} rows")

    # Components must be recomputed here, not left to whoever remembers.
    # nearest_road_node prefers the main component so a truck never routes
    # from an unconnected driveway, and route_astar refuses a cross-component
    # request outright instead of returning an empty path that reads as
    # "everything is blocked".
    print("==> connected components")
    components, main, largest = psql(
        "SELECT components, largest_component, largest_nodes "
        "FROM rebuild_road_components();").split("|")
    psql("SELECT refresh_road_graph_meta();")
    total = int(psql("SELECT count(*) FROM road_nodes;"))
    print(f"    {int(components):,} components; largest is {int(largest):,} nodes "
          f"({int(largest) / total:.2%} of the graph), id {main}")

    if not args.skip_districts:
        load_districts(args.scratch)

    print("==> ANALYZE")
    psql("ANALYZE road_edges; ANALYZE road_nodes; ANALYZE districts;")
    print(f"==> total {time.time() - t0:.1f}s")
    return 0


def load_districts(scratch: Path) -> None:
    path = GEO / "districts.parquet"
    if not path.exists():
        print("==> districts.parquet absent, skipping")
        return
    print("==> loading districts")
    table = pq.read_table(path)
    data = table.to_pydict()
    names = table.column_names
    state_key = "state_name" if "state_name" in names else "ST_NM"
    district_key = "district_name" if "district_name" in names else "DISTRICT"

    csv_path = scratch / "districts.csv"
    with open(csv_path, "w", newline="") as fh:
        writer = csv.writer(fh)
        for i in range(table.num_rows):
            geom = shapely.from_wkb(data["geometry"][i])
            # The column is typed MultiPolygon; plain Polygons are promoted so
            # a mixed source cannot fail the load halfway through.
            if shapely.get_type_id(geom) == 3:
                geom = shapely.multipolygons([geom])
            code = data.get("censuscode", [None] * table.num_rows)[i]
            writer.writerow([
                data[state_key][i], data[district_key][i],
                int(code) if code is not None and code == code else None,
                shapely.to_wkb(geom, hex=True),
            ])

    psql("TRUNCATE districts RESTART IDENTITY;")
    psql("""
        DROP TABLE IF EXISTS stage_districts;
        CREATE UNLOGGED TABLE stage_districts (
            state_name TEXT, district_name TEXT, censuscode INTEGER, geom GEOMETRY);
    """)
    copy_csv(csv_path, "stage_districts", "state_name,district_name,censuscode,geom")
    psql("""
        INSERT INTO districts (state_name, district_name, censuscode, geom)
        SELECT state_name, district_name, censuscode,
               ST_SetSRID(geom, 4326)::geometry(MultiPolygon, 4326)
        FROM stage_districts;
        DROP TABLE stage_districts;
    """)
    print(f"    districts: {psql('SELECT count(*) FROM districts;')} rows")


if __name__ == "__main__":
    raise SystemExit(main())
