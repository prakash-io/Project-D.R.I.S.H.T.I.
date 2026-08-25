# Datasets

Nothing in here is committed except this file, `MANIFEST.yml`, and the
`.gitkeep` skeleton. `MANIFEST.yml` is the inventory; this file explains the
layout and how to populate it.

```
python3 scripts/check_data.py              # what is present / usable
python3 scripts/check_data.py --task ML-04 # what one checklist task needs
python3 scripts/check_data.py --missing    # only the gaps
```

Current state: **9.5 GB on disk, everything present except IO-VNBD** (see
below). Sourced from the `CLEAN_READY_DATA` Drive export, 2026-08-25.

## Layout

The split is by **lifecycle**, not by topic — so that a corrupted index is a
rebuild rather than a re-hunt.

| Directory | Rule | Rebuildable? |
|---|---|---|
| `raw/` | Immutable source data. Never written to by a script. | No — re-download |
| `processed/` | Derived frames and indices | Yes, from `raw/` |
| `artifacts/` | Trained models and fitted scalers | Yes, by retraining |

```
data/
├── raw/
│   ├── geo/          road_network · bridges · districts             136 MB
│   │                 hazard_pinch_points · landslide_events
│   ├── graph/        ner_road_graph.gpickle  (NetworkX)             1.5 GB
│   ├── terrain/      27 GeoTIFFs — 9 regions × dem/slope/aspect     7.4 GB
│   ├── hydrology/    river_waterways.parquet  (HydroRIVERS)         4.5 MB
│   ├── vision/       incident-yolo/  (1380 images, 4 classes)        94 MB
│   └── imu/          IO-VNBD/   ← LFS STUBS, NOT REAL DATA
├── processed/
│   ├── landslide/    X/y × train,val,test + features_metadata.json  1.3 MB
│   ├── indices/      3 scipy KDTrees + metadata                     189 MB
│   └── edge/         windowed IMU tensors for the 1D-CNN  (empty)
└── artifacts/
    ├── risk/         feature_scaler.joblib · risk-xgb.ubj ← to train
    ├── vision/       incident-yolov8n.pt                  ← to train
    └── edge/         velocity-cnn.tflite  ← bundled into the app binary
```

## Adding a dataset

1. Drop the file at the exact `path` given in `MANIFEST.yml`.
2. If it is new, add an entry to `MANIFEST.yml` first — `check_data.py` only
   knows about what is listed there.
3. Record `source:`. An entry stuck at `source: TODO` is unreproducible; if
   that file is ever lost, so is the ability to rebuild it.

## Things that bite

Each of these is a case where the wrong thing **runs without raising**.

- **IO-VNBD on disk is not IO-VNBD.** All 564 CSVs are 132-byte Git LFS
  pointer files — GitHub's "Download ZIP" does not resolve LFS. The tree looks
  complete and the file count is right; only the sizes give it away. Fix with
  `git lfs install && git clone https://github.com/onyekpeu/IO-VNBD`. Blocks
  MOB-05 and MOB-06.

- **The scaler is a RobustScaler, not a StandardScaler.** Centre and scale are
  median and IQR. Anything reimplementing it as `(x - mean) / std` is wrong.
  It was pickled by scikit-learn 1.9.0 — loading it under an older version
  warns and is explicitly not guaranteed to score correctly. Pin `>=1.9.0`.

- **X has 10 columns; the scaler takes 8.** `latitude` and `longitude` pass
  through unscaled. The 8 scaled features, in order:
  `elevation_m, slope_deg, aspect_deg, dist_to_river_m, dist_to_road_m,
  rainfall_72h_mm, rainfall_24h_mm, rainfall_intensity_mmh`.
  Passing all 10 raises; passing 8 in the wrong order does not. The scaler
  carries `feature_names_in_`, so hand it a named DataFrame and let sklearn
  do the check for you.

- **KDTrees are in degrees, features are in metres.** A KDTree query here
  returns Euclidean *degree* distance, which is neither metres nor uniform
  across latitude, while `dist_to_river_m` in the training data is metres.
  The serving path must convert the same way the training path did. Confirm
  before wiring ML-06.

- **The vision dataset has 4 classes, not the spec's 3**, and the names differ:
  `NORMAL_TERRAIN, FLOODED_ROAD_OR_SUBMERGED, ACTIVE_LANDSLIDE_DEBRIS,
  DAMAGED_BRIDGE_INFRASTRUCTURE`. This contradicts the
  `incidents.kind` CHECK in migration 001. Also note `NORMAL_TERRAIN` is a
  real prediction: a photo scoring class 0 means *unverified*, and must not
  block an edge. Class index order is load-bearing — reordering `data.yaml`
  relabels every historical incident.

- **`road_network` is not routable as-is.** Geometry is MultiLineString with
  some GeometryCollection, and there are no `source`/`target`/`cost` columns.
  Ingest must `ST_Dump` to single parts (so one source row becomes N edges —
  `id` stops being unique) and then build topology with `pgr_createTopology`.

- **Pickles are interpreter-bound and execute on load.** The KDTrees and the
  1.5 GB NetworkX graph should be rebuilt, not copied, across Python or
  library versions — and the graph should never be loaded in the API process.

- **CRS:** every vector layer here is already EPSG:4326, and so are the
  rasters. Keep it that way; reproject at ingest, never at query time.

## Where to put large files

Keep them here. If the tree outgrows the disk, symlink a subdirectory to
external storage rather than moving it — every path in `.env` and
`MANIFEST.yml` is relative to the repo root:

```sh
mv data/raw/terrain /Volumes/ext/drishti-terrain
ln -s /Volumes/ext/drishti-terrain data/raw/terrain
```

`raw/terrain` (7.4 GB) and `raw/graph` (1.5 GB) are the two worth moving
first; together they are 94% of the tree.
