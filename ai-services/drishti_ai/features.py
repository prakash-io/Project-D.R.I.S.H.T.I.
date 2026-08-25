"""Assembly of the eight-feature hazard vector for a live coordinate.

The model is trained on RobustScaler output; every consumer of it must hand it
scaled values in the scaler's own column order. This module is the single
place that turns a (lat, lon) plus a weather lookup into that vector, so the
ordering exists once rather than in each caller.

Where the eight come from:

    elevation_m             GeoTIFF  (dem sheet)
    slope_deg               GeoTIFF  (slope sheet)
    aspect_deg              GeoTIFF  (aspect sheet)
    dist_to_river_m         KDTree   river_waterways   + haversine
    dist_to_road_m          KDTree   road_network      + haversine
    rainfall_72h_mm         Open-Meteo
    rainfall_24h_mm         Open-Meteo
    rainfall_intensity_mmh  Open-Meteo  (peak hourly, not mean)

A coordinate outside every terrain sheet cannot be scored. Substituting a
mean, a zero or the nodata value would all produce a confident number from
data that does not exist, so `FeatureUnavailable` is raised and the endpoint
answers 422. The NER sheets are the service's declared coverage; a point
outside them is a client error, not a model input.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


class FeatureUnavailable(RuntimeError):
    """A required feature could not be produced for this coordinate."""

    def __init__(self, message: str, missing: list[str]):
        super().__init__(message)
        self.missing = missing


@dataclass
class FeatureVector:
    """Raw (unscaled) features plus the provenance of each one."""

    raw: dict[str, float]
    terrain_region: str | None
    nearest_river_m: float
    nearest_road_m: float
    weather: dict[str, float]
    overrides: dict[str, float]

    def ordered(self, feature_names: list[str]) -> np.ndarray:
        """Raw values as a (1, 8) array in the scaler's column order."""
        return np.array([[self.raw[name] for name in feature_names]], dtype=np.float64)


class FeatureBuilder:
    """Turns a coordinate into the model's raw feature vector."""

    def __init__(self, terrain, river_index, road_index, feature_names: list[str]):
        self.terrain = terrain
        self.river_index = river_index
        self.road_index = road_index
        self.feature_names = feature_names

    def build(
        self,
        lat: float,
        lon: float,
        weather_features: dict[str, float],
        overrides: dict[str, float] | None = None,
    ) -> FeatureVector:
        overrides = dict(overrides or {})
        unknown = [k for k in overrides if k not in self.feature_names]
        if unknown:
            raise FeatureUnavailable(
                f"unknown feature override(s): {unknown}. "
                f"Valid names: {self.feature_names}",
                unknown,
            )

        terrain = self.terrain.sample_all(lat, lon)
        raw: dict[str, float] = {}
        missing: list[str] = []
        region: str | None = None

        for name, info in terrain.items():
            if info["value"] is None:
                missing.append(name)
            else:
                raw[name] = float(info["value"])
                region = region or info["region"]

        river_m = self.river_index.distance_m(lat, lon)
        road_m = self.road_index.distance_m(lat, lon)
        raw["dist_to_river_m"] = river_m
        raw["dist_to_road_m"] = road_m
        raw.update(weather_features)

        # Overrides are applied last so a caller can substitute a terrain
        # value the rasters could not supply, which is the only way to score a
        # point outside the sheets without inventing data server-side.
        raw.update(overrides)
        missing = [m for m in missing if m not in overrides]

        if missing:
            raise FeatureUnavailable(
                f"coordinate ({lat}, {lon}) is outside the terrain rasters' valid "
                f"data for: {', '.join(missing)}. The service covers the NER sheets "
                f"only; supply these via `overrides` to score anyway.",
                missing,
            )

        still_missing = [n for n in self.feature_names if n not in raw]
        if still_missing:
            raise FeatureUnavailable(
                f"internal: feature(s) never populated: {still_missing}", still_missing
            )

        return FeatureVector(
            raw={k: float(raw[k]) for k in self.feature_names},
            terrain_region=region,
            nearest_river_m=river_m,
            nearest_road_m=road_m,
            weather=dict(weather_features),
            overrides=overrides,
        )
