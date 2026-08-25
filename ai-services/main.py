#!/usr/bin/env python3
"""D.R.I.S.H.T.I. AI hybrid microservice (ML-01, ML-06).

    ai-services/.venv/bin/uvicorn main:app --app-dir ai-services --port 8000

Exists so the heavy AI work -- XGBoost, torch, 7.4 GB of rasters, a 6.25 M
point KDTree -- lives outside the Node.js event loop. Node calls the two
endpoints below and stays free to serve Socket.IO telemetry.

Everything expensive is loaded once in `lifespan` and validated there:
the model, its scaler, the spatial indices (including a projection self-check)
and the raster handles. A missing artefact fails startup rather than the first
request, so an unhealthy container never reports ready.
"""

from __future__ import annotations

import io
import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, HTTPException, UploadFile
from PIL import Image, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool

from drishti_ai import config
from drishti_ai.features import FeatureBuilder, FeatureUnavailable
from drishti_ai.models import HazardModel, IncidentVerifier, load_index
from drishti_ai.rasters import TerrainSampler
from drishti_ai.schemas import (FeatureProvenance, HazardRequest, HazardResponse,
                                HealthResponse, IncidentResponse)
from drishti_ai.weather import OpenMeteoClient, WeatherUnavailable

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(message)s")
log = logging.getLogger(config.SERVICE_NAME)

state: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    t0 = time.time()
    log.info("loading hazard model from %s", config.XGB_MODEL_PATH)
    state["hazard"] = HazardModel(config.XGB_MODEL_PATH, config.FEATURE_SCALER_PATH)
    log.info("  %d features, classes %s", len(state["hazard"].features), state["hazard"].classes)

    log.info("loading spatial indices")
    state["river_index"] = load_index("river_waterways", config.RIVER_KDTREE_PATH)
    state["road_index"] = load_index("road_network", config.ROAD_KDTREE_PATH)
    state["bridge_index"] = load_index("bridges", config.BRIDGE_KDTREE_PATH)
    if config.LOAD_PINCH_INDEX:
        state["pinch_index"] = load_index("hazard_pinch_points", config.PINCH_KDTREE_PATH)
    for name in ("river_index", "road_index", "bridge_index", "pinch_index"):
        if name in state:
            log.info("  %-14s %9d points (projection verified)", name, len(state[name]))

    log.info("opening terrain rasters in %s", config.TERRAIN_RASTER_DIR)
    state["terrain"] = TerrainSampler(config.TERRAIN_RASTER_DIR)
    log.info("  %d sheets across %d layers", state["terrain"].sheet_count, 3)

    state["features"] = FeatureBuilder(
        terrain=state["terrain"],
        river_index=state["river_index"],
        road_index=state["road_index"],
        feature_names=state["hazard"].features,
    )
    state["weather"] = OpenMeteoClient()
    state["vision"] = IncidentVerifier(
        config.YOLO_WEIGHTS, config.YOLO_CLASSES, config.YOLO_CONF_THRESHOLD
    )
    if not state["vision"].available:
        log.warning("YOLO weights absent at %s -- /verify-incident will 503 until "
                    "scripts/train_incident_yolo.py has run", config.YOLO_WEIGHTS)
    else:
        complaint = state["vision"].check_threshold(len(config.YOLO_CLASSES))
        if complaint:
            raise RuntimeError(complaint)
        log.info("  vision       %d classes %s, conf>=%.2f, review_required=%s",
                 len(config.YOLO_CLASSES), config.YOLO_CLASSES,
                 config.YOLO_CONF_THRESHOLD, config.INCIDENT_REQUIRE_REVIEW)

    log.info("ready in %.1fs", time.time() - t0)
    try:
        yield
    finally:
        await state["weather"].aclose()
        state["terrain"].close()
        state["vision"].shutdown()
        state.clear()


app = FastAPI(
    title="D.R.I.S.H.T.I. AI Hybrid Engine",
    version="1.0.0",
    description="Landslide/flood hazard scoring and incident photo verification.",
    lifespan=lifespan,
)


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    hazard = state["hazard"]
    return HealthResponse(
        service=config.SERVICE_NAME,
        status="ok",
        hazard_model={
            "classes": hazard.classes,
            "features": hazard.features,
            "best_iteration": hazard.best_iteration,
            "test_accuracy": hazard.meta.get("test", {}).get("accuracy"),
            "risk_threshold": config.RISK_FLAG_THRESHOLD,
            "feature_source": hazard.feature_source,
            "unvalidated_features": hazard.unvalidated_features,
        },
        indices={k.replace("_index", ""): len(v)
                 for k, v in state.items() if k.endswith("_index")},
        terrain_sheets=state["terrain"].sheet_count,
        vision_weights_present=state["vision"].available,
    )


@app.post("/predict-hazard", response_model=HazardResponse)
async def predict_hazard(request: HazardRequest) -> HazardResponse:
    """Landslide/flood risk for one coordinate (workflow section 5).

    Terrain comes from the GeoTIFFs, distances from the KDTrees measured by
    haversine, and rainfall from Open-Meteo -- the peak hourly value and the
    24/72-hour sums over a window located at the current hour, forward or
    antecedent per `RAINFALL_WINDOW`.
    """
    lat, lon = request.latitude, request.longitude
    overrides = request.overrides or {}

    # A caller that overrides all three rainfall features is replaying a
    # scenario and should not be blocked by -- or wait on -- the upstream API.
    rain_features = ["rainfall_72h_mm", "rainfall_24h_mm", "rainfall_intensity_mmh"]
    if all(f in overrides for f in rain_features):
        weather_features = {f: overrides[f] for f in rain_features}
        precip = None
        weather_source = "override"
    else:
        try:
            precip = await state["weather"].precipitation(
                lat, lon, use_cache=request.use_weather_cache
            )
        except WeatherUnavailable as exc:
            # Deliberately not falling back to a climatological mean: rainfall
            # is the only time-varying input, so a made-up value turns a live
            # forecast into a static terrain score that still looks live.
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        weather_features = precip.as_features()
        weather_source = precip.source

    try:
        vector = state["features"].build(lat, lon, weather_features, overrides)
    except FeatureUnavailable as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    hazard = state["hazard"]
    prediction = hazard.predict(vector.ordered(hazard.features))

    return HazardResponse(
        latitude=lat,
        longitude=lon,
        hazard_probability=prediction.hazard_probability,
        predicted_class=prediction.predicted_class,
        class_probabilities=prediction.class_probabilities,
        high_risk=prediction.high_risk,
        risk_threshold=config.RISK_FLAG_THRESHOLD,
        features=vector.raw,
        out_of_distribution_features=prediction.out_of_distribution,
        unvalidated_features=prediction.unvalidated_features,
        trustworthy=not (prediction.out_of_distribution
                         or prediction.unvalidated_features),
        provenance=FeatureProvenance(
            terrain_region=vector.terrain_region,
            nearest_river_m=vector.nearest_river_m,
            nearest_road_m=vector.nearest_road_m,
            weather_source=weather_source,
            rainfall_window=precip.window if precip else "override",
            rainfall_window_start_utc=precip.window_start_utc if precip else None,
            rainfall_hours_known_24h=precip.hours_known_24h if precip else 0,
            rainfall_hours_known_72h=precip.hours_known_72h if precip else 0,
            overrides_applied=vector.overrides,
        ),
    )


@app.post("/verify-incident", response_model=IncidentResponse)
async def verify_incident(file: UploadFile = File(...)) -> IncidentResponse:
    """Classify a driver's incident photo (workflow section 4, API-03).

    The backend blocks a road edge on the strength of this answer, so the
    verdict is conservative twice over. Anything below the confidence
    threshold, and anything classified NORMAL_TERRAIN, comes back
    `verified: false` with `incident_kind: null`. And while
    `INCIDENT_REQUIRE_REVIEW` is set, even a confident verdict carries
    `requires_human_review: true` -- the model has no "no incident" class and
    was trained on aerial and satellite imagery rather than the ground-level
    photographs a driver actually sends, so API-03 must route it through the
    WEB-05 dispatcher panel instead of blocking an edge directly.
    """
    vision = state["vision"]
    if not vision.available:
        raise HTTPException(
            status_code=503,
            detail=(f"YOLO weights not present at {config.YOLO_WEIGHTS}. "
                    f"Run scripts/train_incident_yolo.py."),
        )

    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="empty upload")
    try:
        # Decoded here purely to reject junk with a 400 before it costs a
        # round trip to the worker. The worker re-decodes from the same bytes;
        # a PIL image cannot cross a process boundary usefully.
        Image.open(io.BytesIO(payload)).verify()
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise HTTPException(
            status_code=400,
            detail=f"could not decode '{file.filename}' as an image",
        ) from exc

    try:
        # Blocking, and it waits on another process -- keep it off the event
        # loop or one photo upload stalls every telemetry-driven hazard query.
        verdict = await run_in_threadpool(vision.verify, payload)
    except TimeoutError as exc:
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except RuntimeError as exc:
        # The worker died. The pool has already been reset, so this is a
        # retryable 503 rather than a permanent failure.
        log.error("vision worker failure: %s", exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return IncidentResponse(
        verified=verdict.verified,
        incident_kind=verdict.incident_kind,
        predicted_class=verdict.predicted_class,
        confidence=verdict.confidence,
        class_probabilities=verdict.class_probabilities,
        conf_threshold=vision.conf_threshold,
        reason=verdict.reason,
        requires_human_review=verdict.requires_human_review,
        review_reason=verdict.review_reason,
    )
