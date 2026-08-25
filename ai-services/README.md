# D.R.I.S.H.T.I. — AI Hybrid Engine (Epic 2)

FastAPI microservice for hazard scoring and incident-photo verification. It
exists so XGBoost, torch, 7.4 GB of rasters and a 6.25 M-point KDTree stay off
the Node.js event loop.

## Run

```bash
brew install libomp                     # xgboost needs the OpenMP runtime
/opt/homebrew/opt/python@3.12/bin/python3.12 -m venv ai-services/.venv
ai-services/.venv/bin/pip install -r ai-services/requirements.txt

# artefacts, in dependency order
ai-services/.venv/bin/python scripts/build_road_index.py        # ~18s
ai-services/.venv/bin/python scripts/rebuild_hazard_features.py # ~95s
ai-services/.venv/bin/python scripts/train_hazard_xgb.py        # ~3s
ai-services/.venv/bin/python scripts/train_incident_yolo.py     # ~4min

ai-services/.venv/bin/uvicorn main:app --app-dir ai-services --port 8000
ai-services/.venv/bin/python -m pytest ai-services/tests -q
```

Startup loads and *validates* everything: a missing artefact or an index built
with a different projection fails the boot, not the first request.

## Endpoints

| | |
|---|---|
| `GET /health` | loaded artefacts, class/feature order, index sizes |
| `POST /predict-hazard` | landslide/flood probability for one coordinate |
| `POST /verify-incident` | classify a driver's photo (multipart `file`) |

```bash
curl -X POST localhost:8000/predict-hazard \
  -H 'Content-Type: application/json' \
  -d '{"latitude": 27.5, "longitude": 92.0}'
```

`overrides` substitutes any of the eight raw features — override all three
rainfall fields and the request never touches Open-Meteo, which is how the
tests stay deterministic and offline.

## What each model's score actually means

Both models report their own limits at runtime. Read `trustworthy` and
`requires_human_review` before you read the numbers.

**`/predict-hazard` — coherent, but a demonstrator.** The shipped feature
table's `slope_deg` correlated 0.309 with the terrain this service samples and
`aspect_deg` was uniform noise, while slope carried 61% of the model's gain.
`scripts/rebuild_hazard_features.py` re-samples both from the GeoTIFFs — they
now correlate **1.000** — and re-derives the labels with the dataset's own
recovered rule, because carrying labels generated from the old slope onto real
terrain inverts the model (it called a 1.8° valley floor a landslide while
scoring 0.907). Responses now report `trustworthy: true`.

It still recovers a threshold rule rather than forecasting landslides: a
depth-2 tree reaches 0.9290 against xgboost's 0.9942, and
`train_hazard_xgb.py` prints that baseline every run so the headline is never
read alone.

**`/verify-incident` — never blocks a road on its own.** It returns
`requires_human_review: true` on every verified incident. The model has no
"no incident" class (the dataset's NORMAL_TERRAIN labels are `index % 4 == 0`,
not image content) and it was trained on satellite tiles and aerial press
photography while the endpoint receives ground-level phone photos. API-03 must
write `pending_dispatcher_approval` and let WEB-05 confirm.

Its 1.000 test top-1 is real but unimpressive: the two pools differ by imaging
modality, a colour histogram alone separates them at 86.7%, and validation is
perfect after one epoch.

## Three things that will bite you

**The KDTrees are in projected metres, not degrees.** `x = lon × 111139 ×
cos(25.5°)`, `y = lat × 111139`. Querying one with a raw `(lon, lat)` pair
does not raise — it returns a confident neighbour ~400 km away. `drishti_ai.geo`
owns the transform and re-verifies it at every startup. Distances are always
reported by haversine against the neighbour's true lat/lon.

**The training parquet's 8 feature columns are already scaled.** Only
`latitude`/`longitude` are raw, which is what makes the file look untouched.
Training must not re-scale; serving must scale. `train_hazard_xgb.py` asserts
median 0 / IQR 1 and refuses to run otherwise.

**torch and xgboost cannot share a macOS process.** Three OpenMP runtimes
collide: `xgboost` → `torch` hangs forever, `torch` → `xgboost` segfaults, and
`set_num_threads(1)` / `KMP_DUPLICATE_LIB_OK` / forcing MPS only convert the
hang into a crash. Vision therefore runs in a spawn-context worker process and
the parent never imports torch. Do not "simplify" that away.

**Open-Meteo's series starts at 00:00 UTC, not now.** Slicing `[:24]` gives
mostly-elapsed weather, and compacting its `null` hours drags later hours into
the window — that combination once reported a storm four hours outside the
window as the 24 h peak, a 400x error. The window is located in `hourly.time`;
never index from 0.
