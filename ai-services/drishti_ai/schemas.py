"""Request/response contracts for the AI service.

These are the boundary the Node.js backend codes against, so field names are
chosen to be unambiguous on the other side: every distance carries `_m`, every
probability is 0..1, and the incident verdict names the `incidents.kind` value
directly rather than a YOLO class the backend would have to re-map.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

# The NER coverage box, taken from the union of the terrain sheets. Rejecting
# out-of-box coordinates at validation is cheaper and clearer than letting
# them reach the rasters and fail there.
LAT_MIN, LAT_MAX = 21.0, 30.0
LON_MIN, LON_MAX = 87.5, 98.0


class HazardRequest(BaseModel):
    latitude: float = Field(..., ge=LAT_MIN, le=LAT_MAX, examples=[27.5])
    longitude: float = Field(..., ge=LON_MIN, le=LON_MAX, examples=[92.0])
    #: Substitute any of the eight raw features. The intended uses are
    #: replaying a historical rainfall scenario and scoring a point the
    #: terrain sheets do not cover. Values are raw units, not scaled.
    overrides: dict[str, float] | None = Field(
        default=None,
        description="Raw-unit overrides for any of the 8 model features.",
    )
    use_weather_cache: bool = True


class FeatureProvenance(BaseModel):
    """Where each served feature came from -- the audit trail for a score."""

    terrain_region: str | None
    nearest_river_m: float
    nearest_road_m: float
    weather_source: str
    #: 'forecast' (next N hours) or 'antecedent' (previous N hours). Which one
    #: the rainfall features describe changes what the score means, so it is
    #: reported rather than assumed. 'override' when the caller supplied them.
    rainfall_window: str
    #: First hour of the window, UTC. The series Open-Meteo returns starts at
    #: 00:00, so this is the proof that the window was located rather than
    #: sliced from index 0.
    rainfall_window_start_utc: str | None
    #: Hours in each window that carried a real value. Below 24/72 means
    #: Open-Meteo had gaps and the figures cover only what it had.
    rainfall_hours_known_24h: int
    rainfall_hours_known_72h: int
    overrides_applied: dict[str, float]


class HazardResponse(BaseModel):
    latitude: float
    longitude: float
    #: 1 - P(SAFE_TERRAIN). This is the number RISK_FLAG_THRESHOLD compares
    #: against and the one WEB-04 colours a segment red on.
    hazard_probability: float
    predicted_class: str
    class_probabilities: dict[str, float]
    high_risk: bool
    risk_threshold: float
    #: Raw, unscaled feature values actually fed to the scaler.
    features: dict[str, float]
    provenance: FeatureProvenance
    #: Features whose value fell outside the model's entire training support.
    #: Trees do not extrapolate, so a score with entries here is pinned to the
    #: edge of what was seen, not predicted.
    out_of_distribution_features: list[str]
    #: Features whose TRAINING values do not correspond to what this service
    #: computes for the same coordinate. Non-empty means the score is not a
    #: calibrated probability. See config.UNVALIDATED_FEATURES.
    unvalidated_features: list[str]
    #: False whenever either list above is non-empty. WEB-04 should not paint
    #: a corridor red on an untrustworthy score without saying so.
    trustworthy: bool


class IncidentResponse(BaseModel):
    verified: bool
    #: Maps straight onto the incidents.kind CHECK constraint, or null when
    #: the photo does not depict a blockable incident.
    incident_kind: str | None
    predicted_class: str
    confidence: float
    class_probabilities: dict[str, float]
    conf_threshold: float
    reason: str
    #: API-03 MUST NOT set an edge cost to 999999 while this is true -- route
    #: the incident to the WEB-05 dispatcher panel first. It is true by
    #: default because the model has no "no incident" class and is out of
    #: distribution on ground-level photographs. See config.INCIDENT_REQUIRE_REVIEW.
    requires_human_review: bool
    review_reason: str | None


class HealthResponse(BaseModel):
    service: str
    status: str
    hazard_model: dict
    indices: dict[str, int]
    terrain_sheets: int
    vision_weights_present: bool
