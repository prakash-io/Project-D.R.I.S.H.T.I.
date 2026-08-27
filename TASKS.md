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

- [ ] 1.1 Audit and confirm the existing toggle path end to end
- [ ] 1.2 Feed the simulated corridor into the dark-zone/EKF path so offline tracking demonstrates
- [ ] 1.3 Confirm the real-GNSS path is untouched when `isSimulated === false`
- [ ] 1.4 Confirm no change to the flat C API or the socket payload

Verify: `node mobile-app/verify_parse.mjs` + `make -C mobile-app/native/test run`

Status: **pending**

---

## Task 3 — AI vision retraining & blind-spot management (YOLOv8)

Starting state: `scripts/fetch_normal_terrain.py` and `scripts/train_incident_yolo.py`
exist. `.env.example` already carries `AUTO_BLOCK_ON_AI_VERDICT=0` and
`INCIDENT_REQUIRE_REVIEW=1`. `data/` is gitignored and must be rebuilt locally.

- [ ] 3.1 Confirm the `NORMAL_TERRAIN` safe class is final in the training pipeline
- [ ] 3.2 Assert `INCIDENT_REQUIRE_REVIEW=1` and `AUTO_BLOCK_ON_AI_VERDICT=0`
- [ ] 3.3 Write `rebuild_ai.sh` — fetch 1,467 normal-terrain images, run 40-epoch retrain
- [ ] 3.4 Comment in the script exactly where real ground-level NER photos are dropped

Verify: `bash -n scripts/rebuild_ai.sh` + `ai-services/.venv/bin/python -m pytest ai-services/tests -q`

Status: **pending**

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
