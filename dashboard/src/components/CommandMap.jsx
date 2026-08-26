// <CommandMap /> -- the hybrid map engine (Deliverable 2, Tasks 1-3).
//
// deck.gl draws every piece of data; MapLibre draws only the basemap beneath
// it. That split is deliberate. The brief asks for hazards as a MapLibre
// SymbolLayer over a circular ShapeSource, which is @rnmapbox/maps vocabulary
// from the React Native side of this platform; on the web the equivalent pair
// is deck.gl's ScatterplotLayer + TextLayer, and using them keeps ALL data on
// one renderer. Mixing the two would mean hazards paint under the trucks with
// no way to order them, and would additionally require a `glyphs` endpoint for
// MapLibre to render text at all -- a second network dependency on a map whose
// premise is that the network fails.
//
// Layer order, bottom to top, is the read order a dispatcher needs:
//   risk corridors -> planned routes -> dark-zone paths -> live trails
//   -> uncertainty halos -> trucks -> hazard glow -> hazard labels
// Hazards sit above the fleet because a closed road outranks a moving truck.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, PathLayer, IconLayer, TextLayer } from '@deck.gl/layers';
import { PathStyleExtension } from '@deck.gl/extensions';
import { WebMercatorViewport, FlyToInterpolator } from '@deck.gl/core';
import Map from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';

import {
  bhuvanStyle, terrainStyle, FALLBACK_STYLE_URL, INITIAL_VIEW_STATE, probeBhuvan,
} from '../lib/bhuvan';
import { boundsOf, closestVertexAcross } from '../lib/googleRoutes';
import { useCommandStore, positionStore, splitTrailBySource } from '../store/commandStore';
import { shallow } from '../store/createStore';
import { TRUCK_ICON } from '../lib/truckIcon';

// Palette, matched to tokens.css by value so the map and the chrome cannot
// drift apart. Where a token exists these ARE that token's channels.
const CYAN = [34, 211, 238];        // live GNSS fix — the brief's cyan
const AMBER = [210, 153, 34];       // dead reckoning  (--p-deadrec)
const HAZARD = [248, 81, 73];       // (--p-hazard-300)
const ROUTE = [125, 211, 252];      // planned route, cooler than the trucks
const INK = [10, 10, 10];           // (--p-ink-000)

/// Red at 1.0 through amber at the threshold, so a dispatcher can rank two red
/// corridors by eye without reading a number off either.
function riskColor(score) {
  const t = Math.max(0, Math.min(1, (score - 0.85) / 0.15));
  return [248, 81, 73, 140 + Math.round(t * 115)];
}

const HAZARD_LABEL = {
  landslide: 'LANDSLIDE',
  flood: 'FLASH FLOOD',
  obstruction: 'OBSTRUCTION',
};

function hazardText(hazard) {
  const kind = HAZARD_LABEL[hazard.kind] ?? String(hazard.kind ?? 'HAZARD').toUpperCase();
  const blocked = hazard.approved === true || hazard.status === 'verified';
  const head = blocked ? `${kind} (BLOCKED)` : kind;
  // Second line names the edge that is actually closed. The marker sits at the
  // REPORT point, which is where the driver stood, not on the carriageway --
  // so without the edge id there is nothing on screen tying the pin to the
  // road it shut.
  return hazard.blocked_edge ? `${head}\nEDGE ${hazard.blocked_edge}` : head;
}

/** One segmented-control button in the basemap group. */
function BasemapButton({ label, active, disabled, onClick, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      title={title}
      className={`focus-ring glass-ctl px-3.5 font-mono text-[11px] uppercase tracking-term
                  disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? 'bg-inset text-phosphor shadow-[inset_0_0_0_1px_rgb(var(--border-active))]'
          : 'text-muted hover:bg-inset/50 hover:text-dim'}`}
    >
      {label}
    </button>
  );
}

export default function CommandMap() {
  // --- basemap ------------------------------------------------------------
  const basemap = useCommandStore((s) => s.ui.basemap);
  const basemapDim = useCommandStore((s) => s.ui.basemapDim);
  const setUi = useCommandStore((s) => s.setUi);
  const [bhuvanDown, setBhuvanDown] = useState(false);
  // Bhuvan is not mounted until the probe clears it. Mounting first and
  // falling back on failure also works, but it costs a visible black flash
  // and a burst of ~14 CORS failures in the console before the flip -- noise
  // that buries any real error a dispatcher or a developer needs to see. The
  // dark basemap renders during the probe, so nothing is blank while waiting.
  const [bhuvanReady, setBhuvanReady] = useState(false);

  // The probe asks the narrow question that actually matters: not "is Bhuvan
  // up" but "can MapLibre read it from this origin". See lib/bhuvan.js --
  // bhuvan-vec1 currently serves valid tiles with no CORS header, which is
  // exactly the case that renders a black map if you only check reachability.
  useEffect(() => {
    let alive = true;
    probeBhuvan().then(({ usable, reason }) => {
      if (!alive) return;
      if (usable) { setBhuvanReady(true); return; }
      setBhuvanDown(true);
      useCommandStore.getState().pushAlert({
        tone: 'warn',
        title: 'Bhuvan basemap unavailable',
        body: `${reason} — falling back to the offline dark basemap.`,
      });
    });
    return () => { alive = false; };
  }, []);

  const useBhuvan = basemap === 'bhuvan' && bhuvanReady && !bhuvanDown;
  const useTerrain = basemap === 'terrain';
  // Rebuilt only when the mode or the dim actually changes: handing
  // react-map-gl a new style object every render tears down and re-creates the
  // raster source, which flashes the whole basemap.
  const mapStyle = useMemo(() => {
    if (useBhuvan) return bhuvanStyle(basemapDim);
    // Terrain needs no probe: Esri's tile services send CORS headers, which is
    // exactly the property Bhuvan lacks.
    if (useTerrain) return terrainStyle(basemapDim);
    return FALLBACK_STYLE_URL;
  }, [useBhuvan, useTerrain, basemapDim]);

  // Only the two raster basemaps have anything to dim; the CARTO vector style
  // is already dark by construction.
  const dimmable = useBhuvan || useTerrain;

  const onMapError = useCallback((event) => {
    if (!useBhuvan) return;
    // The second net. Matched on the SOURCE, not on the error message: a
    // CORS-blocked fetch surfaces as an opaque "Failed to fetch" with no URL
    // and no status, so message-sniffing misses precisely the failure this
    // needs to catch. `sourceId` is set by MapLibre on tile errors and names
    // the source declared in bhuvanStyle().
    const sourceId = event?.sourceId ?? event?.source?.id;
    const url = event?.error?.url ?? '';
    if (sourceId === 'bhuvan' || url.includes('bhuvan-vec1')) setBhuvanDown(true);
  }, [useBhuvan]);

  // --- data ---------------------------------------------------------------
  const positions = positionStore((s) => s.positions);
  const trucks = useCommandStore((s) => s.trucks);
  const trails = useCommandStore((s) => s.trails);
  const darkZone = useCommandStore((s) => s.darkZone);
  const routes = useCommandStore((s) => s.routes);
  const hazards = useCommandStore((s) => s.hazards);
  const riskFeatures = useCommandStore((s) => s.risk.features);
  const selectTruck = useCommandStore((s) => s.selectTruck);
  const selectedTruckId = useCommandStore((s) => s.ui.selectedTruckId);

  const show = useCommandStore(
    (s) => ({
      trucks: s.ui.showTrucks,
      trails: s.ui.showTrails,
      routes: s.ui.showRoutes,
      hazards: s.ui.showHazards,
      risk: s.ui.showRisk,
    }),
    shallow,
  );

  // Trucks carrying their interpolated position. The raw record holds the last
  // REPORTED fix; `position` is where the marker has slid to between packets.
  const fleet = useMemo(
    () => Object.values(trucks).map((truck) => ({
      ...truck,
      position: positions[truck.truck_id] ?? [truck.lng, truck.lat],
    })),
    [trucks, positions],
  );

  // --- camera -------------------------------------------------------------
  // Controlled, so selecting a truck or a route can frame it. Task 1 is
  // explicit that the zoom must not be hard-locked, so every programmatic move
  // sets a view state the user can immediately drag or zoom away from -- there
  // is no clamp, no re-centring timer, and no snap-back.
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
  const deckRef = useRef(null);
  const framedRef = useRef(null);

  const frameBounds = useCallback((bounds, padding = 96) => {
    if (!bounds) return;
    const size = deckRef.current?.deck;
    const width = size?.width ?? window.innerWidth;
    const height = size?.height ?? window.innerHeight;
    const [minLng, minLat, maxLng, maxLat] = bounds;

    // A single point has no extent to fit; fitBounds would return Infinity
    // zoom. Frame it at a fixed street-level zoom instead.
    if (minLng === maxLng && minLat === maxLat) {
      setViewState((v) => ({
        ...v,
        longitude: minLng,
        latitude: minLat,
        zoom: Math.max(v.zoom, 13),
        transitionDuration: 700,
        transitionInterpolator: new FlyToInterpolator({ speed: 1.4 }),
      }));
      return;
    }

    try {
      const fitted = new WebMercatorViewport({ width, height })
        .fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding });
      setViewState((v) => ({
        ...v,
        longitude: fitted.longitude,
        latitude: fitted.latitude,
        zoom: Math.min(fitted.zoom, INITIAL_VIEW_STATE.maxZoom),
        transitionDuration: 700,
        transitionInterpolator: new FlyToInterpolator({ speed: 1.4 }),
      }));
    } catch {
      /* fitBounds throws on a degenerate viewport during the first layout
         pass; the next selection frames it correctly. */
    }
  }, []);

  // Frame a truck ONCE per selection. Re-framing on every telemetry packet
  // would drag the camera along behind a moving truck and make the map
  // impossible to pan while a truck is selected.
  useEffect(() => {
    if (!selectedTruckId) { framedRef.current = null; return; }
    if (framedRef.current === selectedTruckId) return;
    framedRef.current = selectedTruckId;

    const route = routes[selectedTruckId]?.geometry?.coordinates;
    const truck = trucks[selectedTruckId];
    // Prefer the whole route: a dispatcher selecting a truck wants to see
    // where it is going, not a rooftop.
    if (route?.length >= 2) frameBounds(boundsOf(route));
    else if (truck) frameBounds([truck.lng, truck.lat, truck.lng, truck.lat]);
  }, [selectedTruckId, routes, trucks, frameBounds]);

  // --- hazard pulse -------------------------------------------------------
  // A slow 2-second breath on the hazard glow. 5 Hz, not 60: this is an
  // ambient cue, and animating it per frame would cost a full layer rebuild
  // sixty times a second to move an alpha value nobody is watching that
  // closely. Disabled outright under prefers-reduced-motion.
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced || hazards.length === 0) { setPulse(0); return undefined; }
    const timer = setInterval(() => setPulse((Date.now() % 2000) / 2000), 200);
    return () => clearInterval(timer);
  }, [hazards.length]);

  // --- layers -------------------------------------------------------------
  const layers = useMemo(() => {
    const built = [];
    const dashed = new PathStyleExtension({ dash: true, highPrecisionDash: true });

    // 1. Predictive risk corridors (Task 3).
    if (show.risk && riskFeatures.length > 0) {
      built.push(new PathLayer({
        id: 'risk-corridors',
        data: riskFeatures,
        getPath: (f) => f.geometry.coordinates,
        getColor: (f) => riskColor(f.properties.risk_score),
        // Metres, so a corridor keeps its real width as the dispatcher zooms
        // out -- which is exactly the zoom at which this overlay is useful. A
        // pixel-width line would vanish at region scale.
        widthUnits: 'meters',
        getWidth: 70,
        widthMinPixels: 2,
        capRounded: true,
        jointRounded: true,
        pickable: true,
      }));
    }

    // 2. Planned / rerouted geometry (Tasks 1 and 4).
    if (show.routes) {
      const routeData = Object.entries(routes)
        .filter(([, route]) => route?.geometry?.coordinates?.length >= 2)
        .map(([truckId, route]) => ({ truckId, ...route }));

      if (routeData.length > 0) {
        // Casing underneath: a thin bright line over dark terrain reads as
        // noise without one.
        built.push(new PathLayer({
          id: 'routes-casing',
          data: routeData,
          getPath: (d) => d.geometry.coordinates,
          getColor: [...INK, 200],
          widthUnits: 'pixels',
          getWidth: 7,
          capRounded: true,
          jointRounded: true,
        }));
        built.push(new PathLayer({
          id: 'routes',
          data: routeData,
          getPath: (d) => d.geometry.coordinates,
          getColor: (d) => (d.truckId === selectedTruckId ? [...ROUTE, 255] : [...ROUTE, 130]),
          widthUnits: 'pixels',
          getWidth: (d) => (d.truckId === selectedTruckId ? 3.5 : 2),
          capRounded: true,
          jointRounded: true,
          pickable: true,
          updateTriggers: { getColor: selectedTruckId, getWidth: selectedTruckId },
        }));
      }
    }

    // 3. Burst-synced dark-zone path (Task 2) -- dashed, because it is history
    //    painted in after the fact rather than movement being watched.
    const darkData = Object.entries(darkZone)
      .filter(([, d]) => d.segments?.length >= 2)
      .map(([truckId, d]) => ({ truckId, path: d.segments }));

    if (show.trails && darkData.length > 0) {
      built.push(new PathLayer({
        id: 'dark-zone-path',
        data: darkData,
        getPath: (d) => d.path,
        getColor: [...CYAN, 210],
        widthUnits: 'pixels',
        getWidth: 2.5,
        getDashArray: [6, 4],
        dashJustified: true,
        extensions: [dashed],
        capRounded: true,
        pickable: true,
      }));
    }

    // 4. Live trail, split so dead-reckoned runs are visibly estimates.
    if (show.trails) {
      const runs = [];
      for (const [truckId, trail] of Object.entries(trails)) {
        for (const run of splitTrailBySource(trail)) runs.push({ truckId, ...run });
      }
      if (runs.length > 0) {
        built.push(new PathLayer({
          id: 'trails',
          data: runs,
          getPath: (d) => d.path,
          getColor: (d) => (d.source === 'ekf' ? [...AMBER, 190] : [...CYAN, 120]),
          widthUnits: 'pixels',
          getWidth: 2,
          // Only the dead-reckoned runs are dashed. A solid amber line would
          // claim the same certainty as a GNSS fix in a different colour.
          getDashArray: (d) => (d.source === 'ekf' ? [5, 4] : [0, 0]),
          dashJustified: true,
          extensions: [dashed],
          capRounded: true,
        }));
      }
    }

    if (show.trucks) {
      // 5. Uncertainty halo, under the marker. A dead-reckoned truck carries a
      //    covariance for exactly this reason: the dispatcher must see that a
      //    position during a blackout is an estimate, not a fix.
      built.push(new ScatterplotLayer({
        id: 'truck-uncertainty',
        data: fleet.filter((t) => t.source === 'ekf' && t.covariance_m2 > 0),
        getPosition: (d) => d.position,
        // sqrt(covariance) is one standard deviation, in metres.
        getRadius: (d) => Math.sqrt(d.covariance_m2),
        radiusUnits: 'meters',
        getFillColor: [...AMBER, 38],
        stroked: true,
        getLineColor: [...AMBER, 120],
        lineWidthMinPixels: 1,
        radiusMinPixels: 5,
        updateTriggers: { getPosition: positions },
      }));

      // 6. Selection ring.
      if (selectedTruckId && positions[selectedTruckId]) {
        built.push(new ScatterplotLayer({
          id: 'truck-selection',
          data: [{ position: positions[selectedTruckId] }],
          getPosition: (d) => d.position,
          radiusUnits: 'pixels',
          getRadius: 17,
          filled: false,
          stroked: true,
          getLineColor: [234, 234, 234, 220],
          lineWidthMinPixels: 1.5,
          updateTriggers: { getPosition: positions },
        }));
      }

      // 7. The fleet. Cyan for a live GNSS fix, amber for dead reckoning --
      //    that distinction is the whole product.
      built.push(new IconLayer({
        id: 'trucks',
        data: fleet,
        getPosition: (d) => d.position,
        getIcon: () => TRUCK_ICON,
        getSize: (d) => (d.truck_id === selectedTruckId ? 34 : 28),
        sizeUnits: 'pixels',
        // Heading is only populated on the dead-reckoning path today, so the
        // icon points north when the wire has nothing to point it by, rather
        // than spinning on GNSS noise.
        getAngle: (d) => (Number.isFinite(d.heading_deg) ? -d.heading_deg : 0),
        getColor: (d) => (d.source === 'ekf' ? AMBER : CYAN),
        pickable: true,
        onClick: (info) => selectTruck(info.object?.truck_id ?? null),
        // deck.gl memoises accessors by data reference. Without these the
        // markers would only redraw when the array identity changed -- once a
        // second -- undoing the interpolation entirely.
        updateTriggers: {
          getPosition: positions,
          getColor: fleet,
          getSize: selectedTruckId,
          getAngle: fleet,
        },
      }));
    }

    // 8. Hazards (Task 3): glow, node, then label above everything.
    if (show.hazards && hazards.length > 0) {
      const data = hazards.filter((h) => Number.isFinite(Number(h.lat)) && Number.isFinite(Number(h.lng)))
        .map((h) => ({ ...h, position: [Number(h.lng), Number(h.lat)] }));

      // Leader lines: report point -> the nearest road geometry we hold.
      //
      // This exists to answer "why is the landslide off the road". It IS off
      // the road: the incident's stored geometry is where the driver was
      // standing, while the edge it closed was chosen separately by a PostGIS
      // ST_ClosestPoint snap that is never sent to this client. Drawing the
      // connector makes the pin and the closed road read as one object instead
      // of two unrelated marks.
      //
      // Candidate geometry is whatever is already loaded -- planned routes and
      // any scored risk corridors. When neither is on screen there is nothing
      // to snap to and no leader is drawn, which is honest: the exact snapped
      // point is a backend value this dashboard has never been given.
      const roadGeometry = [
        ...Object.values(routes).map((r) => r?.geometry?.coordinates).filter(Boolean),
        ...(show.risk ? riskFeatures.map((f) => f.geometry?.coordinates).filter(Boolean) : []),
      ];

      if (roadGeometry.length > 0) {
        const leaders = data
          .map((hazard) => {
            const hit = closestVertexAcross(roadGeometry, hazard.position);
            return hit ? { path: [hazard.position, hit.vertex], distanceM: hit.distanceM } : null;
          })
          .filter(Boolean);

        if (leaders.length > 0) {
          built.push(new PathLayer({
            id: 'hazard-leader',
            data: leaders,
            getPath: (d) => d.path,
            getColor: [...HAZARD, 130],
            widthUnits: 'pixels',
            getWidth: 1.5,
            getDashArray: [3, 3],
            dashJustified: true,
            extensions: [dashed],
          }));
        }
      }

      built.push(new ScatterplotLayer({
        id: 'hazard-glow',
        data,
        getPosition: (d) => d.position,
        radiusUnits: 'pixels',
        getRadius: 22 + pulse * 8,
        getFillColor: [...HAZARD, Math.round(45 - pulse * 20)],
        updateTriggers: { getRadius: pulse, getFillColor: pulse },
      }));

      built.push(new ScatterplotLayer({
        id: 'hazard-node',
        data,
        getPosition: (d) => d.position,
        radiusUnits: 'pixels',
        getRadius: 8,
        getFillColor: [...HAZARD, 235],
        stroked: true,
        getLineColor: [...INK, 255],
        lineWidthMinPixels: 2,
        pickable: true,
      }));

      built.push(new TextLayer({
        id: 'hazard-labels',
        data,
        getPosition: (d) => d.position,
        getText: hazardText,
        getSize: 11,
        sizeUnits: 'pixels',
        getColor: [...HAZARD, 255],
        // Above the node, so the label never sits on the thing it names.
        getPixelOffset: [0, -24],
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontWeight: 700,
        characterSet: 'auto',
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'bottom',
        // The label has to stay readable over both a bright Bhuvan tile and
        // black terrain; an outline is the only treatment that works on both.
        outlineWidth: 3,
        outlineColor: [...INK, 255],
        fontSettings: { sdf: true, radius: 12 },
      }));
    }

    return built;
  }, [
    show, riskFeatures, routes, darkZone, trails, fleet, positions,
    hazards, pulse, selectedTruckId, selectTruck,
  ]);

  // --- tooltip ------------------------------------------------------------
  const getTooltip = useCallback(({ object }) => {
    if (!object) return null;

    if (object.properties?.risk_score !== undefined) {
      return {
        text: `${object.properties.name ?? 'unnamed road'}\n`
          + `${object.properties.highway ?? ''}\n`
          + `risk ${(object.properties.risk_score * 100).toFixed(1)}%`,
      };
    }
    if (object.kind && object.id) {
      return {
        text: `${hazardText(object)}\n`
          + `incident ${String(object.id).slice(0, 8)}\n`
          // Stated explicitly: the pin is the driver's position when they
          // reported, not the point on the carriageway that was closed.
          + 'pin = report location, not the snapped road point',
      };
    }
    if (object.truck_id) {
      return {
        text: `${object.truck_id.slice(0, 8)}\n`
          + `${object.source === 'ekf' ? 'DEAD RECKONING' : 'GNSS FIX'}\n`
          + `${(object.speed ?? 0).toFixed(1)} m/s`
          + (object.covariance_m2 ? `\n±${Math.sqrt(object.covariance_m2).toFixed(0)} m` : ''),
      };
    }
    return null;
  }, []);

  return (
    <div className="absolute inset-0">
      <DeckGL
        ref={deckRef}
        viewState={viewState}
        onViewStateChange={({ viewState: next }) => setViewState(next)}
        // dragRotate off: a rotated command map costs orientation for a
        // degree of freedom a dispatcher never asked for. Zoom stays free.
        controller={{ dragRotate: false, touchRotate: false }}
        layers={layers}
        getTooltip={getTooltip}
        getCursor={({ isHovering, isDragging }) => {
          if (isDragging) return 'grabbing';
          return isHovering ? 'pointer' : 'grab';
        }}
        // Clicking empty map clears the selection, which is the escape route
        // from the telemetry panel for a mouse user.
        onClick={(info) => { if (!info.object) selectTruck(null); }}
      >
        <Map reuseMaps mapStyle={mapStyle} onError={onMapError} attributionControl={{ compact: true }} />
      </DeckGL>

      {/* Basemap provenance and the dim control.
          A dispatcher must be able to tell at a glance which ground they are
          reading -- sovereign ISRO cartography, shaded relief, or the plain
          dark vector fallback -- because all three disagree about NER road
          detail, and only one of them shows the slope that decides whether a
          landslide report is plausible. */}
      <div
        role="group"
        aria-label="Basemap"
        className="glass pointer-events-auto absolute bottom-3 left-3 flex items-center gap-1 p-1"
      >
        <BasemapButton
          label="Bhuvan"
          active={useBhuvan}
          disabled={bhuvanDown || !bhuvanReady}
          // Each basemap carries its own sensible starting dim, because they
          // are not equally bright: hillshade is a near-white image and needs
          // far more scrim than Bhuvan's cartography to sit behind the data.
          // Carrying one shared value across the switch made every change of
          // basemap also a change of legibility.
          onClick={() => setUi({ basemap: 'bhuvan', basemapDim: 0.55 })}
          title={bhuvanDown
            ? 'Bhuvan tiles cannot be read from this origin (no CORS header)'
            : bhuvanReady ? 'ISRO / NRSC Bhuvan — sovereign basemap' : 'Checking Bhuvan availability…'}
        />
        <BasemapButton
          label="Terrain"
          active={useTerrain}
          onClick={() => setUi({ basemap: 'terrain', basemapDim: 0.72 })}
          title="Shaded relief over terrain base (Esri) — elevation and slope context"
        />
        <BasemapButton
          label="Dark"
          active={!useBhuvan && !useTerrain}
          onClick={() => setUi({ basemap: 'dark' })}
          title="CARTO dark matter — offline-safe vector fallback"
        />

        {dimmable && (
          <label className="ml-1 flex items-center gap-2 px-2">
            <span className="meta">Dim</span>
            <input
              type="range"
              min="0" max="0.9" step="0.05"
              value={basemapDim}
              onChange={(event) => setUi({ basemapDim: Number(event.target.value) })}
              aria-label="Basemap dim"
              className="focus-ring h-1.5 w-24 cursor-pointer accent-[rgb(34,211,238)]"
            />
          </label>
        )}
        {bhuvanDown && (
          <span
            className="px-2 font-mono text-[10px] text-warn"
            title="Bhuvan serves tiles but blocks cross-origin reads"
          >
            Bhuvan offline
          </span>
        )}
      </div>
    </div>
  );
}
