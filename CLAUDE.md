# System Workflow: D.R.I.S.H.T.I. Logistics & Dead Reckoning Platform

This document maps the complete data lifecycle of the unified NER logistics and ISRO dead reckoning platform. The architecture uses an "Edge-to-Cloud" hybrid model.

## 1. Normal Operation (Online + GNSS Active)
* **Data Ingestion:** The React Native mobile app polls GNSS coordinates at 1Hz using native location services.
* **Edge Filtering:** The local C++ Kalman Filter engine receives the raw GPS data and standard IMU data, smoothing out minor GPS jitters.
* **Telemetry Streaming:** The app maintains a `Socket.IO` WebSocket connection to the Node.js/Express backend, emitting a lightweight JSON payload `{ truck_id, lat, lng, speed, timestamp }`.
* **Command Center Render:** The React.js frontend consumes this stream. `Deck.gl` or `React Map GL` renders the moving truck icon on the dispatcher's dashboard in real-time.

## 2. The "Dark Zone" (Network Down + GNSS Lost)
* **State Transition:** The truck enters a deep NER valley. The app detects a GNSS dropout (no satellite fix) and WebSocket disconnect.
* **C++ Edge Engine Takeover (ISRO IDR):**
  * The app stops polling GPS and shifts to native high-frequency (100Hz) IMU polling (accelerometer, gyroscope).
  * **Vibration Filter:** A local TensorFlow Lite 1D-CNN model (trained on the IO-VNBD dataset) processes the IMU stream to filter out non-navigation noise and predicts forward velocity.
  * **Dead Reckoning:** The C++ Extended Kalman Filter (EKF) predicts the vehicle's x, y coordinates using the predicted velocity and gyroscope heading.
  * **Map-Matching Filter:** The engine compares the predicted coordinates against a locally cached road graph (derived from `road_network.parquet`), snapping the drifted coordinates to the physical road.
* **Offline Storage:** The map-matched coordinates are written sequentially into a local `WatermelonDB` database on the phone. The driver's navigation UI continues uninterrupted.

## 3. Network Restoration (The Burst Sync)
* **Reconnection Event:** The device regains 3G/4G connectivity. The app's network listener triggers the Burst Sync protocol.
* **Payload Transmission:** The app packages the entire `WatermelonDB` backlog of offline coordinates into a compressed JSON array and POSTs it to the Express API.
* **Asynchronous Queue:** To prevent backend blocking, the Express server immediately responds with `202 Accepted` and pushes the payload into a `BullMQ` (Redis) queue.
* **Data Finalization:** A background Node.js worker pulls the job, writes the historical path to the `PostgreSQL/PostGIS` database, and emits a Socket.IO event to the React dashboard, painting the complete path the truck took through the dark zone.

## 4. Crowdsourced Incident Reporting & Dynamic Rerouting
* **Incident Capture:** A driver encounters a landslide. They use the app to snap a photo and tag it. The app grabs the precise GPS location.
* **AI Vision Verification:** The backend sends the image to the FastAPI server, where a PyTorch/YOLOv8 nano model verifies the image class (Landslide, Flood, or Obstruction).
* **Graph Modification:** The backend receives the verified report. A PostGIS spatial query (`ST_ClosestPoint`) finds the nearest road segment (edge) on the map graph. The backend updates the database, setting that edge's traversal cost/weight to `infinity`.
* **Recalculation:** The `pgRouting` extension (`pgr_astar` or `pgr_dijkstra`) recalculates the shortest path for all affected trucks, avoiding the blocked edge.
* **Driver Notification:** The new route geometry is pushed via Socket.IO. The driver's app updates the UI and plays a localized voice alert using the **Bhashini TTS API** (e.g., Assamese, Hindi, English): *"Warning: Landslide ahead. Rerouting."*

## 5. Proactive Disruption Prediction (AI Weather Engine)
* **Weather Ingestion:** A cloud cron job pulls hourly precipitation forecasts from the **Open-Meteo API**.
* **Spatial & Raster Lookups:** The FastAPI service uses pre-computed `KDTree` indices (e.g., `river_waterways_spatial_index.pkl`) to instantly calculate distances, and uses `rasterio` to sample elevation and slope from the high-res GeoTIFFs (e.g., `arunachal_pradesh_30m.tif`).
* **Risk Modeling:** A Python `FastAPI` microservice runs an `XGBoost` model. It applies the `StandardScaler` (`feature_scaler_2.joblib`) to 8 structured features (elevation, slope, aspect, distance to river/road, and rainfall data) to calculate a hazard probability.
* **Pre-emptive Alerts:** If a specific highway segment scores a risk probability > 85%, it turns red on the Command Center dashboard. Dispatchers can click "Pre-emptively Reroute," triggering Workflow 4 before a truck even gets stuck.

# Development Checklist & Tech Stack Blueprint

This document lists every discrete task required to build the platform, mapped to the exact public APIs and open-source libraries needed.

## Epic 1: Cloud Infrastructure & Database (Backend)
**Tech Stack:** Node.js, Express, PostgreSQL, PostGIS, Redis, BullMQ.
- [ ] **DB-01:** Spin up a PostgreSQL database and enable the `PostGIS` and `pgRouting` extensions.
- [ ] **DB-02:** Use Python and `GeoPandas` to import the cleaned `road_network.parquet`, `bridges.parquet`, and `districts.parquet` directly into PostGIS, establishing the routing topology.
- [ ] **API-01:** Initialize an Express backend with `Socket.IO` for real-time telemetry streaming.
- [ ] **API-02:** Set up a Redis instance and configure `BullMQ`. Create a worker to handle incoming Burst Sync payloads (offline data) from the mobile app.
- [ ] **API-03:** Write the incident reporting REST endpoint that accepts a geo-tagged image, hits the FastAPI YOLO model for verification, and updates the nearest PostGIS edge weight to `999999` (infinity).
- [ ] **API-04:** Implement the dynamic rerouting function using `pgr_astar` to calculate new paths when a road is blocked.

## Epic 2: AI Hybrid Engine (FastAPI Microservice)
**Tech Stack:** Python, FastAPI, XGBoost, PyTorch (YOLOv8), Scikit-learn, Rasterio, SciPy (KDTree).
- [ ] **ML-01:** Set up a Python `FastAPI` service to handle heavy AI logic without blocking the Node.js event loop.
- [ ] **ML-02:** Load the pre-trained `feature_scaler_2.joblib`, the `KDTree` spatial index pickles, and the GeoTIFF raster handles into API memory on startup.
- [ ] **ML-03:** Integrate the **Open-Meteo API** (`https://api.open-meteo.com/v1/forecast`) to fetch hourly precipitation for the target NER coordinates.
- [ ] **ML-04 (Hazard):** Train the `XGBoost` classifier on the pre-split Parquet data (`X_train_2.parquet`, `y_train_2.parquet`) to output a `Landslide Risk Probability Score (0-1)`.
- [ ] **ML-05 (Vision):** Train a **YOLOv8 (PyTorch)** nano model on the `05_vision_hazard_detection_yolo` dataset to classify incoming driver photos (Landslide/Flood/Obstruction).
- [ ] **ML-06:** Expose `POST /predict-hazard` and `POST /verify-incident` endpoints for the Node.js backend to consume.

## Epic 3: The Command Center (Web Dashboard)
**Tech Stack:** React.js, Tailwind CSS, Deck.gl / Mapbox GL JS, Socket.IO-client.
- [ ] **WEB-01:** Scaffold a React application with a dark-mode Tailwind UI (vital for command centers).
- [ ] **WEB-02:** Integrate `Deck.gl` over a free `MapTiler` or `OpenStreetMap` basemap to render the road network.
- [ ] **WEB-03:** Connect `Socket.IO-client` to listen for `truck_location_update` events and animate truck markers smoothly on the map.
- [ ] **WEB-04:** Build the "Disruption Overlay" toggle that pulls the XGBoost risk scores and colors high-risk highway segments red.
- [ ] **WEB-05:** Create the incident management panel where dispatchers can view driver-uploaded photos of roadblocks and approve reroutes.

## Epic 4: The Edge Engine & IDR Mobile App (Driver Client)
**Tech Stack:** React Native, C++, TensorFlow Lite, WatermelonDB, Bhashini API.
- [ ] **MOB-01:** Scaffold a React Native app. Implement `react-native-geolocation-service` for standard online tracking.
- [ ] **MOB-02:** Implement `WatermelonDB` for the offline-first queue to store tracking points when the network drops.
- [ ] **MOB-03:** Write the network state listener. When connectivity is restored, trigger the Burst Sync queue drain to the backend.
- [ ] **MOB-04 (The ISRO IDR Core):** Write a native C++ module (accessed via JNI/Objective-C++) that implements the **Extended Kalman Filter (EKF)** using a lightweight matrix math library (e.g., `Eigen`).
- [ ] **MOB-05:** Train a 1D-CNN **TensorFlow Lite** model on the **IO-VNBD dataset** to map noisy IMU vibration patterns to a predicted forward vehicle speed. Load this `.tflite` model locally on the phone.
- [ ] **MOB-06:** Feed the TFLite speed predictions and gyroscope data into the C++ EKF to calculate Dead Reckoning coordinates during a GPS blackout.
- [ ] **MOB-07:** Integrate the **Bhashini TTS API** (via `bhashini-translator` or REST) so that when the Node.js backend pushes a reroute event, the app automatically reads the translated alert aloud to the driver hands-free.

---

# Session Handoff — read this first

Everything above is the **plan** (what the platform should be). Everything
below is the **state** (what actually exists as of 2026-08-26). Where the two
disagree, below is the one that was checked against a running system.
`REVISION.md` carries the full history and the reasoning; this is the digest.

## 1. State & stack

**Chunks 1-5 complete, approved and merged to `main`.** Those are all the
chunks the plan defines; there is no chunk 6 or 7. Next is **Phase 3: Live
Cloud Deployment and Android Hardware Testing**, which is the first work that
needs infrastructure and a handset rather than this laptop.

| Component | Where | Status |
|---|---|---|
| AI service | `ai-services/` (own `.venv`, py3.12) | FastAPI :8000, 59 tests pass |
| Backend | `backend/` (Node 20) | Express+Socket.IO :4000, BullMQ :6380, PostGIS :5433 |
| Edge engine | `mobile-app/native/` | Eigen EKF + map-matcher + flat C API, 54 checks pass |
| Driver client | `mobile-app/src/` | services + UI written, **never built or rendered** |
| Dashboard | `dashboard/` | Vite+React+deck.gl/MapLibre :5173, 27/27 checks |

Road graph: **486,784 edges / 412,914 nodes**. Mobile extract: 104 MB
SQLite+R*Tree. Migrations 001-011, ledgered and idempotent.

Verification commands:

    ai-services/.venv/bin/python -m pytest ai-services/tests -q   # 62 + 1 skip
    make -C mobile-app/native/test run                            # 54
    cd dashboard && node --test test/                             # 10, heading math
    cd dashboard && node verify.mjs                               # 27
    cd backend && node test/e2e_verify.mjs                        # full loop
    cd backend && npm run verify:alternatives                     # routes + scoping
    cd backend && npm run verify:reroute                          # offer/decline/accept
    cd backend && npm run verify:visibility                       # a report reaches a human
    cd backend && node simulate_dark_zone_mission.mjs             # Chunk 5

`verify.mjs` and `verify:alternatives` both need live telemetry; start it with
`cd backend && node test/mock_stream.mjs --seconds 900`, which also seeds the
pending incident `verify.mjs` consumes.

`npm test` runs `node --test test/`, and Node treats EVERY file under a
directory called `test/` as a test file -- so it also launches
`mock_stream.mjs` and sits there for fifteen minutes. Run
`node --test test/travel_time.test.mjs` for the unit tests and the named
`verify:*` scripts for the rest.

The last one needs the burst-sync worker running (`cd backend && npm run
worker`) -- it is a separate process from `npm start`, and without it the
queue simply stalls with 0 failures, which reads as a hang rather than an
error.

## 2. What Phase 3 has to deal with

Nothing below is a regression. Each is a limitation that was accepted with a
reason, and each becomes real work once there is a handset and a cloud.

* **The React Native app has never been built or rendered.** There is no
  mobile toolchain on this machine. `src/ui/` is verified only by parse:
  every file parses, every JSX tag is bound, every import resolves. Layout,
  font fallback and `fontVariant` on Android are all unverified. This is the
  single largest unknown going into hardware testing.
* **The TFLite 1D-CNN has never executed.** `libtensorflowlite` is an
  NDK/CocoaPods artefact, so `native/test/` stubs it and the Chunk 5 mission
  injects the speed measurement at the model's own held-out error (RMSE
  5.259 m/s). The EKF and the R*Tree map matching are exercised for real; the
  speed model is not. First run on a handset is its first run anywhere.
* **Open Q8: the vision model is out of distribution on its real HAZARD
  input.** Half of this is now closed. The "nothing wrong here" class exists
  and is real: 1,467 ordinary ground-level photographs, content-derived, so a
  random photo no longer has to be a flood or a landslide. What is NOT closed
  is the other half -- both HAZARD classes are still satellite and aerial
  imagery, so a driver's ground-level photo of a genuine landslide remains out
  of distribution. Being able to say "nothing here" is a different capability
  from recognising something that is. Closing the rest needs a few hundred
  ground-level NER photos *per hazard class*; drop them into
  `data/raw/vision/` and retrain, no code change. Still blocks autonomous
  verification, which is why `INCIDENT_REQUIRE_REVIEW` stays on.
* **Hazard labels are synthetic.** Demonstrator only. The depth-2 baseline
  prints on every training run so the headline accuracy is never mistaken for
  forecasting skill.
* **No `oneway` column**, so routing is bidirectional.
* **`dashboard/verify.mjs` needs a pending incident seeded before it runs**
  and consumes one per run. It cleans up after itself now -- it clears what it
  approved and asserts 0 blocked edges -- but it does not create its own
  fixture. Seed with `POST /incidents/report`.

## 3. Active MCP servers and tools

`filesystem`, `postgres`, `playwright` — all connected. Skills: `superpowers`,
`ui-ux-pro-max` (+6 siblings), 14 taste skills, `web-design-guidelines`.
CLI: `uipro`.

## 4. Critical decisions — do not relitigate

These were each established by measurement. Reversing one without new evidence
will reintroduce a bug that has already been found and fixed once.

1. **KDTrees hold projected metres, not degrees**:
   `x = lon*111139*cos(25.5°)`, `y = lat*111139`. A raw degree query returns a
   neighbour ~400 km away without erroring. Distances are always haversine.
2. **The training parquet's 8 features are already RobustScaler output.**
   Only lat/lon are raw. Re-scaling desyncs training from serving silently.
3. **torch and xgboost cannot share a macOS process** (three OpenMP runtimes).
   Vision runs in a spawned worker; the parent never imports torch.
4. **Vision model is 3-class**: the two hazards plus a real NORMAL_TERRAIN.
   With only the two hazards the softmax summed to 1 over them, so top-1 was
   >= 0.5 by construction and every image on earth was a flood or a landslide
   -- a photo of a footballer scored ACTIVE_LANDSLIDE_DEBRIS at 1.000. That
   was a missing class, not a threshold to tune; no cutoff separates it
   (held-out normal terrain scored 0.794 median against 0.786 for real
   landslides). NORMAL_TERRAIN is sourced separately by
   `scripts/fetch_normal_terrain.py`, NOT from the dataset's shipped label of
   that name, which is filename arithmetic. DAMAGED_BRIDGE stays out: still
   arithmetic, verified 1380/1380. `requires_human_review` is still always
   true -- see Q8 for the half that is not fixed.
5. **Only `verified` blocks an edge.** Reports land in
   `pending_dispatcher_approval`; `AUTO_BLOCK_ON_AI_VERDICT=0` must stay 0.
6. **The 999999 blocked cost lives in the `routable_edges` view.** Never
   `UPDATE road_edges.cost` — clearing an incident must restore routing exactly.
7. **Hazard features were rebuilt from rasters AND relabelled.** Moving the
   feature without the label inverts the model (it called a 1.8° valley floor
   a landslide while scoring 0.907).
8. **The speed model is a weak measurement**: R = RMSE² = 27.66, seed prior
   1.0. Map-matching is what bounds drift (261,693 → 14.4 m² over 60 s).
9. **Decimate IMU 100→10 Hz by averaging**, not sub-sampling — sub-sampling
   aliases vibration into the model's band.
10. **Mobile uses SQLite + R\*Tree, not SpatiaLite** — React Native cannot load
    `mod_spatialite`.
11. **Rainfall uses the forecast window, located via `hourly.time`.** Never
    slice from index 0: the series starts at 00:00 UTC, not now.
12. **Truck interpolation is a lag, never extrapolation.** Drawing ahead of the
    last fix puts a truck where no telemetry placed it.
13. **Basemap is CARTO dark over OSM** — no API key, no Mapbox token.
14. **A hazard closes a ROAD, not an edge** (migration 011). Blocking only the
    edge a report snaps to — 104 m of NH37 — let A* leave the highway at the
    landslide and rejoin it 7 m later over the parallel carriageway: a
    "reroute" 99.6% identical to the road the driver was already on. Closures
    are a set (`incident_blocked_edges`), gathered by `road_closure_edges` from
    every edge of the same road family within `CLOSURE_RADIUS_M` (120 m).
    Same report, real detour: 95,164 m → 106,540 m.
15. **Alternatives come from iterative penalisation, NOT `pgr_ksp`.** Yen's
    algorithm minimises cost subject to a different edge *sequence*, which on
    this graph returned four paths differing by a metre (95,164 / 95,165 /
    95,165 / 95,166 m) — four names for one road. `route_alternatives` plans,
    multiplies the cost of every edge just used, replans, and keeps a
    candidate only if it overlaps the accepted set by under `max_overlap` of
    its own length. Same corridor: 95.2 / 98.9 / 157.2 km, the second sharing
    4.1%.
16. **`avoid_edges` is a hard exclusion; 999999 is a price.** The view's
    blocked cost is a strong hint and A* will still drive a closed road when
    the alternative costs more — correct for a risk weighting, wrong for a
    landslide. Reroutes exclude closed edges from the graph outright.
17. **"Who is affected" and "what to avoid" are different edge sets.** The
    first is *this* incident's closure; the second is every closed edge on the
    network. Asking the first with the second made the affected-trip scan grow
    with the whole incident history — 203 s on a dispatcher's approve click,
    returning the same one trip. Related: never join trips to edges and
    `ST_DWithin(planned_route::geography, …)` per edge; that re-casts a
    4,400-point line per edge per trip (70,409 ms). Buffer the closure once
    and `ST_Intersects` in geometry (27 ms).
18. **An unreviewed incident is addressed to its reporter, never the fleet.**
    `incident_reported` was `io.emit`, so one driver's photo raised a
    full-screen ROAD OBSTRUCTION AHEAD on every handset — before any
    dispatcher saw it, on trucks in other states, while nothing was blocked.
    Report → `dispatchers` + `truck:<reporter>`. Approval → `dispatchers` +
    every truck whose route crosses the closure. `scope` on the payload
    (`awaiting_approval` / `verified`) is what makes the card's words match.
19. **Truck heading comes from the road, not from two fixes.** A 5 m receiver
    error on an 8 m leg is a 30° bearing error, and the marker is interpolated
    so the drawn position is not the position that bearing was measured from.
    `RouteTracker` projects the truck onto its route and takes the segment
    bearing, keeping a cursor so it is a local search rather than a scan of
    4,400 vertices. Fix-to-fix survives only as the fallback for a truck with
    no active trip.
