// The map: deck.gl layers over a MapLibre basemap (WEB-02, WEB-03, WEB-04).
import React, { useMemo } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, PathLayer } from '@deck.gl/layers';
import { ScenegraphLayer } from '@deck.gl/mesh-layers';
import Map from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import { BASEMAP_STYLE, INITIAL_VIEW_STATE } from '../lib/mapStyle';

/// Served from public/, built by scripts/gen_truck_gltf.mjs. Not fetched from
/// a model CDN: this console must come up with no third-party request, the
/// same constraint that put the basemap behind our own /tiles proxy.
const TRUCK_MODEL = '/models/truck.glb';

/// Red at 1.0 through amber at the threshold. A dispatcher should be able to
/// rank two red corridors by eye without reading a number off either.
function riskColor(score) {
  const t = Math.max(0, Math.min(1, (score - 0.85) / 0.15));
  return [248, 81, 73, 140 + Math.round(t * 115)];
}

export default function MapView({
  trucks, riskFeatures, showRisk, showTrucks, onTruckClick,
  corridors, showCorridors, activeRoute,
}) {
  const layers = useMemo(() => {
    const built = [];

    // Pushed FIRST so it draws under everything else. A planned corridor is
    // infrastructure, not telemetry -- if it sat over a risk segment it would
    // hide the one thing the dispatcher is scanning for.
    //
    // Phosphor rather than a new hue. Section 4 allows red as the alert accent
    // plus the two encoded telemetry colours (GNSS blue, dead-reckoning
    // amber); a fourth semantic colour here would compete with all three.
    //
    // Phosphor and not the muted grey it started as, though. Grey was chosen
    // to let the corridor recede as infrastructure, and measured against the
    // rendered console that failed: after inversion Bhuvan draws its OWN road
    // hairlines in almost exactly #8A8A8A, so toggling the layer changed
    // 5,492 pixels and a dispatcher could not tell a planned corridor from
    // any other road on the basemap. #EAEAEA is the readout colour -- the
    // colour everything else that is DATA rather than ground is drawn in --
    // which is the right semantic and clears the basemap by contrast without
    // spending a hue.
    if (showCorridors && corridors.length > 0) {
      built.push(new PathLayer({
        id: 'corridors',
        data: corridors,
        getPath: (c) => c.geometry.coordinates,
        getColor: [234, 234, 234, 200],
        // Pixels, not metres: this line marks a route, not a physical width,
        // and it has to stay findable when the dispatcher zooms out to see
        // the whole North East at once.
        widthUnits: 'pixels',
        getWidth: 3,
        capRounded: true,
        jointRounded: true,
        pickable: true,
      }));
    }

    // The route the dispatcher just planned from the demo sidebar.
    //
    // No new hue. Section 4 spends its colours on alert red plus the two
    // encoded telemetry colours, and the corridors layer already argued that
    // a fourth would compete -- a selected route is the same KIND of thing as
    // a corridor, just the one being looked at, so it separates itself by
    // weight instead: drawn over the corridor layer, twice the width, fully
    // opaque against the corridor's 200 alpha.
    //
    // Pushed BEFORE the risk layer so a red segment still reads through the
    // route that crosses it. The whole point of planning over `routable_edges`
    // is to see the hazard the path is running into.
    if (activeRoute) {
      built.push(new PathLayer({
        id: 'active-route',
        data: [activeRoute],
        getPath: (r) => r.coordinates,
        getColor: [234, 234, 234, 255],
        widthUnits: 'pixels',
        getWidth: 6,
        capRounded: true,
        jointRounded: true,
        pickable: false,
      }));
    }

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

      // The ground anchor, kept UNDER the 3D model rather than replaced by it.
      //
      // Same reasoning VehicleMarker.jsx uses on the phone: the flat layer is
      // pure GL and always paints, the model is an asset that has to load. If
      // truck.gltf ever 404s behind a bad deploy, or a device gives up on the
      // scenegraph, the dispatcher still sees every truck in the right place
      // and the right colour -- they lose the silhouette, not the fleet.
      //
      // It also does real work when the model IS loading: at low zoom a
      // pitched 3D truck is a few pixels tall, and the dot is what makes the
      // position findable at region scale.
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
        getRadius: 5,
        pickable: true,
        onClick: (info) => onTruckClick?.(info.object),
        // deck.gl memoises layer data by reference; without this the markers
        // would only redraw when the array identity changed, which is once a
        // second -- undoing the interpolation entirely.
        updateTriggers: { getPosition: trucks },
      }));

      // The 3D vehicle (WEB-03). deck.gl's ScenegraphLayer, NOT three.js --
      // three.js is confined to the dashboard chrome (the nav mark and the
      // analytics chart) and never touches the map, so there is exactly one
      // renderer holding the map's projection and picking.
      built.push(new ScenegraphLayer({
        id: 'trucks-3d',
        data: trucks,
        scenegraph: TRUCK_MODEL,
        // No `loaders` override here, and that is deliberate — an earlier
        // version passed `loaders: [GLTFLoader]` as belt-and-braces and it
        // broke the layer outright:
        //
        //   Geometry truck-primitive-0 attribute POSITION:
        //   must be typed array or object with value as typed array
        //
        // ScenegraphLayer does not just parse the glTF, it parses it with
        // `postProcess: true`, which is the step that resolves accessors into
        // the typed arrays luma.gl builds its Geometry from. Supplying the
        // bare loader replaced that configured pipeline with an unconfigured
        // one, so the layer received raw accessor descriptors. The layer's
        // own default is already correct; overriding it can only be wrong.
        getPosition: (d) => d.position,
        // [pitch, yaw, roll]. The roll of 90 is what reconciles glTF's Y-up
        // convention with deck.gl's Z-up world; the model is built nose-along
        // +X, so negating the compass heading turns clockwise-from-north into
        // the scene's counter-clockwise yaw.
        getOrientation: (d) => [0, -(d.heading ?? 0), 90],
        // Tint, not texture. The model ships near-white specifically so this
        // multiply lands cleanly -- see scripts/gen_truck_gltf.mjs.
        getColor: (d) => (d.source === 'ekf' ? [210, 153, 34] : [88, 166, 255]),
        // Metres. The model is ~4.7 units nose to tail, so this renders a
        // vehicle about 14 m long: legible when a dispatcher zooms to a
        // junction, and honest about the footprint of a goods truck.
        sizeScale: 3,
        // Without a floor the truck shrinks to nothing at region zoom and the
        // dispatcher loses the heading exactly when scanning the whole map.
        sizeMinPixels: 12,
        sizeMaxPixels: 96,
        _lighting: 'pbr',
        pickable: true,
        onClick: (info) => onTruckClick?.(info.object),
        updateTriggers: {
          getPosition: trucks,
          getOrientation: trucks,
          getColor: trucks,
        },
      }));
    }

    return built;
  }, [trucks, riskFeatures, showRisk, showTrucks, onTruckClick, corridors,
      showCorridors, activeRoute]);

  return (
    <DeckGL
      initialViewState={INITIAL_VIEW_STATE}
      // Rotation is enabled now that the trucks are 3D models. It was off
      // while they were flat dots, where tilting only cost legibility; with a
      // scenegraph the dispatcher needs to be able to get around a vehicle to
      // read its heading against the road it is on.
      controller={{ dragRotate: true }}
      layers={layers}
      getTooltip={({ object }) => {
        if (!object) return null;
        // Corridor first: it also carries a `name`, so testing it after the
        // risk branch would be fine but after the truck branch would not.
        if (object.origin_name) {
          return {
            text: `${object.name}\n`
              + `${(object.distance_m / 1000).toFixed(0)} km · `
              + `${object.edge_count} segments`,
          };
        }
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
