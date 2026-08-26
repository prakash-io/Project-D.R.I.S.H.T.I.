// The map: deck.gl layers over a MapLibre basemap (WEB-02, WEB-03, WEB-04).
import React, { useMemo } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, PathLayer } from '@deck.gl/layers';
import Map from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import { BASEMAP_STYLE, INITIAL_VIEW_STATE } from '../lib/mapStyle';

/// Red at 1.0 through amber at the threshold. A dispatcher should be able to
/// rank two red corridors by eye without reading a number off either.
function riskColor(score) {
  const t = Math.max(0, Math.min(1, (score - 0.85) / 0.15));
  return [248, 81, 73, 140 + Math.round(t * 115)];
}

export default function MapView({ trucks, riskFeatures, showRisk, showTrucks, onTruckClick }) {
  const layers = useMemo(() => {
    const built = [];

    if (showRisk && riskFeatures.length > 0) {
      built.push(new PathLayer({
        id: 'risk-corridors',
        data: riskFeatures,
        getPath: (f) => f.geometry.coordinates,
        getColor: (f) => riskColor(f.properties.risk_score),
        // Metres, so the corridor keeps its real width as the dispatcher
        // zooms; a pixel-width line would vanish at region scale, which is
        // exactly the zoom at which this overlay is useful.
        widthUnits: 'meters',
        getWidth: 60,
        widthMinPixels: 2,
        capRounded: true,
        jointRounded: true,
        pickable: true,
      }));
    }

    if (showTrucks) {
      // Uncertainty halo, drawn under the marker. A dead-reckoned truck has a
      // covariance in the schema for exactly this reason -- the dispatcher
      // must be able to see that a position during a blackout is an estimate,
      // not a fix.
      built.push(new ScatterplotLayer({
        id: 'truck-uncertainty',
        data: trucks.filter((t) => t.source === 'ekf' && t.covariance_m2 > 0),
        getPosition: (d) => d.position,
        getRadius: (d) => Math.sqrt(d.covariance_m2),
        radiusUnits: 'meters',
        getFillColor: [210, 153, 34, 40],
        stroked: true,
        getLineColor: [210, 153, 34, 120],
        lineWidthMinPixels: 1,
        radiusMinPixels: 4,
      }));

      built.push(new ScatterplotLayer({
        id: 'trucks',
        data: trucks,
        getPosition: (d) => d.position,
        // Amber for dead-reckoned, blue for a real GNSS fix. The distinction
        // is the whole product.
        getFillColor: (d) => (d.source === 'ekf' ? [210, 153, 34] : [88, 166, 255]),
        getLineColor: [13, 17, 23],
        lineWidthMinPixels: 2,
        stroked: true,
        radiusUnits: 'pixels',
        getRadius: 7,
        pickable: true,
        onClick: (info) => onTruckClick?.(info.object),
        // deck.gl memoises layer data by reference; without this the markers
        // would only redraw when the array identity changed, which is once a
        // second -- undoing the interpolation entirely.
        updateTriggers: { getPosition: trucks },
      }));
    }

    return built;
  }, [trucks, riskFeatures, showRisk, showTrucks, onTruckClick]);

  return (
    <DeckGL
      initialViewState={INITIAL_VIEW_STATE}
      controller={{ dragRotate: false }}
      layers={layers}
      getTooltip={({ object }) => {
        if (!object) return null;
        if (object.properties?.risk_score !== undefined) {
          return {
            text: `${object.properties.name ?? 'unnamed road'}\n`
              + `${object.properties.highway ?? ''}\n`
              + `risk ${(object.properties.risk_score * 100).toFixed(1)}%`,
          };
        }
        if (object.truck_id) {
          return {
            text: `${object.truck_id.slice(0, 8)}\n`
              + `${object.source === 'ekf' ? 'DEAD RECKONING' : 'GNSS'}\n`
              + `${(object.speed ?? 0).toFixed(1)} m/s`
              + (object.covariance_m2 ? `\n±${Math.sqrt(object.covariance_m2).toFixed(0)} m` : ''),
          };
        }
        return null;
      }}
    >
      <Map reuseMaps mapStyle={BASEMAP_STYLE} />
    </DeckGL>
  );
}
