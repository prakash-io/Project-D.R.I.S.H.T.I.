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