# D.R.I.S.H.T.I. — Final Pending Requirements

Branch: `feat/gmaps-nav-experience`
Opened: 2026-08-28

Execution order is the one given in the brief: **Task 2 → Task 1 → Task 3 → Task 4**.
Each task is marked complete only after its verification command has been run and
its output recorded here. "Verified" in this file always means a command was run,
never that code was read and judged correct.

## Standing constraints (must not break)

- PostGIS routing (`pgr_astar`, the `routable_edges` view, the 999999 blocked cost)
- The C++ EKF edge engine and its flat C API
- The Socket.IO telemetry architecture
- `AUTO_BLOCK_ON_AI_VERDICT` stays `0`; `INCIDENT_REQUIRE_REVIEW` stays `1`
- Three.js stays **out of the map**. The map is deck.gl + MapLibre only.

---

## Task 2 — Dynamic 3D dashboard, navbar, multi-page & alerts (web)

Starting state: `dashboard/src/App.jsx` is a single page, brutalist/phosphor styled.
No router, no `three`, no `@deck.gl/mesh-layers` in `package.json`.

- [x] 2.1 Install `react-router-dom`, `three`, `@react-three/fiber`, `@deck.gl/mesh-layers`
- [x] 2.2 Restructure into routed pages: Live Map Command Center, Weather & Alerts, Analytics
- [x] 2.3 Glassmorphism sidebar/navbar with active-route state
- [x] 2.4 Three.js rotating logo in the navbar (non-map)
- [x] 2.5 Three.js 3D data visualisation on the Analytics page (non-map)
- [x] 2.6 `ScenegraphLayer` 3D `.glb` trucks on the map, bound to live Socket.IO telemetry
- [x] 2.7 `AlertFeed.jsx` polling `/predict-hazard`, filtering `hazard_probability > 0.85`
- [x] 2.8 Confirm Three.js appears in no map module

Verify: `cd dashboard && npm run check` then `node verify.mjs`

Status: **complete — verified 2026-08-28**

Two deviations from the brief, both deliberate:

* **Glass without rounded corners.** `tailwind.config.js` zeroes the whole
  border-radius scale by measurement, and `tokens.css` argues the case at
  length. Glass is built from the two properties that actually make a surface
  read as glass — translucency and backdrop blur — plus a lit top edge and a
  sheen. Radius stays 0, so the console keeps its visual argument.
* **`.glb`, not `.gltf`.** A JSON `.gltf` loads correctly under Node and fails
  in the browser: Vite serves it as `application/json`, loaders.gl routes it to
  the JSON loader, the result has no `.json` key, and `ScenegraphLayer` skips
  `postProcessGLTF` — so POSITION never becomes a typed array. `.glb` is
  identified by magic bytes and cannot be misrouted. Caught by `verify.mjs`,
  not by reading.

**`AlertFeed` reaches `/predict-hazard` through the backend's `POST /risk/route`,
not directly.** FastAPI is not CORS-open to the browser and holds the raster and
KDTree handles; `/risk/route` is the boundary, it samples the polyline before
scoring (≈12 model calls instead of 4,411), and it owns the `hourly.time`
rainfall-window rule that CLAUDE.md decision 11 requires be in exactly one place.

---

## Task 1 — Location toggle & simulation (React Native)

Starting state: **largely already implemented on this branch.** `src/ui/SourceToggle.jsx`
(segmented control), `Tracker.setSimulated()`, `Tracker.setCorridor()` and
`src/services/simulatedDrive.js` all exist and are wired through `App.jsx`.

The real gap is the brief's specific wording: *inject coordinates sequentially into
the C++ EKF engine to demonstrate offline tracking*. Today the simulated drive
substitutes the **online GNSS** source only. In the dark zone the EKF is fed by the
handset IMU, which on a stationary desk phone produces a truck that does not move —
so the offline half of the demo cannot currently be shown.

- [x] 1.1 Audit and confirm the existing toggle path end to end
- [x] 1.2 Feed the simulated corridor into the dark-zone/EKF path so offline tracking demonstrates
- [x] 1.3 Confirm the real-GNSS path is untouched when `isSimulated === false`
- [x] 1.4 Confirm no change to the flat C API or the socket payload

Verify: `cd mobile-app && npm run verify && npm run test:darkzone`
plus `make -C mobile-app/native/test run`

Status: **complete — verified 2026-08-28**

What was already there, and what was missing. The toggle, `SourceToggle.jsx`,
`Tracker.setSimulated()`, `setCorridor()` and `simulatedDrive.js` all existed
and were correct. They substitute the **GNSS receiver**, which covers workflow
section 1. They do nothing for section 2, because dead reckoning is not fed by
the position source — it is fed by the IMU. A handset on a desk with the
network pulled produced a *correct* dark zone in which the truck did not move,
and no amount of toggle wiring could have shown otherwise.

So `src/services/simulatedImu.js` synthesises the inertial stream a truck
driving the corridor would produce, and `startOffline` substitutes the inertial
sensor the same way `startOnline` substitutes the receiver. Everything
downstream is the same code: `edge.pushImu`, the C++ decimator, the EKF, the
R\*Tree matcher, the WatermelonDB rows, the burst sync.

`swapInertialSource()` exchanges the sensor **without restarting the engine**,
so flipping the toggle mid-blackout does not discard the EKF's accumulated
state and covariance — the only position estimate the driver has at that
moment.

Honest about what is simulated: the speed measurement is injected at the speed
model's own held-out error (sigma 5.259 m/s, `kSpeedMeasurementVariance`), not
cleanly, so the drift shown is the drift the real model would produce. Feeding
the TFLite CNN synthetic vibration would be meaningless — it was trained on
IO-VNBD recordings of real vehicles.

---

### Task 1 — 2026-08-28

`cd mobile-app && npm run verify`

    51 files scanned, 0 banned runtime call(s)
    no web/Node-only globals reach the handset
    49 files parsed, 0 failure(s)
    14 checks passed          # test/simulated_imu.test.mjs

`make -C mobile-app/native/test run`

    54 checks, 0 failures     # C++ EKF, map matcher, flat C API — unchanged

`npm run test:darkzone` — the new end-to-end. Generates the stream with
`SimulatedImu` and drives it through the REAL C++ engine against the shipped
104 MB road graph, on Guwahati → Shillong (4,411 vertices):

    1200 decimated fixes, match every 50
    profile:  t+0s 0m  t+30s 12m  t+60s 4m  t+90s 3m  t+120s 9m
    speed:    seeded 0 -> final 13.91 m/s (true 13.89)
    ok  the dead-reckoned track stays on the corridor   mean 16.1 m, worst 54.5 m
    ok  the R*Tree map matcher engaged                  24 of 1200 fixes
    ok  the EKF acquired speed from the injected measurements
    ok  the truck actually travelled                    1.19 km in 120s

Four things this found that reading could not:

1. **Yaw rate of 157 rad/s at every polyline vertex.** A corridor turns corners
   instantaneously; a real MEMS gyro saturates near 35 rad/s. The stream was
   replaying vertices rather than simulating a vehicle. Now rate-limited to
   45 deg/s, with speed cut through corners so heading stays consistent with
   motion — measured on this corridor, 90% of bends need under 22 deg/s but
   1.9% demand more than 45 and the worst hairpin asks 569.
2. **Speed injected at 1 Hz instead of the model's 10 Hz** (`kModelRateHz`).
   The measurement is deliberately weak, so the filter depends on averaging
   many; at a tenth of the rate the estimate drifted past the matcher's 60 m
   acceptance radius after ~40 s and the track ran 622 m wide.
3. **The test was flaky in a way that hid both.** Unseeded, the same
   configuration produced 43 m and 399 m of worst-case deviation on
   consecutive runs. `SimulatedImu` now takes an injectable `random`;
   the tests seed it.
4. **One assertion passed vacuously.** `Math.max(...[])` is `-Infinity`, which
   satisfies any upper bound — the yaw-limit check was "passing" on an empty
   sample set. `peakYaw()` now refuses an empty set.

Noted for hardware testing, not fixed: map-match outcomes are **sensitive to
where the matches land**, not simply to how often. Sweeping the interval over
one seeded stream gave 54 m (5 s), 321 m (2.5 s), 520 m (1 s) and 43 m (0.5 s)
— non-monotonic, because a match taken near a junction can snap to the wrong
edge and drag the heading onto it. The shipped 5 s interval performs well here;
this is a real characteristic of the matcher on dense road networks and is
worth watching on a handset, and no interval change was made on the strength
of one corridor.

---

## Task 3 — AI vision retraining & blind-spot management (YOLOv8)

Starting state: `scripts/fetch_normal_terrain.py` and `scripts/train_incident_yolo.py`
exist. `.env.example` already carries `AUTO_BLOCK_ON_AI_VERDICT=0` and
`INCIDENT_REQUIRE_REVIEW=1`. `data/` is gitignored and must be rebuilt locally.

- [x] 3.1 Confirm the `NORMAL_TERRAIN` safe class is final in the training pipeline
- [x] 3.2 Assert `INCIDENT_REQUIRE_REVIEW=1` and `AUTO_BLOCK_ON_AI_VERDICT=0`
- [x] 3.3 Write `rebuild_ai.sh` — fetch 1,467 normal-terrain images, run 40-epoch retrain
- [x] 3.4 Comment in the script exactly where real ground-level NER photos are dropped

Verify: `bash scripts/rebuild_ai.sh` (see log) + `pytest ai-services/tests -q`

Status: **complete — verified 2026-08-28**

The guardrails are **asserted, not merely documented.** `rebuild_ai.sh` refuses
to train if `INCIDENT_REQUIRE_REVIEW != 1` or `AUTO_BLOCK_ON_AI_VERDICT != 0`,
checking the environment first and `.env` second, because retraining is exactly
the moment those quietly get flipped. It also fails after training if
`NORMAL_TERRAIN` is absent from the model's class list — without a real safe
class the softmax sums to 1 over two hazards and every photograph on earth
becomes a flood or a landslide, which is the failure CLAUDE.md decision 4
records.

**Where ground-level NER photos go** (§3.4), verified against `pool_of()` in
`train_incident_yolo.py` rather than assumed:

    data/raw/vision/incident-yolo/{train,val,test}/images/
        landslide_ner_0001.jpg  ->  ACTIVE_LANDSLIDE_DEBRIS
        flood_ner_0001.jpg      ->  FLOODED_ROAD_OR_SUBMERGED

The class comes from the filename prefix before the first underscore, so no
label file and no code change is needed. Any other prefix is **silently
skipped**, not misfiled — the script prints a skip count, and that count is the
thing to check. Ordinary hazard-free road photos go to the flat
`data/raw/vision/normal_terrain/` instead, which has its own filename-hashed
split so adding more never moves an existing image between train and test.

---

### Task 3 — 2026-08-28

Guardrail assertion, run with the flag deliberately flipped:

    AUTO_BLOCK_ON_AI_VERDICT=1 bash scripts/rebuild_ai.sh
      ok    INCIDENT_REQUIRE_REVIEW=1  (code default 1)
      error AUTO_BLOCK_ON_AI_VERDICT is '1', must be '0'
    exit 1 — training never started

Full path, end to end (`--epochs 1` for the test; the default is 40). The real
40-epoch model was backed up first and restored afterwards:

    ==> preflight            ultralytics, torch, pillow present
                             source hazard images: 1380
    ==> review guardrails    both ok
    ==> NORMAL_TERRAIN negatives   present: 1467 / 1467
    ==> training yolov8n-cls, 1 epochs      ... total 82.2s
    ==> verify
      classes: ACTIVE_LANDSLIDE_DEBRIS, FLOODED_ROAD_OR_SUBMERGED, NORMAL_TERRAIN
      top-1:   0.9739
        FLOODED_ROAD_OR_SUBMERGED          n=  92  recall=0.8913
        ACTIVE_LANDSLIDE_DEBRIS            n= 116  recall=0.9914
        NORMAL_TERRAIN                     n= 213  recall=1.0000

Restored afterwards and confirmed: `epochs = 40, top1 = 0.9905`, three classes.

`pytest ai-services/tests -q` (branch code, real artefacts) — **57 passed, 6
skipped**.

Three bugs found by running rather than reading:

1. **`import importlib` does not bind `importlib.util`.** My preflight would
   have reported "missing training dependencies" on every healthy venv.
2. **`Path.relative_to(ROOT)` raises** when pointed outside its own checkout,
   and both existing scripts used it to build *log lines*. That crashed the
   training run outright under a worktree. Both now use a tolerant `rel()`.
3. **The verify block read meta keys that do not exist** (`classes`,
   `metrics.top1`), printing an empty class list. The real keys are
   `classes_model_index_order` and `test.top1` — and the model-index order is
   the one that matters, since the data.yaml order can differ and would
   mislabel every probability the service reports.

Also added `DRISHTI_DATA_ROOT`, because `data/` and the venv are gitignored and
a worktree therefore has the code but not the 104 MB of images — duplicating
the dataset per worktree would be worse than the inconvenience.

---

## Task 4 — Mitigating the unproven mobile hardware risk

Starting state: the RN app has never been built or rendered. **No `ErrorBoundary`
exists anywhere in `mobile-app/`.** `VehicleMarker.jsx` uses the native
`MapLibreRN.MarkerView` bridge, which is the most likely first-APK failure point.

- [ ] 4.1 Audit UI components, especially the `MarkerView` native module
- [ ] 4.2 Error Boundaries around the map and marker components
- [ ] 4.3 Fallback generic marker (plain circle) if `MarkerView` fails to bridge
- [ ] 4.4 Confirm universally supported fonts, with fallbacks

Verify: `node mobile-app/verify_parse.mjs`

Status: **pending**

---

## Verification log

Appended as each task closes. Command, then the output that justified the tick.

### Task 2 — 2026-08-28

`cd dashboard && npm run check`

    truck.glb OK
      ok  parsed result carries .json (deck.gl will post-process)
      ok  every POSITION resolves to a typed array   8 primitives, 72 floats
    ✓ built in 9.97s
    three.js isolation OK
      ok  three.js imported only by the allowed chrome modules
            components/Logo3D.jsx, components/RiskBars3D.jsx
      ok  map subtree reaches no three.js module     3 modules walked
      ok  map chunk is free of three.js              map-Dh9b9GM2.js
      ok  deck chunk is free of three.js             deck-B2hAy8TQ.js

`node verify.mjs` (real Chrome over CDP, backend :4000 + AI :8000 live,
`backend/test/mock_stream.mjs` driving two trucks)

    27 checks, 0 failures
    all checks passed
      ok  telemetry packets received  20
      ok  trucks rendered on the map  2 markers
      ok  no console errors
      ok  graph restored  0 active blocked edges

Routes checked in a live browser (Playwright MCP), 0 console errors on each:

* `/weather` — nav badge "51 segments over threshold"; cards read
  "Moderate Rainfall: Flood Risk on Guwahati → Dibrugarh"; the `degraded`
  banner fires for real on Siliguri → Gangtok, which falls outside the terrain
  rasters.
* `/analytics` — 14 bars + ranked table over 160 scored segments; live fleet
  split "Units reporting 2 · On GNSS fix 1 · Dead reckoning 1".

Two bugs found by verification and fixed, neither visible by reading:

1. `ScenegraphLayer` POSITION not a typed array — the `.gltf`/`.glb`
   content-type issue described above.
2. 185 duplicate-React-key errors on `/analytics`. The 3D bars were keyed on
   road name, and the extract has hundreds of edges sharing one name (two
   entries in the top 14 are both "de a2 panenkoek"). Now keyed on edge id,
   which also fixes hover highlighting every segment of the same road at once.
