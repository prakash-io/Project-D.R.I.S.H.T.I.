# D.R.I.S.H.T.I. — Revision Log

A running record of **what was built, what was used to build it, and why**.

`CLAUDE.md` is the plan (what the platform should be). This file is the
history (what actually exists, and where it diverged from the plan). When the
two disagree, this file is the one that was checked against a running system.

**Every future change gets an entry here** — new file, new dependency, new
version pin, or a decision that a later reader would otherwise have to
reverse-engineer. Newest revision first.

---

## Status at a glance

| Epic | Task | State |
|---|---|---|
| 1 | DB-01 PostGIS + pgRouting | ✅ running, migration applied & smoke-tested |
| 1 | DB-02 GeoPandas → PostGIS ingest | ⬜ next — data ready, not written |
| 1 | API-01…04 Express / BullMQ / incidents / reroute | ⬜ not started |
| 2 | ML-01…06 FastAPI, XGBoost, YOLOv8 | ⬜ not started (data ready) |
| 3 | WEB-01…05 React + Deck.gl dashboard | ⬜ not started |
| 4 | MOB-01…04, 07 React Native + C++ EKF | ⬜ not started |
| 4 | MOB-05/06 TFLite velocity model | 🚫 **blocked** — IO-VNBD is LFS stubs |

Published at
[prakash-io/Project-D.R.I.S.H.T.I.](https://github.com/prakash-io/Project-D.R.I.S.H.T.I.)
· branch `main` · 2 commits.

---

## Tech stack — as actually pinned

Versions here are what is installed and running, not what the plan proposed.

### Infrastructure

| Component | Version | Why this one |
|---|---|---|
| PostgreSQL | 16.9 | Base for the routing DB |
| PostGIS | 3.5.2 | Spatial types, `ST_ClosestPoint`, GIST KNN |
| pgRouting | 3.8.0 | `pgr_aStar`, `pgr_createTopology` |
| Docker image | `pgrouting/pgrouting:16-3.5-3.8.0` | `postgis/postgis` does **not** ship pgRouting — `CREATE EXTENSION pgrouting` fails against it |
| Redis | 7-alpine | BullMQ backend |
| Node.js | 20.19.5 | Local runtime for Express |
| Python | 3.13.9 (anaconda3) | FastAPI + geo tooling |

**Host ports are remapped**: Postgres `5433`, Redis `6380`. An unrelated
`demo_radar` stack already binds 5432/6379. Container-internal ports are
unchanged, so `docker exec` is unaffected.

⚠️ The pgRouting image is **linux/amd64 only** and runs under Rosetta on this
arm64 Mac (`uname -m` → `x86_64`). Fine for development; expect a real
slowdown on `pgr_aStar` over the full 238k-edge graph.

### Pins forced by the data

| Pin | Reason |
|---|---|
| `scikit-learn >= 1.9.0` | `feature_scaler.joblib` was pickled by 1.9.0. Loading under 1.7.2 warns and is not guaranteed to score correctly. |
| CRS `EPSG:4326` everywhere | All supplied vectors *and* rasters are already 4326. Reproject at ingest, never at query time. |

### Not yet installed

`geopandas`, `rasterio`, `shapely`, `xgboost`, `torch`, `ultralytics`,
`tensorflow`, `psycopg` — all needed, none present in the local env yet.
Installed: `sklearn 1.7.2` (needs upgrade), `networkx 3.5`, `pyarrow`, `gdown`.

---

## Data flow, as built so far

Only the first hop exists today. The rest is `CLAUDE.md`'s plan.

```
data/raw/geo/road_network.parquet   238,170 rows, MultiLineString
        │                            ⚠ no source/target/cost columns
        │                            ⚠ some GeometryCollection members
        │
        ├─ [DB-02, NOT YET WRITTEN] ST_Dump → single LineStrings
        │                            then pgr_createTopology
        ▼
   road_edges ──┬── x1,y1,x2,y2 (GENERATED, required by pgr_aStar)
                │
                ▼
        routable_edges  (VIEW)
                │   cost = 999999 WHERE a verified incident blocks the edge
                │   ── computed in the view, never UPDATEd into road_edges
                ▼
        route_astar(start, end, risk_weight, heuristic_factor)
```

---

## R5 — 2026-08-25 · First commit, published to GitHub

**Created**: `LICENSE` (Apache 2.0, inherited from the remote)

**Modified**: `.gitignore` (merged), `REVISION.md`

Remote: `https://github.com/prakash-io/Project-D.R.I.S.H.T.I..git`.
Commit `12ce47f`, 26 files, 1628 insertions, 65 KB.

The remote was **not empty** — GitHub's auto-generated `Initial commit`
(`2c93ff0`) already carried an Apache 2.0 `LICENSE` and a 218-line Python
`.gitignore`. Local `main` had an unrelated history, so a plain push would
have been rejected and a force-push would have destroyed the licence.
Rebased onto `origin/main` instead; the licence is preserved and history is
linear.

`.gitignore` was the only conflict. Resolved by keeping the project rules and
folding in the template's useful Python entries (`.mypy_cache`, `.tox`,
`.nox`, `.ipynb_checkpoints`, `.coverage`, `htmlcov`, `*.egg`).

Deliberately **not** carried over from the template: `lib/`, `lib64/`, `bin/`,
`share/`, `downloads/`, `parts/`. Those are virtualenv-layout entries; in this
repo they would silently hide real source directories. The template also had
no rule for `data/` — on its own it would have tried to commit 9.5 GB,
including a 1.5 GB pickle and 7.4 GB of GeoTIFFs.

Verified after the rebase: `git check-ignore` still catches the data payload,
working tree clean, 27 files tracked totalling 65 KB.

---

## R4 — 2026-08-25 · Dataset ingest and audit

**Created**
- `data/MANIFEST.yml` → v2 (rewritten from v1)
- `data/README.md` (rewritten)
- `REVISION.md` (this file)

**Modified**
- `scripts/check_data.py` — added `status:` and per-member checking
- `.env.example` — corrected paths, added class list and KDTree paths
- `data/raw/vision/incident-yolo/data.yaml` — repointed from `D:/SIH DATA/...`

**Tools used**: `gdown` (folder listing), `pyarrow` (parquet schemas),
`joblib` (scaler introspection), raw TIFF header parsing (rasterio absent),
`shasum -a 256` (dedup proof).

### What landed

9.5 GB in `data/`, merged from six `CLEAN_READY_DATA` Drive chunks. Those six
were a **partition, not copies** — 2810 distinct paths, zero overlap, verified
before anything was moved. Moved rather than copied (same APFS volume, so a
rename: instant, no extra space).

Real duplicates deleted, each proven byte-identical by SHA-256 first:
`ner_road_graph.pkl` (1.5 GB, = `.gpickle`), `roads.parquet` (125 MB, =
`road_network.parquet`), plus older standalone copies of folders 02 and 05.
11.65 GB → 9.5 GB.

Post-merge integrity: 12/12 parquets read to full row count, 27/27 GeoTIFFs
parse, no `.part` remnants.

### Divergences from the plan found by reading the files

Each of these fails **silently** rather than raising — that is why they are
recorded rather than just fixed.

| `CLAUDE.md` says | Reality | Impact |
|---|---|---|
| `arunachal_pradesh_30m.tif` | **27 rasters**, 9 regions × dem/slope/aspect, 7.4 GB, all EPSG:4326 DEFLATE float32 | Slope/aspect are *supplied*, not derived. ML-02 must hold 27 lazy rasterio handles and dispatch by bounds — never load arrays. |
| `StandardScaler` | **RobustScaler** (median / IQR) | A `(x-mean)/std` reimplementation is wrong. |
| 3 classes: landslide/flood/obstruction | **4 classes**: `NORMAL_TERRAIN`, `FLOODED_ROAD_OR_SUBMERGED`, `ACTIVE_LANDSLIDE_DEBRIS`, `DAMAGED_BRIDGE_INFRASTRUCTURE` | **Contradicts the `incidents.kind` CHECK in migration 001** — unresolved, see Open Questions. |
| `rainfall_1h/24h/72h` | `rainfall_72h_mm`, `rainfall_24h_mm`, `rainfall_intensity_mmh` | ML-03's Open-Meteo call must produce exactly these three. |
| Binary risk 0–1 | **3-class**: LANDSLIDE_RISK 8130 / SAFE_TERRAIN 8065 / FLOOD_RISK 6000 | WEB-04's 0.85 threshold must name *which* probability. |
| `X_train_2` = 8 features | **10 columns**; `latitude`/`longitude` pass through unscaled | 10 into the scaler raises; 8 in the wrong order does not. A `val` split also exists that the plan never mentioned. |
| `rivers_waterways.parquet` | `river_waterways.parquet` (singular) | Path typo in the plan. |
| `X_train_2` / `feature_scaler_2` | no `_2` suffix on any file | — |

Two more, found only by opening the geometry:

- **`road_network` is not routable as-is.** MultiLineString with some
  GeometryCollection members, and no `source`/`target`/`cost`/`reverse_cost`.
  DB-02 must `ST_Dump` to single parts — one source row becomes N edges, so
  `id` stops being unique and cannot be the primary key — then
  `pgr_createTopology`.
- **KDTrees are in degrees; `dist_to_river_m` is metres.** A KDTree query
  returns Euclidean degree distance, which is neither metres nor uniform
  across latitude. The serving path must convert exactly as training did.

### Blocked

**IO-VNBD contains no data.** All 564 CSVs are 132-byte Git LFS pointer stubs;
GitHub's "Download ZIP" does not resolve LFS. The tree looks complete and the
file count is correct — only the byte sizes reveal it.

```sh
git lfs install && git clone https://github.com/onyekpeu/IO-VNBD
```

`scripts/check_data.py` previously reported this as ✅ (the directory exists,
1.1 MB of stubs). That was the motivation for the `status:` field — a
present-but-useless dataset must report as blocked, or a blocked task looks
ready.

---

## R3 — 2026-08-25 · Docker infrastructure

**Created**: `infra/docker-compose.yml`, `scripts/db_migrate.sh`

**Stack**: Docker Compose, `pgrouting/pgrouting:16-3.5-3.8.0`, `redis:7-alpine`

Three failures worth recording:

1. `/usr/local/bin/docker` was a **dangling symlink** into a deleted
   `Docker.app` — it matched `ls` but failed to exec, so "is docker installed"
   answered ambiguously. Reinstalled via `brew install --cask docker`.
2. First image pin `postgis/postgis:16-3.4` ships **no pgRouting**. Second
   attempt `pgrouting/pgrouting:16-3.4-3.6` does not exist — the tag format is
   `<pg>-<postgis>-<pgrouting>` and PG16 pairs with PostGIS **3.5**.
3. Port 5432 was already allocated by an unrelated `demo_radar` stack (which
   also holds 6379). Left those containers alone; remapped to 5433/6380.

`db_migrate.sh` waits on the container **healthcheck** before applying
migrations — `docker compose up -d` returns a second or two before Postgres
accepts connections, and piping a migration in immediately fails with "the
database system is starting up". It uses `psql -v ON_ERROR_STOP=1`, without
which psql prints the error and still exits 0, making a broken migration look
like a success.

---

## R2 — 2026-08-25 · PostGIS schema and routing

**Created**: `backend/migrations/001_init.sql`,
`backend/migrations/smoke_test.sql`

**Stack**: PostgreSQL 16.9, PostGIS 3.5.2, pgRouting 3.8.0

8 tables (`trucks`, `trips`, `telemetry`, `truck_last_seen`, `road_edges`,
`road_nodes`, `incidents`, `reroutes`), 1 view (`routable_edges`), 4 functions
(`nearest_road_node`, `nearest_road_edge`, `route_astar`, `rebuild_road_nodes`).

### Decisions

**`999999` lives in a view, not an `UPDATE`.** The plan says to update the
edge's cost to infinity when an incident is verified. Doing that literally
destroys the base cost, so clearing the incident cannot restore it. Instead
`routable_edges` computes the blocked cost by `LEFT JOIN LATERAL` against
verified incidents. Blocking and clearing are then both **zero writes** to
`road_edges`, and clearing is exactly reversible. Smoke tests 4–6 prove it.

**`pgr_aStar` needs `x1,y1,x2,y2`** — unlike `pgr_dijkstra`. Added as
`GENERATED ALWAYS AS (ST_X(ST_StartPoint(geom))) STORED` etc.

**`heuristic_factor DEFAULT 111320`.** Coordinates are degrees but costs are
metres, so an unfactored heuristic underestimates by ~5 orders of magnitude.
Still admissible (paths stay correct) but A* silently degenerates into
Dijkstra. 111320 ≈ metres per degree.

**`reroutes.trigger` → `trigger_type`** — `TRIGGER` is a PostgreSQL keyword;
non-reserved and therefore legal, but confusing to read.

**`telemetry`** distinguishes `captured_at` from `ingested_at` (burst sync
means these differ by hours), constrains `source IN ('gps','ekf')`, requires
covariance when `source = 'ekf'`, and carries a UNIQUE `client_uid` so a
replayed burst-sync payload is idempotent.

### Bugs found and fixed before first run

- `nearest_road_edge` declared `max_distance_m` and never used it — a comment
  claimed filtering happened where an `OFFSET 0` sat. A report far from any
  road would snap to an arbitrary distant edge. Fixed by nesting the KNN scan
  in a subquery with the distance filter outside; smoke test 3b covers it.
- `pgr_aStar` was missing `factor` entirely (see heuristic note above).

### Verification

`smoke_test.sql` runs inside a `BEGIN … ROLLBACK`, so it is safe against a
populated database. All 7 checks pass on a 4-edge diamond graph: generated
columns populate, baseline route takes the cheap leg, incident snaps at 0 m, a
far report returns 0 rows, blocked edge reads `base_cost 100 / routing_cost
999999`, traffic reroutes, clearing restores the original path, and
`risk_weight => 3.0` biases away from high-risk edges with no incident present.

---

## R1 — 2026-08-25 · Repository scaffold

**Created**: `.gitignore`, `.env.example`, directory skeleton
(`backend/`, `ai-services/`, `dashboard/`, `mobile-app/`, `infra/`,
`scripts/`, `docs/`, `data/`), `data/MANIFEST.yml` v1,
`scripts/check_data.py`

`data/` is organised by **lifecycle, not topic** — `raw/` immutable,
`processed/` and `artifacts/` rebuildable from it. A corrupted index is then a
rebuild rather than a re-hunt. `.gitignore` excludes the payload but keeps the
`.gitkeep` skeleton, `MANIFEST.yml`, and `README.md` so the shape of the tree
survives a clone.

Pre-existing junk cleared: `~/drishti-logistics` (24 empty dirs from an
unquoted `mkdir`, 0 files) deleted after a zero-file safety check.

---

## Open questions

Decisions that need a human, ordered by what they block.

1. **YOLO's 4 classes vs `incidents.kind`'s 3.** Widen the CHECK to include a
   damaged-bridge kind and add an explicit rejection path for
   `NORMAL_TERRAIN`, or map class 3 → `obstruction` at the API boundary and
   accept the lossy mapping? `NORMAL_TERRAIN` must mean *unverified* — it
   cannot be allowed to block an edge. *Blocks ML-06, API-03.*
2. **Which probability does `> 0.85` mean?** `P(is_hazard)` or
   `P(hazard_type = LANDSLIDE_RISK)`? WEB-04 and ML-06 must agree.
   *Blocks ML-04.*
3. **`CLAUDE.md` lives at `~/CLAUDE.md`**, so it loads as context for every
   project under the home directory, not just this one. Move to
   `~/drishti/CLAUDE.md`?
4. **Rosetta emulation** on the Postgres container — accept for dev, or move
   to a native arm64 Postgres with a pgRouting build?

---

## Conventions

- **CRS**: EPSG:4326 everywhere. Reproject at ingest, never at query time.
- **`raw/` is immutable.** No script writes to it. The one exception so far is
  `incident-yolo/data.yaml`, whose absolute Windows path was broken on
  arrival; the original is kept beside it as `data.yaml.orig`.
- **The manifest is a contract, not documentation.** `check_data.py` reads
  `path:` — if it drifts, the check silently passes on the wrong file.
- **Prove duplicates before deleting.** Same size is not same content; hash it.
- **`ON_ERROR_STOP=1` on every `psql` invocation.** Without it a failed
  migration exits 0.
