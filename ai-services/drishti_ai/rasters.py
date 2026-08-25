"""Elevation / slope / aspect lookup over the 27 terrain GeoTIFFs (ML-02).

`data/raw/terrain/` holds nine regional sheets in three layers (dem, slope,
aspect), all EPSG:4326 at 1 arc-second (~30 m), float32, nodata -9999.

Two things make this more than a one-line `ds.sample()`:

*   **The sheets overlap.** Assam spans (89.7, 24.1, 96.0, 28.0) and Arunachal
    Pradesh spans (91.5, 26.6, 97.5, 29.5), so a point near Tezpur sits in
    both. Without a rule, which sheet answers depends on directory-listing
    order, and the same coordinate can return different elevations on two
    machines. Candidates are therefore tried **smallest-sheet-first**: the
    tighter sheet is the more specific one for that area, and the order is
    fixed by area, not by filesystem.

*   **Covering is not the same as valid.** A sheet's bounding box is a
    rectangle but its data is a clipped state boundary, so a point inside the
    box can still read -9999. A nodata read falls through to the next
    candidate rather than being returned as an elevation of -9999 metres,
    which would otherwise sail through the scaler and into the model as an
    extreme outlier.

Handles are opened once at startup and kept open. rasterio reads windows
lazily, so 27 open handles cost file descriptors, not the 7.4 GB on disk.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import rasterio

LAYERS = ("dem", "slope", "aspect")

#: Feature name each layer supplies, matching the scaler's column names.
LAYER_FEATURE = {"dem": "elevation_m", "slope": "slope_deg", "aspect": "aspect_deg"}


@dataclass
class Sheet:
    region: str
    layer: str
    path: Path
    dataset: rasterio.DatasetReader

    @property
    def area(self) -> float:
        b = self.dataset.bounds
        return (b.right - b.left) * (b.top - b.bottom)

    def covers(self, lon: float, lat: float) -> bool:
        b = self.dataset.bounds
        return b.left <= lon <= b.right and b.bottom <= lat <= b.top


class TerrainSampler:
    """Point sampler across the regional sheets of all three layers."""

    def __init__(self, raster_dir: Path):
        self.raster_dir = raster_dir
        self.sheets: dict[str, list[Sheet]] = {layer: [] for layer in LAYERS}
        self._open(raster_dir)

    def _open(self, raster_dir: Path) -> None:
        if not raster_dir.is_dir():
            raise FileNotFoundError(f"terrain raster dir not found: {raster_dir}")

        for path in sorted(raster_dir.glob("*.tif")):
            layer = next((l for l in LAYERS if f"_{l}_" in path.name), None)
            if layer is None:
                continue
            region = path.name.split(f"_{layer}_")[0]
            ds = rasterio.open(path)
            if ds.crs is None or ds.crs.to_epsg() != 4326:
                raise ValueError(
                    f"{path.name}: CRS is {ds.crs}, expected EPSG:4326. "
                    "Reproject at ingest -- never at query time."
                )
            self.sheets[layer].append(Sheet(region, layer, path, ds))

        for layer in LAYERS:
            if not self.sheets[layer]:
                raise FileNotFoundError(f"no '{layer}' rasters found in {raster_dir}")
            # Smallest sheet first. See module docstring.
            self.sheets[layer].sort(key=lambda s: s.area)

    def close(self) -> None:
        for layer in LAYERS:
            for sheet in self.sheets[layer]:
                sheet.dataset.close()

    @property
    def sheet_count(self) -> int:
        return sum(len(v) for v in self.sheets.values())

    def sample(self, layer: str, lat: float, lon: float) -> tuple[float | None, str | None]:
        """Return (value, region) for the first covering sheet with real data."""
        for sheet in self.sheets[layer]:
            if not sheet.covers(lon, lat):
                continue
            value = float(next(sheet.dataset.sample([(lon, lat)], 1))[0])
            nodata = sheet.dataset.nodata
            if nodata is not None and math.isclose(value, nodata, rel_tol=0, abs_tol=1e-6):
                continue
            if math.isnan(value):
                continue
            return value, sheet.region
        return None, None

    def sample_all(self, lat: float, lon: float) -> dict[str, dict]:
        """Sample all three layers at one coordinate."""
        out: dict[str, dict] = {}
        for layer in LAYERS:
            value, region = self.sample(layer, lat, lon)
            out[LAYER_FEATURE[layer]] = {"value": value, "region": region, "layer": layer}
        return out
