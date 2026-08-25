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
| 1 | DB-02 GeoPandas → PostGIS ingest | ⬜ next — data probed (see R7 note), not written |
| 1 | API-01…04 Express / BullMQ / incidents / reroute | ⬜ not started |
| 2 | ML-01 FastAPI service | ✅ running, 35 tests pass |
| 2 | ML-02 load scaler / indices / rasters | ✅ + built the road index that never shipped |
| 2 | ML-03 Open-Meteo peak intensity | ✅ live |
| 2 | ML-04 XGBoost hazard model | ✅ retrained on raster-rebuilt features, 0.9942 test acc, physically coherent — see R9 |
| 2 | ML-05 YOLOv8 incident verifier | ⚠️ retrained 2-class, 1.000 top-1 — but trained on satellite/aerial, served ground-level photos, see R8 |
| 2 | ML-06 `/predict-hazard`, `/verify-incident` | ✅ both verified end-to-end, 57 tests |
| 3 | WEB-01…05 React + Deck.gl dashboard | ⬜ not started |
| 4 | MOB-01…04, 07 React Native + C++ EKF | ⬜ not started |
| 4 | MOB-05 TFLite velocity model | ⚠️ trained, but MAE 4.0 m/s is not fit for purpose — see R6 |
| 4 | MOB-06 C++ TFLite→EKF bridge | ✅ written, compiles strict-clean, 25 tests pass |

Published at
[prakash-io/Project-D.R.I.S.H.T.I.](https://github.com/prakash-io/Project-D.R.I.S.H.T.I.)
· branch `chunk1-ai-hybrid-service` · Chunk 1 committed as `2cb6088`.

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
| Python | 3.12.12 (Homebrew, `.venv/`) | **ML work only** — TF segfaults on Anaconda 3.13, see R6 |
| TensorFlow / Keras | 2.21.0 / 3.15.1 | 1D-CNN training + TFLite export |
| git-lfs | 3.7.0 | IO-VNBD ships its CSVs through LFS |
| C++ | C++17 | Native EKF/TFLite bridge |

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

### Two Python environments — use the right one

| | interpreter | holds | use for |
|---|---|---|---|
| Anaconda base | 3.13.9 | `pandas`, `numpy`, `scipy`, `networkx`, `pyarrow`, `sklearn 1.7.2` | geo/data inspection |
| `.venv/` | 3.12.12 | `tensorflow 2.21`, `keras`, `sklearn 1.9.0`, `pandas`, `pyyaml` | **all ML work** |

TensorFlow segfaults on import under Anaconda 3.13 (R6), so anything touching
a model must run through `.venv/bin/python`. That venv also happens to satisfy
the `scikit-learn >= 1.9.0` pin the risk scaler needs.

Still missing everywhere: `geopandas`, `rasterio`, `shapely`, `xgboost`,
`torch`, `ultralytics`, `psycopg` — needed for DB-02, ML-02, ML-04 and ML-05.

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

The dark-zone path (MOB-05/06) is the other piece that exists today:

```
phone IMU @ 10 Hz ── ax, ay, az, gyro yaw/pitch/roll
        │            ⚠ decimate from 100 Hz first — the model is trained at 10
        ▼
  EkfTFLiteBridge   ring buffer, 50 x 6  (5 s of context)
        │           normalise (SpeedModelParams.h) → quantise int8
        ▼
  speed_model.tflite   21,665 params, 34 KB
        │           dequantise → speed m/s, clamped at 0
        ▼
  C++ EKF            ⚠ MAE 4.0 m/s ≈ 240 m drift per minute — open question 2
```

---

## R9 — 2026-08-25 · Executive decisions applied; hazard features rebuilt

Chunk 1 approved and committed (`2cb6088`, branch `chunk1-ai-hybrid-service`).
All seven open questions decided. This entry records the decisions and
implements Q1 and Q4.

**Created**: `scripts/rebuild_hazard_features.py`,
`data/processed/landslide_rebuilt/`

**Modified**: `train_hazard_xgb.py`, `config.py`, `models.py`, `main.py`,
tests, `CLAUDE.md` (moved), `data/MANIFEST.yml`

**Tests**: 57 → **59 passing**, 1 skipped.

### The decisions

| # | Question | Decision |
|---|---|---|
| 1 | Fabricated `slope_deg`/`aspect_deg` | **Rebuild from the rasters.** Done below. |
| 2 | Vision false positives | **Dispatcher approval.** Keep 2 classes; API-03 sets `PENDING_DISPATCHER_APPROVAL`, WEB-05 is the safety valve. |
| 3 | IMU speed drift (4.0 m/s) | **Accept as a weak secondary measurement.** No architecture change; lean on offline map-matching against the SpatiaLite graph. |
| 4 | `CLAUDE.md` location | **Move to the project root.** Done — it no longer loads as context for every project under `~`. |
| 5 | Rosetta on Postgres | **Accept for local development.** |
| 6 | Synthetic hazard labels | **Accepted as a hackathon demonstrator.** |
| 7 | Rainfall window | **Forecast horizon**, matching §5's pre-emptive intent. Already the default; `RAINFALL_WINDOW` switches it. |

Q2 carries a schema consequence for Chunk 2: `incidents.status` currently
allows `('pending','verified','rejected','cleared')`. Migration 002 needs
`pending_dispatcher_approval`, and API-03 must write it rather than
`verified` whenever `/verify-incident` returns `requires_human_review`.

### Q1 — rebuilding the features, and the trap in doing so

`scripts/rebuild_hazard_features.py` re-samples `slope_deg` and `aspect_deg`
from the terrain GeoTIFFs at each training row's own lat/lon. Verified against
the serving pipeline afterwards: both now correlate **1.000 with 100% exact
match**, against 0.309 and −0.018 before. Training and serving finally agree on
the physical inputs, which is what the decision asked for.

Two things had to be handled that the instruction could not have anticipated.

**19.9% of rows had to go.** 4,247 training coordinates fall outside every
terrain sheet, so no real slope exists for them. They are dropped rather than
left at their synthetic values — keeping them would preserve the very thing
being removed. A further 165 rows were dropped for a subtler reason: replacing
slope and aspect collapses coordinates that differ only in those two columns
into identical feature vectors, and some of those pairs straddled the splits.
That is **leakage created by the rebuild** — 88 test rows and 77 val rows the
model would have already seen. The originals had none. Removed, and the
leakage check now reports zero.

**The labels had to move with the feature, and this is the important part.**
The labels were generated *from* the old slope. Replacing the feature and
keeping the label does not merely lower accuracy — it inverts the model:

| mean `slope_deg` per label | original | rebuilt, labels kept |
|---|---|---|
| FLOOD_RISK | 1.4° | 16.5° |
| SAFE_TERRAIN | 8.1° | 17.0° |
| LANDSLIDE_RISK | 32.0° | 27.6° |

The three classes become nearly indistinguishable by slope — real slope
predicts the label at 0.545, down from 0.934 — and the model trained that way
called a **1.8° valley floor LANDSLIDE_RISK and a 23.5° ridge FLOOD_RISK**,
while scoring a respectable 0.9073 against those same broken labels. No
accuracy number would have caught it; it was found by scoring five coordinates
whose answers are obvious by inspection.

The fix is not to invent thresholds. The dataset's own labelling rule is
recovered by fitting a depth-6 tree on the **original** raw features against
the **original** labels — the generative rule, measured, with a held-out
fidelity of **0.9845** — and re-applying it to the rebuilt features. Every
threshold comes from the data.

### Results

| | before (as shipped) | after (rebuilt + relabelled) |
|---|---|---|
| rows | 22,195 | 17,783 |
| split leakage | 0 | 0 (165 removed) |
| depth-2 tree | 0.9607 | 0.9290 |
| **xgboost** | **0.9913** | **0.9942** |
| ROC-AUC hazard | 0.9997 | 0.9996 |
| `slope_deg` vs serving | 0.309 | **1.000** |
| `aspect_deg` vs serving | −0.018 | **1.000** |
| `trustworthy` on responses | `false` | **`true`** |

Physical sanity, which is the check that actually matters here:

    44.6 deg, 4061 m, Himalaya      -> LANDSLIDE_RISK  0.957
    23.5 deg ridge, Arunachal       -> LANDSLIDE_RISK  0.983
    4.8 deg, 56 m, Brahmaputra      -> FLOOD_RISK      0.968
    5.7 deg, 196 m from river       -> FLOOD_RISK      0.967
    1.8 deg valley floor            -> SAFE_TERRAIN    0.126

This remains a **synthetic demonstrator** (Q6). The model recovers a rule
rather than forecasting landslides, and the depth-2 baseline still prints on
every run to keep that visible. What changed is that it is now a *coherent*
demonstrator: the inputs it trains on are the inputs it is served, and the
labels describe the terrain those inputs measure.

### One more guard replaced

`assert_prescaled` checked median 0 / IQR 1, which only holds for the exact
rows the scaler was fitted on — it fired on the correctly-scaled rebuilt
subset. A guard that fires on good data gets deleted, so it now
inverse-transforms and checks the result is physically possible instead. That
is distribution-independent, survives subsetting, and is far more decisive on
the case it exists for: raw units inverse-transform `elevation_m` to about
421,000 m, which is not a mountain.

---

## R8 — 2026-08-25 · Correctness pass over the AI service

A rigorous audit of everything R7 produced. Five defects in my own code, and
three findings about the datasets that change what the two models mean. The
code defects are fixed; the data findings cannot be fixed here, so the service
now reports them on every response instead of hiding them.

**Created**: `ai-services/drishti_ai/vision_worker.py`,
`ai-services/tests/test_data_integrity.py`

**Modified**: `weather.py`, `models.py`, `config.py`, `schemas.py`, `main.py`,
`train_hazard_xgb.py`, `train_incident_yolo.py`, both artefacts, tests,
`.env.example`, `data/MANIFEST.yml`

**Tests**: 35 → **57 passing**, 1 skipped.

### Bug 1 — the rainfall window was in the wrong place, twice

`/predict-hazard`'s three rainfall features were computed over the wrong
hours. Two independent causes, both silent:

*   **The series does not start "now".** With `timezone=UTC`, Open-Meteo
    returns whole days: `forecast_days=3` begins at 00:00 UTC *today*.
    Measured at 16:42 UTC, `series[:24]` was 16 hours of already-elapsed
    weather plus 8 hours of forecast — and only 56 of the 72 required forward
    hours existed at all.

*   **Nulls were compacted.** Open-Meteo emits `null` for hours it has no
    value for, and dropping them shifts every later hour leftwards into the
    window. With 6 leading nulls, a 40 mm/h cloudburst at true hour 28 — four
    hours *outside* the window — was reported as the 24 h peak. **A 400x error
    on the feature carrying the most hazard signal.**

Fixed by locating the window in `hourly.time` rather than slicing from index
0, requesting 4 forecast days so 72 forward hours always exist, and skipping
nulls *in place* while reporting how many hours actually backed each figure.
The effect on the verification coordinate is visible: rainfall went from
76.8 / 8.6 / 1.2 to **98.9 / 36.6 / 6.3** once the window was correct.

`past_days=3` now comes back in the same call, so `RAINFALL_WINDOW` switches
between forecast and antecedent by configuration. That turns open question 7
from a code change into a setting.

### Bug 2 — torch and xgboost cannot share a macOS process

Carried over from R7 and worth restating because the first fix was wrong. I
tried forcing the import order (torch before xgboost); that stopped the hang
and started a **SIGSEGV in xgboost instead**. The two runtimes are mutually
incompatible, so reordering cannot win:

    xgboost -> torch, then torch inference    hangs forever
    torch -> xgboost, then xgboost predict    SIGSEGV

Fixed properly by not sharing: vision runs in a **spawn**-context worker that
imports torch and nothing else from the OpenMP set. 3.8 s cold, 19–37 ms warm.

### Bug 3 — a dead worker wedged the endpoint permanently

`ProcessPoolExecutor` poisons itself when a worker dies: every later `submit`
raises `BrokenProcessPool` forever. Since the collision above manifests *as* a
segfault, that is a reachable state, and "restart the service" is not a
recovery path for a driver reporting a landslide. The pool is now dropped and
rebuilt on both timeout and death. Tested by `SIGKILL`ing the live worker and
asserting the next call recovers with identical output.

### Bug 4 — the confidence threshold could never reject anything

`YOLO_CONF_THRESHOLD` was 0.45, inherited from the 4-class spec. Softmax top-1
over *n* classes is at least 1/n, so at 2 classes the top-1 confidence is
always ≥ 0.5 and the threshold was **dead code**. Raised to 0.75, and the
service now refuses to start if the threshold is at or below 1/n_classes.

### Bug 5 — ultralytics wrote into the repo root

`model.val()` ignores the `project` given to `train()` and creates
`runs/classify/val` in the working directory; the pretrained checkpoint
downloaded to the root as well. Both now land under `data/artifacts/vision/`,
with `.gitignore` rules as a backstop.

Also fixed: the weather cache was unbounded (now LRU-capped at 2048), and the
scaler was being handed a bare array, which only *warns* on a column-order
mismatch — it now gets a named DataFrame, so sklearn validates the order.

### Finding 1 — half the hazard model's features are not measurements

The training rows carry `latitude`/`longitude`, so every feature can be
re-derived through the serving pipeline and compared against what the training
file says. Over 490 training coordinates that fall on the terrain sheets:

| feature | corr with serving pipeline | verdict |
|---|---|---|
| `elevation_m` | **0.979** | real |
| `dist_to_road_m` | **0.999** | real |
| `dist_to_river_m` | **0.844** | real |
| `slope_deg` | **0.309** | not the terrain slope |
| `aspect_deg` | **−0.018** | uniform noise |

`aspect_deg` is statistically indistinguishable from Uniform(0, 360) across
all 22,195 rows — KS p = 0.33. It is not terrain aspect. The model had already
worked this out and gives it 0.36% of gain.

`slope_deg` is the serious one. Its per-class ranges carry hand-round bounds
(FLOOD 0.10–4.50, SAFE 1.00–18.00, LANDSLIDE 15.00–61.82) and it holds **61%
of the model's gain**. So the input the model leans on hardest is the one the
service cannot reproduce: it learned on a class-conditioned synthetic slope
and is served a real raster slope. A further **18.3%** of training coordinates
fall outside every terrain sheet and cannot be reproduced at all.

This cannot be fixed by retraining on this data. What the service does instead:
`/predict-hazard` returns `unvalidated_features` and `trustworthy: false` on
every response, plus an `out_of_distribution_features` list computed against
the training support recorded at train time — because gradient-boosted trees
do not extrapolate, and a value past the training range returns the edge leaf
with full confidence and no signal that it did.

### Finding 2 — the hazard labels are a two-line rule

`train_hazard_xgb.py` now fits shallow trees as a baseline and prints them
next to the headline, permanently:

| model | test accuracy |
|---|---|
| depth-1 tree | 0.7207 |
| **depth-2 tree** | **0.9607** |
| depth-3 tree | 0.9754 |
| xgboost, 69 trees | 0.9913 |

Two thresholds on two features get within three points of the model. The rule
is `slope_deg > ~15°` → LANDSLIDE_RISK, `dist_to_river_m < ~800 m` →
FLOOD_RISK, else SAFE_TERRAIN.

### Finding 3 — the vision dataset is the wrong kind of image

R7 established that two of the four classes are filename arithmetic. Looking
at the images themselves shows something larger: **the landslide pool is
satellite false-colour tiles and the flood pool is aerial press photography**
(one carries a news-agency watermark). Both are remote sensing. Neither
resembles what `/verify-incident` is actually sent — a ground-level photograph
from a driver standing in front of a blocked road.

That also explains the scores. The pools differ by imaging *modality*, not by
hazard: a colour histogram alone — 48 numbers, every shape and texture
destroyed — separates them at 86.7%, and the retrained model reaches val
top-1 = 1.000 after **one epoch**.

### What changed in the vision model

Retrained with `--label-source pool`: **2 classes, 1.000 test top-1, 1.000
recall on both**, all 1,380 images kept. Compared with R7's 4-class run at
0.827 with two classes at 0.000 recall, every output now means something.

The accuracy is still not skill — see Finding 3 — so `/verify-incident`
returns `requires_human_review: true` on every verified incident, and
`INCIDENT_REQUIRE_REVIEW` stays on until the training images are replaced.
API-03 must route through the WEB-05 dispatcher panel rather than setting an
edge cost to 999999 directly.

### Data-integrity tests

`tests/test_data_integrity.py` pins each finding as an assertion — the label
arithmetic, the uniform aspect, the depth-2 recoverability, the review gate.
**A failure there is not necessarily bad news**: it means a dataset was
regenerated and the defect may be gone, which is the signal to retrain and
relax the matching guard.

---

## R7 — 2026-08-25 · AI hybrid microservice (Epic 2: ML-01 … ML-06)

**Created**
- `ai-services/main.py` — FastAPI app, `/health`, `/predict-hazard`, `/verify-incident`
- `ai-services/drishti_ai/` — `geo`, `rasters`, `weather`, `features`, `models`,
  `schemas`, `config`
- `ai-services/tests/` — 33 tests, no network required
- `ai-services/requirements.txt`, `ai-services/README.md`, `ai-services/.venv/`
- `scripts/build_road_index.py` — builds the road KDTree that never shipped
- `scripts/train_hazard_xgb.py` — XGBoost hazard classifier (ML-04)
- `scripts/train_incident_yolo.py` — YOLOv8n incident verifier (ML-05)
- `data/artifacts/risk/hazard_model.json` + `_meta.json`
- `data/processed/indices/road_network_spatial_index.pkl` + `.json`

**Modified**: `.env.example`, `data/MANIFEST.yml`

**Stack added**: FastAPI 0.141.1, uvicorn 0.52.4, XGBoost 3.4.1,
scikit-learn 1.9.0, rasterio 1.5.1, scipy 1.18.1, shapely 2.1.2,
ultralytics 8.4.128, torch 2.13.0, libomp (Homebrew), Python 3.12.12.

### The KDTrees are not in degrees

R4 flagged this as *"Indices are in DEGREES (EPSG:4326) … Confirm before
ML-06."* Confirmed, and it was wrong. `tree.data` holds **projected metres**:

    x = lon * 111139 * cos(25.5 deg)        y = lat * 111139

An equirectangular projection about the NER centre latitude, which every index
carries as its own `center_lat: 25.5`. Recovered by least-squares against each
index's own `feature_records` lat/lon and exact to ~1e-9 m on all three
independently. The constant is 111139 — not WGS84's 111319.49, not
`R*pi/180`'s 111194.93.

This matters because the failure is silent. Querying the tree with a raw
`(lon, lat)` pair does not raise: it drops the query ~10^7 m outside the data
cloud and returns a confident, arbitrary neighbour. Measured on the road
index, a query for (27.5, 92.0) returns a vertex **399.7 km** away where the
true nearest road is **709 m**. Every distance feature would have been
garbage, and nothing would have complained.

`drishti_ai/geo.py` owns the transform and splits the two jobs the projection
was being asked to do:

- **Finding** candidates — the KDTree, in projected space, `k=8`.
- **Measuring** them — haversine against the neighbour's real lat/lon.

The cos(25.5°) factor is exact only at 25.5°, so it is ~1.4% wrong in
longitude at the 29.5° top of the bbox. Pulling 8 candidates and re-ranking by
haversine means the distortion cannot pick the wrong neighbour either.
`verify_projection()` re-projects the index's own coordinates at every startup
and refuses to boot on a mismatch, so a rebuilt index with a different
constant fails loudly instead of serving quietly wrong numbers.

### The road index did not exist

`dist_to_road_m` is one of the model's eight features, but
`data/processed/indices/` shipped only rivers, bridges and pinch points.
`/predict-hazard` had no way to produce the feature at all.

`scripts/build_road_index.py` builds it from `road_network.parquet` in the
same projection: 12,653,221 raw vertices, **6,252,739 distinct**, 275.6 MB,
18 s. That distinct count was independently reproduced by a PostGIS
`GROUP BY` over the same file — two toolchains, same number.

Two deviations from the shipped indices, both deliberate. The upstream format
carries one dict per indexed point, which is why 609 k pinch points cost
133 MB; this stores plain float32 lat/lon arrays instead, so 6.25 M points fit
in 275 MB. And it indexes *vertices*, so the reported distance is bounded by
half the vertex spacing — the source is atomised into 2-point segments
averaging ~26 m, giving ~13 m worst case against a feature whose training
median is 1778 m. Cross-checked against PostGIS `ST_Distance` on the true line
geometry: 5.8 vs 4.2 m, 11.1 vs 7.8 m, 12611 vs 12627 m.

### The training features were already scaled

`X_train.parquet` has ten columns and the scaler takes eight, which R4 had
already caught. What R4 did not catch is that **the eight are RobustScaler
output, not raw units** — `elevation_m` has median 0.0 and range
[-0.61, 6.46]. Only `latitude`/`longitude` are raw, which is precisely what
makes the file look untouched at a glance.

Re-applying the scaler during training would centre already-centred data and
produce a model that disagrees with the service, which *does* scale raw metres
and degrees on the way in. Neither side would error. `assert_prescaled` checks
median 0 and IQR 1 across all eight and aborts otherwise; inverse-transforming
recovers sane units (elevation 0–5867 m, slope 0.1–61.5°), which is how it was
confirmed.

The scaler is also fed a named DataFrame rather than a bare array, so sklearn
validates the column order instead of merely warning about it.

### Which probability the 0.85 threshold means — resolved

R2's open question 3. Resolved by making it moot: the model is 3-class
(`multi:softprob`), and the response carries per-class probabilities alongside
`hazard_probability = 1 - P(SAFE_TERRAIN)`. `RISK_FLAG_THRESHOLD` compares
against `hazard_probability`. WEB-04 and ML-06 now read the same field.

### Hazard model results — and why 99% is not the good news it looks like

69 trees (early-stopped from 2000), depth 6, 8 features, 3 classes. Held out
3,330 rows; no row overlap between splits, checked by hashing feature vectors.

| | |
|---|---|
| 3-class accuracy | **0.9913** |
| logloss | 0.0625 |
| ROC-AUC `P(hazard)` | 0.9997 |
| ROC-AUC `P(landslide)` | 0.9999 |
| at threshold 0.85 | precision 0.9995, recall 0.9769 |

**These labels are rule-generated from the features themselves.** Per-class
ranges of `slope_deg` are FLOOD_RISK [0.1, 4.5], SAFE_TERRAIN [1.0, 18.0],
LANDSLIDE_RISK [15.0, 61.8] — hard cutoffs at 4.5, 15.0, 18.0 — and
SAFE_TERRAIN has a floor on `dist_to_river_m` at exactly 800.3 m. Those two
features carry 84% of the model's gain. The model is recovering a synthetic
labelling rule, and recovering it very well. It is not evidence of
landslide-prediction skill, and the number must not be quoted as if it were.

The pipeline around it is sound and is the part worth keeping: correct
scaling, honest splits, early stopping on val, test untouched by selection.
Swapping in real labels is a retrain, not a rewrite.

### Vision: two of the four classes are not labels

`05_vision_hazard_detection_yolo` ships in **detection** format, but all 1,380
images carry exactly one box each — audited, no exceptions. That makes it a
one-label-per-image task, so ML-05 trains `yolov8n-cls`, not a detector: the
endpoint needs a class and a confidence, a detector on 965 images with a box
head is worse conditioned, and "no detection" is dangerously easy to confuse
with NORMAL_TERRAIN in the backend. The detection labels are not discarded —
they are the source of the per-image class.

Training reached **0.827 test top-1**, and the per-class breakdown is the
story:

| class | n | recall |
|---|---|---|
| FLOODED_ROAD_OR_SUBMERGED | 86 | **1.000** |
| ACTIVE_LANDSLIDE_DEBRIS | 86 | **1.000** |
| NORMAL_TERRAIN | 30 | **0.000** |
| DAMAGED_BRIDGE_INFRASTRUCTURE | 6 | **0.000** |

The two zeros are not a training failure. **Those two classes are assigned by
filename index arithmetic**, verified against all 1,380 labels with zero
violations:

    landslide pool:  index % 4  == 0  ->  NORMAL_TERRAIN                (800/800)
    flood pool:      index % 12 == 0  ->  DAMAGED_BRIDGE_INFRASTRUCTURE (580/580)

There are only two image pools, `flood_*` and `landslide_*`, and the two
minority classes are sprinkled deterministically across them. An image
labelled NORMAL_TERRAIN is a landslide photograph that happened to land on an
index divisible by 4. 36 of 208 test images (17.3%) therefore carry a label
uncorrelated with their content, which puts a hard ceiling of 0.827 on top-1 —
the model scores 0.8269 and gets **172/172 of the honestly-labelled images
right**. It is doing the best the data permits.

**The confidence threshold cannot guard this.** All 30 NORMAL_TERRAIN test
images come back ACTIVE_LANDSLIDE_DEBRIS at median confidence 0.794, against
0.786 for genuine landslides — the distributions sit on top of each other. At
0.90 the threshold rejects 0 of 30 mislabelled-normal images while rejecting
82 of 86 true landslides. Raising it trades all the recall for none of the
safety.

One trap avoided along the way: `ImageFolder` assigns class indices
**alphabetically**, so the trained model's order is
`[ACTIVE_LANDSLIDE_DEBRIS, DAMAGED_BRIDGE_INFRASTRUCTURE, FLOODED_ROAD_OR_SUBMERGED,
NORMAL_TERRAIN]` while `data.yaml` is `[NORMAL_TERRAIN, FLOODED_ROAD_OR_SUBMERGED,
ACTIVE_LANDSLIDE_DEBRIS, DAMAGED_BRIDGE_INFRASTRUCTURE]`. Mapping a raw index
through `data.yaml` would relabel every incident. Everything maps by name.

### torch and xgboost cannot share a macOS process

`/verify-incident` hung. No log line, no traceback, no timeout — the request
simply never returned, and it reproduced under `TestClient` as readily as
under uvicorn, while the identical inference ran standalone in 0.02 s.

The process ends up with **three** copies of the OpenMP runtime: scikit-learn
bundles one, torch bundles one, and xgboost dlopens Homebrew's keg-only build.
On macOS arm64 they do not coexist, and the failure mode depends on load
order:

| order | result |
|---|---|
| `xgboost` → `torch`, then torch inference | **hangs forever** |
| `torch` → `xgboost`, then xgboost predict | **SIGSEGV** |

Both measured. `torch.set_num_threads(1)`, `KMP_DUPLICATE_LIB_OK=TRUE` and
forcing `device="mps"` each convert the hang into a segfault rather than
fixing it. Reordering cannot win, because each order breaks the other library.

Fixed by not sharing: vision inference runs in a **spawn**-context worker
process that imports torch and nothing else from the OpenMP set, while the
parent keeps xgboost and never imports torch at all. `fork` would not work —
the child would inherit the parent's loaded xgboost runtime, which is the
situation being escaped.

Cost: one warm worker process, 3.8 s on the first call, **19–37 ms warm**, and
JPEG bytes crossing a pipe. The regression test runs hazard → vision → hazard
in one process and pins that the hazard probability is byte-identical either
side of the torch call.

This is the same family of problem as R6's TensorFlow segfault under Anaconda
3.13 — a native-library conflict that every declared Python dependency
constraint is satisfied by.

### Note left for DB-02

DB-02 was probed before this chunk was reprioritised, and the finding changes
how it must be written. `road_network.parquet`'s 238,170 rows are not 238,170
road segments: each is a MultiLineString of **2-point segments**, 6,326,609 of
them, 162,051 km in total. Loading them as edges would hand pgRouting a 6.3 M
edge graph, which is unusable for interactive rerouting.

The vertex structure, measured in PostGIS: 12,653,218 endpoints, 6,252,739
distinct, of which 5,884,516 are degree-2 (pass-through), 235,074 degree-3,
15,096 degree-4, and 117,924 degree-1 (dead ends). ~412,848 are junction
candidates. So the ingest needs a merge-then-split pass — `ST_LineMerge` each
way, then split at shared junction vertices — not a naive `ST_Dump`. The
6,252,739 figure was independently reproduced by the road-index builder in
Python, so it is not a PostGIS artefact.

Staging tables `stage_road`, `stage_parts`, `stage_ep` and `stage_vertex` are
left UNLOGGED in the dev database with that work in them.

### Verification

`/predict-hazard` for `{latitude: 27.5, longitude: 92.0}`, live against
Open-Meteo:

    predicted_class      LANDSLIDE_RISK
    hazard_probability   0.944131        (high_risk, threshold 0.85)
    class_probabilities  SAFE 0.0559 / LANDSLIDE 0.9154 / FLOOD 0.0287
    elevation_m          4061.2      slope_deg   44.64
    dist_to_river_m      1127.1      dist_to_road_m 709.2
    rainfall 72h/24h/peak  76.8 / 8.6 / 1.2
    terrain_region       arunachal_pradesh  (smaller sheet wins over assam)

Sane on inspection: high Arunachal Himalaya, 4 km up a 45-degree slope. The
709.2 m road distance was cross-checked against an independent PostGIS
`ST_Distance` on the true line geometry (717.0 m — the 8 m gap is PostGIS's
`<->` KNN ordering picking a marginally different edge, not a projection
error).

`/verify-incident` on a held-out landslide photo returns
`verified: true, incident_kind: "landslide", confidence: 0.683` in 3.8 s cold
and 19 ms warm; a flood photo returns `incident_kind: "flood"` at 0.793.

35 tests pass, 1 skipped (the 503-without-weights path, unreachable now that
the weights exist). None of them need the network.

---

## R6 — 2026-08-25 · IDR speed model (MOB-05) and the C++ bridge (MOB-06)

**Created**
- `scripts/train_idr_speed.py` — IO-VNBD → TFLite training pipeline
- `scripts/gen_model_header.py` — emits the C++ constants from the model meta
- `mobile-app/native/EKF_TFLite_Bridge.cpp` — TFLite → EKF bridge
- `mobile-app/native/SpeedModelParams.h` — generated, do not hand-edit
- `mobile-app/native/test/` — Makefile, TFLite stubs, 25-check unit test
- `.venv/` — project Python env (gitignored)

**Modified**: `data/MANIFEST.yml`, `.gitignore`

**Stack added**: TensorFlow 2.21.0, Keras 3.15.1, git-lfs 3.7.0,
Python 3.12.12 (Homebrew), C++17.

### Environment

TensorFlow **segfaults on import** (exit 139) under the Anaconda Python 3.13.9
that everything else in this repo uses — every declared dependency constraint
was satisfied, so it is a binary conflict inside that distribution, not a
version mismatch. Worked around with a dedicated `.venv` on Homebrew Python
3.12.12, where TF 2.21 imports cleanly. Side benefit: that venv carries
scikit-learn 1.9.0, which is the version `feature_scaler.joblib` needs
(see R4).

### Data

The previous IO-VNBD copy was LFS pointer stubs (R4). Re-cloned with
`git lfs install && git clone`: 564 real CSVs, 1.7 GB. Dropped the two
redundant `.zip` archives and the 1.5 GB `.git` LFS cache after checkout.

Four dataset facts, each found by reading the files and each silently wrong if
assumed otherwise:

1. **It is 10 Hz, not the 100 Hz the plan assumes.** A 50-timestep window is
   therefore 5 seconds. A phone polling at 100 Hz must decimate before
   inference or every window covers 0.5 s and the model sees a distribution it
   was never trained on.
2. **The phone's `GPS SPEED (Kmh)` is in m/s** — median V/S ratio 3.58 — and
   correlates only 0.84 with the vehicle. The target comes from the V- file's
   correctly-labelled `Velocity (km/hr)`.
3. **Filename case differs across halves**: `S-Vta10.csv` pairs with
   `V-vta10.csv`. Case-sensitive matching pairs 32 of 72 sessions and discards
   the rest without complaint.
4. **Every session exists twice**, under `Uncategorised/` and `Categorised/`,
   at different lengths. Loading both puts one drive in two splits and leaks
   the target. The loader keeps the uncategorised (untrimmed) copy.

A fifth trap cost a full training run: the two halves give the same three gyro
channels different headers — `GYROSCOPE Yaw/Pitch/Roll` vs `GYROSCOPE X/Y/Z`,
identical columns in identical positions. Columns are now resolved by pattern,
which also sidesteps the inconsistent encoding of the `m/s²` and `°` suffixes.

Splits are by **session**, never by window: consecutive windows overlap 98%, so
a random split leaks the target outright.

### Results — the model works, but is not fit for purpose yet

72 sessions, 161,739 train / 161,267 val / 97,362 test windows. 21,665
parameters. Held out 11 whole sessions:

| | float | int8 |
|---|---|---|
| MAE | **4.024 m/s** (14.5 km/h) | 5.270 m/s |
| RMSE | 5.259 m/s | — |
| R² | 0.424 | — |
| baseline (predict train mean) | 6.093 m/s | |

It beats the baseline by 34%, so it is learning something real. But **4 m/s of
speed error integrates to roughly 240 m of along-track position error per
minute of blackout** — for a multi-minute NER valley that is not a usable
primary velocity source.

The cause is structural rather than a tuning shortfall. An accelerometer
measures acceleration, which integrates to a velocity *change*, not an absolute
velocity. The only absolute-speed signal in a bare IMU window is the vibration
spectrum — road roughness, engine harmonics, suspension resonance — which
varies with surface, load, and phone mounting. Growing the network will not fix
this; changing what it predicts will. See Open Questions.

**Full int8 quantisation is currently a bad trade.** It costs 1.25 m/s (+31%)
and saves nothing: 34.9 KB int8 vs 33.6 KB dynamic-range, because at 21k
parameters both already carry int8 weights and the integer graph only adds
quantise/dequantise ops. It is worth it only on an integer-only NPU.

One real bug found and fixed along the way: the int8 output range was
calibrated from 400 uniformly-sampled windows, which missed the fast tail and
capped the graph at 32.73 m/s while the data reaches 36.52 — every speed above
that was being clipped. Calibration is now stratified across the speed range
with the true extremes pinned.

### C++ bridge

`EKF_TFLiteBridge` holds a 50×6 ring buffer, normalises, quantises to int8,
invokes, and dequantises. No allocation, locking, or exceptions on the
per-sample path. Every failure is a status code, because a dead-reckoning
filter must never be handed a fabricated speed: returning `kNotReady` and
letting the EKF coast on its process model is always better than returning
0.0, which tells the filter the truck has stopped.

Compiles clean under `-Wall -Wextra -Wpedantic -Wshadow -Wconversion
-Wsign-conversion -Wold-style-cast`. `-Wconversion` caught eight genuine
signedness bugs on the first pass, which is why the window constants are
`std::size_t`.

`mobile-app/native/test/` runs 25 assertions against a stubbed TFLite — enough
to cover what is easiest to get wrong: that the ring buffer unrolls
oldest-first (a rotated window is wrong in a way that still produces plausible
numbers), that the quantise/dequantise round-trip is exact, that NaN and
saturated samples are rejected, and that negative regression output clamps to
zero rather than becoming negative speed. `make -C mobile-app/native/test run`.

The normalisation constants are generated into `SpeedModelParams.h` rather than
hand-copied — a retrain shifts the means, and a stale header biases every
prediction by a constant no compiler can catch.

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

All seven questions were decided on 2026-08-25 (R9). Kept here as a record of
what was chosen and what still follows from it.

### Decided

1. **Fabricated `slope_deg`/`aspect_deg`** → *rebuild from the rasters.*
   Implemented in R9. Both now correlate 1.000 with the serving pipeline, and
   the labels were re-derived with the dataset's own recovered rule so they
   describe the terrain the features measure.

2. **Vision false positives** → *dispatcher approval.* 2 classes kept,
   `requires_human_review: true` on every verified incident.
   **Still to do in Chunk 2:** migration 002 must widen `incidents.status` to
   include `pending_dispatcher_approval`, and API-03 must write that instead
   of `verified` whenever the AI service asks for review. WEB-05 is the
   load-bearing safety valve.

3. **IMU speed drift (4.0 m/s MAE)** → *accept as a weak secondary
   measurement.* No architecture change. **Follows for Chunk 3:** the EKF must
   give the TFLite speed a large measurement variance, and offline
   map-matching against the SpatiaLite road graph carries the burden of
   along-track correction.

4. **`CLAUDE.md` location** → *moved to the project root.* Done in R9.

5. **Rosetta on the Postgres container** → *accepted for local development.*

6. **Synthetic hazard labels** → *accepted as a hackathon demonstrator.* The
   depth-2 baseline prints on every training run so the headline accuracy is
   never read as forecasting skill.

7. **Rainfall window** → *forecast horizon*, matching workflow §5's
   pre-emptive intent. `RAINFALL_WINDOW=antecedent` switches it with no code
   change if that is ever revisited.

### Still open

8. **The vision model is out of distribution on its real input.** The training
   images are satellite tiles and aerial press photography; `/verify-incident`
   receives ground-level photographs from a driver's phone. Decision 2 makes
   this safe — a human confirms before any edge is blocked — but it does not
   make the model *right*. Closing it needs a few hundred ground-level NER
   road photos per class, including a genuine "nothing wrong here" class.
   *Does not block the demo. Blocks autonomous incident verification.*

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
