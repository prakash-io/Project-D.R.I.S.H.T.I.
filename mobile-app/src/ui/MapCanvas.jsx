// Full-screen map base layer (Workflow 1/2, Epic 4 UI).
//
// MapLibre, not react-native-maps: the Google provider needs an API key and
// streams its tiles, so it renders a grey rectangle in exactly the dark zones
// this app exists for. MapLibre lets us point at a raster WMTS and pre-cache
// the corridor ahead of the truck.
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, AccessibilityInfo } from 'react-native';
import * as MapLibreRN from '@maplibre/maplibre-react-native';
import VehicleMarker, { VehicleMarkerFallback } from './VehicleMarker';
import ErrorBoundary from './ErrorBoundary';
import { t } from './tokens';

// Two stacked rasters. Bhuvan is drawn ON TOP of OSM because later layers win
// in MapLibre -- so wherever Bhuvan serves a tile the driver sees Bhuvan, and
// wherever it does not, OSM shows through the hole instead of a blank square.
//
// The gaps are real and were measured, not assumed: tile 15/24187/14495 over
// Bhubaneswar returns HTTP 400 while its immediate neighbour 15/24188/14496
// returns 200. The cache is missing individual tiles and answers 400 rather
// than serving an empty PNG.
//
// Bhuvan stops at maxzoom 18 and OSM continues to 19, so the deepest zoom
// falls back to OSM entirely rather than showing nothing.
const STYLE = {
  version: 8,
  // REQUIRED by the hazard SymbolLayer. A textField with no glyph source
  // renders nothing at all and logs nothing -- the labels simply never
  // appear. Note the stack is "Noto Sans Regular": this endpoint 404s on
  // "Open Sans Regular", which is the spelling most examples use.
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {
    'osm-fallback': {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap',
    },
    'bhuvan-basemap': {
      type: 'raster',
      tiles: ['https://bhuvan-vec1.nrsc.gov.in/bhuvan/gwc/service/wmts/?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=india3&STYLE=default&TILEMATRIXSET=EPSG:900913&TILEMATRIX=EPSG:900913:{z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png'],
      tileSize: 256,
      // SOURCE maxzoom, which is a different job from the layer's. The layer
      // maxzoom below stops Bhuvan being DRAWN past z14; this stops it being
      // REQUESTED. Without it MapLibre still asked for z15 and the WMTS
      // endpoint answered HTTP 400 (its EPSG:900913 matrix set has no z15 for
      // india3), which logged as a tile error on every pan at street zoom
      // even though nothing was missing from the picture.
      maxzoom: 14,
      attribution: '© ISRO / NRSC Bhuvan',
    },
  },
  layers: [
    { id: 'osm-layer', type: 'raster', source: 'osm-fallback', minzoom: 0, maxzoom: 19 },
    // Bhuvan hands off to OSM at z15. It is drawn on top only where it is
    // actually the better map, which is the regional view -- measured over
    // Guwahati/Shillong, unique colours per 256px tile:
    //
    //     z12  bhuvan 857-1882   osm 229-256   <- bhuvan much richer
    //     z14  bhuvan 109-336    osm 102-256   <- comparable
    //     z15  bhuvan 223-254 / HTTP 400       <- degrading, holes appear
    //     z17  bhuvan  79 (3.6 KB)  osm 186    <- effectively blank
    //
    // Above z14 the india3 tiles thin out to near-empty fills and start
    // returning 400 along the corridor, while OSM keeps the street geometry
    // and labels a driver navigates by. Since every Bhuvan tile is 100%
    // OPAQUE (checked: no alpha anywhere), leaving it on top past z14 does
    // not blend with OSM -- it hides it, which is what made the map read as
    // bare at driving zoom.
    //
    // The crossover is 14 and not 15 because z14 is THE working zoom: it is
    // both the default camera zoom for a truck with a fix (below) and the
    // deepest zoom the offline pack stores, so it is what the driver sees in
    // a dark zone. At z14 the two are comparable on colour count, but colour
    // count only measures "not blank" -- OSM is the one carrying road names
    // and casings, which is what navigation actually reads.
    //
    // maxzoom is exclusive in the style spec: this layer draws at z<14 and is
    // hidden at z>=14, so OSM alone carries the navigation zooms.
    { id: 'bhuvan-layer', type: 'raster', source: 'bhuvan-basemap', minzoom: 0, maxzoom: 14 },
  ],
};

/// Both rasters take the night treatment. Dimming only Bhuvan would let OSM
/// blaze through every gap after dark, which is the exact glare this guards
/// against.
const NIGHT_LAYERS = new Set(['osm-layer', 'bhuvan-layer']);

/**
 * Night treatment for the raster.
 *
 * Bhuvan's india3 layer is a bright, near-white basemap. Full-screen in a
 * dark cab it is a headlight pointed at the driver, and it destroys the dark
 * adaptation they need for the road. Dimming and desaturating the tiles keeps
 * the terrain readable while letting the HUD and the truck marker stay the
 * brightest things on the glass -- which is the correct visual hierarchy at
 * night, because those are the only elements that change.
 */
// NOTE: these live in a raw style-JSON `paint` block, so they must use the
// MapLibre STYLE SPEC names (kebab-case). The camelCase spellings
// (rasterBrightnessMax etc.) are the <RasterLayer style={...}> component
// props -- putting those here is silently invalid and blanks the layer.
const NIGHT_RASTER = {
  'raster-brightness-max': 0.45,
  'raster-saturation': -0.45,
  'raster-contrast': 0.1,
};
/// Daytime is treated too, not left raw. The HUD is a dark terminal surface;
/// a near-white basemap under it puts two opposing substrates on one screen,
/// which is what made the readouts fight the map for attention. Muting the
/// raster keeps ONE substrate and makes the truck, the route and the alerts
/// the brightest things on the glass -- they are the only parts that change.
// Daytime is left as-drawn: the approved design is a light interface over a
// light basemap, and dimming it would put the app back where it started.
//
// Night is NOT left as-drawn. A near-white basemap full-screen in a dark cab
// destroys the dark adaptation a driver needs for the road, so the raster is
// still dimmed after dusk. That is a safety behaviour, not a style choice --
// set DIM_AT_NIGHT to false to disable it.
const DAY_RASTER = {};
const DIM_AT_NIGHT = true;

/// 18:00-06:00 local. Deliberately clock-based rather than a manual toggle:
/// a driver on a mountain road should not have to find a setting at dusk.
function isNight(now = new Date()) {
  const h = now.getHours();
  return h >= 18 || h < 6;
}

/// Half-width of the pre-cached box, in degrees (~11 km).
const CACHE_HALF_SPAN = 0.1;

export default function MapCanvas({
  fix, route, proposedRoute, hazards, forecast, zoom, follow, followKey,
  originName, destinationName, onUserPan, apiUrl, children,
}) {
  const [cacheState, setCacheState] = useState('idle');
  const [night, setNight] = useState(() => isNight());
  const [reduceMotion, setReduceMotion] = useState(false);
  const packStarted = useRef(false);

  // Re-evaluate on a slow timer so a long haul crosses into night without a
  // restart. One minute is far below the cost of a re-render here and far
  // above anything that could feel like flicker.
  useEffect(() => {
    const id = setInterval(() => setNight(isNight()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Camera easing is motion the driver did not ask for. Honour the system
  // setting rather than assuming a moving map is always wanted.
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => { if (alive) setReduceMotion(on); })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { alive = false; sub?.remove?.(); };
  }, []);

  const centre = fix
    ? [fix.longitude, fix.latitude]
    // Centre of India until the first fix arrives, so the map is never blank.
    : [78.9629, 22.5937];

  // Pre-cache the corridor around the first real fix. Fire-and-forget: the map
  // is fully usable without it, and a failed pack must never block the screen
  // the driver navigates by.
  useEffect(() => {
    if (!fix || packStarted.current) return;
    packStarted.current = true;

    (async () => {
      try {
        // The offline pack needs a style URI rather than an inline object, and
        // it has to be an http(s) one -- see GET /tiles/style.json in
        // backend/src/routes/tiles.js for why a local file cannot work here.
        // Short version: the offline downloader puts the style through
        // OnlineFileSource, which on Android is OkHttp, and HttpUrl.parse()
        // returns null for any scheme that is not http(s). Writing the style
        // to app storage and passing `file://` logged "[HTTP] Unable to parse
        // resourceUrl" once per attempt and never built a pack.
        //
        // No backend address means no pack. That is a degraded map, not a
        // broken one: the live style is the inline object below, so the screen
        // the driver navigates by is unaffected.
        if (!apiUrl) {
          console.warn('[map] no apiUrl; skipping offline corridor pack');
          setCacheState('failed');
          return;
        }
        const styleURL = `${apiUrl.replace(/\/+$/, '')}/tiles/style.json`;

        // VERSIONED. createPack bakes the style into the pack, and the
        // getPack short-circuit below means an existing pack is never
        // refreshed -- so a handset that cached the old style would keep
        // rendering Bhuvan over OSM at z14 no matter what STYLE now says.
        // Bump this suffix whenever STYLE changes so the old pack is bypassed.
        const name = 'drishti-corridor-v3';
        // Reclaim the packs cut loose by earlier version bumps. A handset
        // flashed before a STYLE change still has the old corridor on disk and
        // nothing else will ever ask for it again.
        //
        // v2 is on this list for a second reason. While the styleURL was a
        // `file://` one the style fetch always failed, but createPack had
        // already registered the region -- so a handset that ran that build is
        // holding a v2 pack with no tiles in it. getPack() below only asks
        // whether a pack EXISTS, so finding that empty region would report the
        // corridor "ready" and leave the driver with a blank map in the dark
        // zone, which is the exact failure the cache is meant to prevent.
        for (const dead of ['drishti-corridor', 'drishti-corridor-v2']) {
          await MapLibreRN.offlineManager.deletePack(dead).catch(() => {});
        }

        const existing = await MapLibreRN.offlineManager.getPack(name).catch(() => null);
        if (existing) { setCacheState('ready'); return; }

        setCacheState('caching');
        await MapLibreRN.offlineManager.createPack(
          {
            name,
            styleURL,
            bounds: [
              [fix.longitude - CACHE_HALF_SPAN, fix.latitude - CACHE_HALF_SPAN],
              [fix.longitude + CACHE_HALF_SPAN, fix.latitude + CACHE_HALF_SPAN],
            ],
            minZoom: 8,
            maxZoom: 14,
          },
          (_pack, status) => {
            if (status?.percentage >= 100) setCacheState('ready');
          },
          (_pack, error) => {
            console.warn('[map] offline pack failed:', error?.message ?? error);
            setCacheState('failed');
          },
        );
      } catch (error) {
        console.warn('[map] offline cache unavailable:', error?.message ?? error);
        setCacheState('failed');
      }
    })();
  }, [fix, apiUrl]);

  // Bounding box of the whole route, so the camera can frame it instead of
  // sitting on top of the truck. Computed as [minLng, minLat, maxLng, maxLat]
  // and then handed over in the shape MapLibre's Camera actually accepts --
  // { ne, sw } with per-edge padding, NOT a flat array.
  const routeBounds = React.useMemo(() => {
    if (!Array.isArray(route) || route.length < 2) return null;
    let minLng = Infinity; let minLat = Infinity;
    let maxLng = -Infinity; let maxLat = -Infinity;
    for (const [lng, lat] of route) {
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      if (lng < minLng) minLng = lng;
      if (lat < minLat) minLat = lat;
      if (lng > maxLng) maxLng = lng;
      if (lat > maxLat) maxLat = lat;
    }
    if (!Number.isFinite(minLng) || !Number.isFinite(minLat)) return null;
    return {
      ne: [maxLng, maxLat],
      sw: [minLng, minLat],
      // Both edges are deep, because both edges are covered.
      //
      // Top clears the Source/Destination card, which is roughly 195 pt: 12 pt
      // of inset, 24 pt of card padding, two 44 pt fields, the 14 pt connector
      // and the 48 pt directions button. It was 50 pt while the top of the map
      // held only the speed card, and leaving it there after the planner moved
      // up would frame a route with its first quarter behind the form -- with
      // the origin marker, the one end the driver is looking for, hidden first.
      //
      // Bottom clears the speed pill, the ETA band, the source toggle and the
      // hazard button, which all stack over the lower third.
      paddingTop: 210, paddingRight: 50, paddingBottom: 200, paddingLeft: 50,
    };
  }, [route]);

  // ------------------------------------------------------------- camera
  //
  // Driven through the ref, NOT through declarative props. The declarative
  // form (`centerCoordinate` + `zoomLevel` spread onto <Camera>) is the
  // obvious one and it did not work here: the component memoises its native
  // stop, and the version that also had to switch between a centre and a
  // `bounds` never re-issued the follow stop at all -- on the handset the map
  // sat frozen at the route framing while the truck drove out of view, and
  // the zoom buttons did nothing either. `setCamera` is the documented
  // imperative API and applies every time it is called.
  //
  // Two mutually exclusive jobs, deliberately split into two effects:
  const cameraRef = useRef(null);

  // 1. FOLLOWING. Track the fix. `followKey` is bumped by the recentre button
  //    so the driver can re-issue this even when nothing else changed.
  useEffect(() => {
    if (!follow || !fix) return;
    cameraRef.current?.setCamera({
      centerCoordinate: [fix.longitude, fix.latitude],
      zoomLevel: zoom ?? 14,
      animationDuration: reduceMotion ? 0 : 600,
      animationMode: reduceMotion ? 'moveTo' : 'easeTo',
    });
  }, [follow, fix?.longitude, fix?.latitude, zoom, followKey, reduceMotion]);

  // 2. FRAMING A NEW ROUTE. Once per route, and only while not following --
  //    keyed on the bounds object, which useMemo only rebuilds when `route`
  //    changes identity. This is what shows the driver the whole corridor
  //    after switching to it; re-running it on every fix would fight effect 1
  //    for the camera and make the map jitter between two framings.
  useEffect(() => {
    if (follow || !routeBounds) return;
    cameraRef.current?.setCamera({
      bounds: routeBounds,
      animationDuration: reduceMotion ? 0 : 600,
      animationMode: reduceMotion ? 'moveTo' : 'easeTo',
    });
  }, [routeBounds, follow, reduceMotion]);

  // 3. ZOOM WHILE FREE. Effect 1 carries the zoom while following, so once
  //    the driver pans away it never runs again and the +/- buttons go dead
  //    at exactly the moment the map is theirs to explore. Issuing zoomLevel
  //    on its own leaves the centre where the driver put it.
  //
  //    Keyed on an actual CHANGE in `zoom`, not on the dependency list firing:
  //    `follow` is a dependency (the effect must know which mode it is in) but
  //    a follow flip must not re-issue a camera stop, or the pinch-zoom that
  //    just broke follow would be snapped back to the button state.
  const lastZoom = useRef(zoom);
  useEffect(() => {
    if (lastZoom.current === zoom) return;
    lastZoom.current = zoom;
    if (follow) return;
    cameraRef.current?.setCamera({
      zoomLevel: zoom,
      animationDuration: reduceMotion ? 0 : 220,
      animationMode: reduceMotion ? 'moveTo' : 'easeTo',
    });
  }, [zoom, follow, reduceMotion]);

  // ------------------------------------------------- gesture breaks follow
  //
  // Without this the decouple is only half-built. The camera stops being
  // re-issued only once `follow` is ALREADY false, so a driver who drags
  // while following is yanked back by the very next fix -- at 1 Hz, which
  // does not read as "the map snapped back", it reads as a map that cannot
  // be moved at all. That is the reported symptom.
  //
  // onRegionWillChange fires once at the START of a camera change, unlike
  // onRegionIsChanging which fires per frame. `isUserInteraction` is what
  // separates the driver's finger from our own setCamera stops: those raise
  // the same event with the flag false, so following does not cancel itself
  // on its own animation.
  const handleRegionWillChange = React.useCallback((event) => {
    if (event?.properties?.isUserInteraction) onUserPan?.();
  }, [onUserPan]);

  const routeLine = route && route.length >= 2
    ? { type: 'Feature', geometry: { type: 'LineString', coordinates: route } }
    : null;

  /**
   * The two ends of the route, as a FeatureCollection.
   *
   * Taken from the GEOMETRY -- route[0] and route[n-1] -- not from the origin
   * and destination the driver picked in the planner. Those two are the same
   * place only in the happy case: pgr_astar starts from the nearest routable
   * NODE, which on a corridor whose endpoint is a town centre can be several
   * hundred metres off the pin, and an accepted detour rewrites the line
   * without touching the planner fields at all. A marker drawn from the
   * picked place would then float beside the line it claims to terminate,
   * which is the specific lie this app cannot afford: the driver has to be
   * able to trust that the blue line is the road and the pins are its ends.
   *
   * The names still come from the planner, because a coordinate has no name.
   * They are labels ON the geometry, never the source of its position.
   */
  const routeEnds = React.useMemo(() => {
    if (!Array.isArray(route) || route.length < 2) return null;
    const first = route[0];
    const last = route[route.length - 1];
    const usable = (c) => Array.isArray(c)
      && Number.isFinite(c[0]) && Number.isFinite(c[1]);
    if (!usable(first) || !usable(last)) return null;
    return {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          // `end` drives every paint expression below, so one source can carry
          // both markers and MapLibre still draws them in two colours.
          properties: { end: 'start', label: originName ?? '' },
          geometry: { type: 'Point', coordinates: first },
        },
        {
          type: 'Feature',
          properties: { end: 'finish', label: destinationName ?? '' },
          geometry: { type: 'Point', coordinates: last },
        },
      ],
    };
  }, [route, originName, destinationName]);

  // The detour the driver has been OFFERED but has not accepted. Drawn beside
  // the current route, never instead of it: replacing the line at the moment
  // the payload arrives is exactly the behaviour the accept step exists to
  // prevent, and a driver watching the road they are on disappear from the map
  // has no way to tell a proposal from an instruction.
  const proposedLine = proposedRoute && proposedRoute.length >= 2
    ? { type: 'Feature', geometry: { type: 'LineString', coordinates: proposedRoute } }
    : null;

  return (
    <View style={styles.fill}>
      <MapLibreRN.MapView
        style={styles.fill}
        mapStyle={{
          ...STYLE,
          layers: STYLE.layers.map((layer) =>
            NIGHT_LAYERS.has(layer.id)
              ? { ...layer, paint: (night && DIM_AT_NIGHT) ? NIGHT_RASTER : DAY_RASTER }
              : layer),
        }}
        logoEnabled={false}
        // Bhuvan/NRSC attribution is a licence condition of the tile source.
        attributionEnabled
        onRegionWillChange={handleRegionWillChange}
      >
        {/*
          The camera is only DRIVEN while following. Previously
          centerCoordinate + zoomLevel were passed on every render, so each
          EKF/GNSS fix re-issued the camera and yanked the viewport back --
          the user could not pan or zoom out to see the route.

          Not following  -> no centerCoordinate is passed at all, so the map is
                            free. If a route exists it is framed once via
                            bounds.
          Following      -> the truck is tracked, as before.

          followUserLocation is left off deliberately: the position shown is
          the EKF's, which during a blackout is NOT the OS location the
          built-in follow mode would track.
        */}
        <MapLibreRN.Camera
          ref={cameraRef}
          defaultSettings={{ centerCoordinate: centre, zoomLevel: fix ? 14 : 4 }}
          followUserLocation={false}
        />

        {/* Drawn FIRST so the route the truck is actually on paints over it
            wherever the two share a road. The proposal is the alternative,
            not the plan. */}
        {proposedLine ? (
          <MapLibreRN.ShapeSource id="proposed-route" shape={proposedLine}>
            <MapLibreRN.LineLayer
              id="proposed-route-line"
              style={{
                // Dashed and desaturated: every navigator draws the road you
                // are not on this way, so it needs no legend.
                lineColor: t.color.textMuted,
                lineWidth: 6,
                lineCap: 'round',
                lineJoin: 'round',
                lineOpacity: 0.75,
                lineDasharray: [1.6, 1.2],
              }}
            />
          </MapLibreRN.ShapeSource>
        ) : null}

        {/* The route, drawn the way every navigator draws it: a wide dark
            casing with a lighter blue laid over it. Two layers on ONE source,
            so the casing can never drift out of register with the line.

            The casing is not decoration. At z14 -- the working zoom, and the
            deepest the offline pack stores -- OSM's own motorway casings are
            themselves broad and light, and a single flat stroke laid over
            them reads as one more road rather than as the route. The dark
            edge is what separates it, and it is also what keeps the line
            legible over the dimmed night raster.

            Opaque, not 0.85. The line was translucent so the road underneath
            showed through, which is exactly backwards: the driver needs to
            know which road they are on, not what is beneath it. */}
        {routeLine ? (
          <MapLibreRN.ShapeSource id="route" shape={routeLine}>
            <MapLibreRN.LineLayer
              id="route-casing"
              style={{
                lineColor: t.color.routeCasing,
                lineWidth: 11,
                lineCap: 'round',
                lineJoin: 'round',
              }}
            />
            <MapLibreRN.LineLayer
              id="route-line"
              style={{
                lineColor: t.color.routeLine,
                lineWidth: 7,
                lineCap: 'round',
                lineJoin: 'round',
              }}
            />
          </MapLibreRN.ShapeSource>
        ) : null}

        {/* Start and end. Pure GL circles rather than a SymbolLayer with a
            pin sprite: an icon image has to be registered with the map before
            it can be referenced, a missing one renders NOTHING and logs
            nothing, and this app has never been on a handset -- so the
            failure would be silent and the driver would simply have no idea
            where the route ends. Circles cannot fail that way.

            Drawn above the line so neither end is buried under the stroke
            that terminates there, and below the hazards and the truck, which
            outrank them. */}
        {routeEnds ? (
          <MapLibreRN.ShapeSource id="route-ends" shape={routeEnds}>
            {/* The white collar. Google draws one for the same reason: over a
                dark basemap a bare coloured dot has nothing to sit against. */}
            <MapLibreRN.CircleLayer
              id="route-end-halo"
              style={{
                circleRadius: 10,
                circleColor: '#FFFFFF',
                circleStrokeWidth: 1,
                circleStrokeColor: 'rgba(17, 20, 24, 0.28)',
              }}
            />
            <MapLibreRN.CircleLayer
              id="route-end-dot"
              style={{
                // Green ring for the origin, solid red for the destination --
                // the start is a place you have left, the end is the one that
                // matters. The ring/fill difference means the two are still
                // distinguishable in greyscale and to a colour-blind driver,
                // so hue is never the only channel.
                circleRadius: ['case', ['==', ['get', 'end'], 'start'], 5, 7],
                circleColor: ['case',
                  ['==', ['get', 'end'], 'start'], t.color.routeStart, t.color.routeEnd],
                circleStrokeWidth: ['case', ['==', ['get', 'end'], 'start'], 3, 0],
                circleStrokeColor: '#FFFFFF',
              }}
            />
            {/* Labelled only when the planner knows the names. `label` is ''
                for a route that arrived as bare geometry, and MapLibre draws
                nothing for an empty textField -- so this degrades to two
                unlabelled dots rather than to two dots captioned "undefined".
                Same glyph stack as the hazard labels: this endpoint 404s on
                "Open Sans Regular", which is the spelling most examples use. */}
            <MapLibreRN.SymbolLayer
              id="route-end-label"
              style={{
                textField: ['get', 'label'],
                textFont: ['Noto Sans Regular'],
                textSize: 12,
                textColor: t.color.textPrimary,
                textHaloColor: '#FFFFFF',
                textHaloWidth: 1.8,
                textOffset: [0, -1.4],
                textAnchor: 'bottom',
                // A name may be dropped when it would collide; the DOT it
                // belongs to never is. Losing a label costs a word, losing
                // the marker costs the driver the end of their route.
                textAllowOverlap: false,
                textOptional: true,
              }}
            />
          </MapLibreRN.ShapeSource>
        ) : null}

        {/*
          Predicted hazard nodes (workflow section 5), drawn to match the
          dispatcher's dashboard: a crimson node with the hazard type beside
          it. Two circle layers rather than one so the node reads as a glow
          -- MapLibre raster/circle layers have no shadow primitive.

          The label comes from feature properties, not from a style
          expression, because the "heavy rain overrides the terrain class"
          rule cannot be expressed in one.
        */}
        {forecast && forecast.features?.length ? (
          <MapLibreRN.ShapeSource id="hazard-forecast" shape={forecast}>
            <MapLibreRN.CircleLayer
              id="hazard-glow"
              style={{
                circleRadius: 22,
                circleColor: '#FF4444',
                circleOpacity: 0.18,
                circleBlur: 0.9,
              }}
            />
            <MapLibreRN.CircleLayer
              id="hazard-node"
              style={{
                circleRadius: 9,
                circleColor: '#DC143C',
                circleStrokeWidth: 3,
                circleStrokeColor: '#FFFFFF',
                // A forecast the phone could not refresh is drawn hollow, so a
                // stale warning never looks as certain as a live one.
                circleOpacity: ['case', ['get', 'stale'], 0.45, 1],
              }}
            />
            <MapLibreRN.SymbolLayer
              id="hazard-label"
              style={{
                textField: ['get', 'type'],
                textFont: ['Noto Sans Regular'],
                textSize: 12,
                textColor: '#FF4444',
                textHaloColor: '#FFFFFF',
                textHaloWidth: 1.6,
                textOffset: [0, 1.6],
                textAnchor: 'top',
                textAllowOverlap: false,
                // Never let one node's label hide another node's dot.
                textIgnorePlacement: false,
              }}
            />
          </MapLibreRN.ShapeSource>
        ) : null}

        {/* The truck itself, wherever the position came from. A dead-reckoned
            fix is drawn in the dead-reckoning colour so the driver can see at
            a glance that it is an estimate, not a satellite fix.

            Two layers for one truck, deliberately. This halo is pure GL and
            paints on any device; the directional vehicle puck below it is a
            native view. If the puck ever fails to mount the driver loses the
            heading and still sees the truck, which is the right way round for
            the one element they navigate by. */}
        {fix ? (
          <MapLibreRN.ShapeSource
            id="truck"
            shape={{
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [fix.longitude, fix.latitude] },
            }}
          >
            <MapLibreRN.CircleLayer
              id="truck-dot"
              style={{
                // Sized to sit just outside the 30 pt puck rather than under
                // it, so it reads as the accuracy glow around the vehicle.
                circleRadius: 19,
                // GNSS blue / dead-reckoning amber -- the same two colours the
                // dispatcher's map uses for the same two things. A driver and
                // a dispatcher discussing one truck must not be looking at
                // different colours for the same fix. Terminal green stays
                // reserved for link state alone.
                circleColor: fix.source === 'ekf'
                  ? t.color.sourceDeadReckoning
                  : t.color.sourceGnss,
                circleOpacity: 0.22,
                circleBlur: 0.35,
              }}
            />
          </MapLibreRN.ShapeSource>
        ) : null}

        {/* The puck is a native view (MarkerView) and is therefore the most
            likely thing on this screen to fail on a handset nobody has tested
            yet. Boundaried tightly, with a pure-GL dot as the fallback: the
            driver loses the heading indicator, never the truck, and the map
            around it keeps working. See VehicleMarkerFallback for why the
            accuracy halo is not sufficient on its own. */}
        <ErrorBoundary label="Vehicle marker" fallback={<VehicleMarkerFallback fix={fix} />}>
          <VehicleMarker fix={fix} />
        </ErrorBoundary>

        {(hazards ?? []).map((h) => (
          <MapLibreRN.ShapeSource
            key={h.id}
            id={`hazard-${h.id}`}
            shape={{
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [h.longitude, h.latitude] },
            }}
          >
            <MapLibreRN.CircleLayer
              id={`hazard-dot-${h.id}`}
              style={{
                circleRadius: 11,
                circleColor: t.color.alertFill,
                circleStrokeWidth: 2,
                circleStrokeColor: '#FFFFFF',
                circleOpacity: 0.9,
              }}
            />
          </MapLibreRN.ShapeSource>
        ))}
      </MapLibreRN.MapView>

      {cacheState === 'caching' ? (
        <Text style={styles.cacheNote}>CACHING MAP FOR DARK ZONE…</Text>
      ) : null}

      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  cacheNote: {
    position: 'absolute', alignSelf: 'center', bottom: 150,
    fontFamily: t.font.sansMedium, fontSize: t.type.micro, fontWeight: '700',
    letterSpacing: 0.8, color: t.color.textSecondary,
    backgroundColor: t.color.bgPanel, overflow: 'hidden',
    borderRadius: t.radius.pill,
    paddingHorizontal: t.space.md, paddingVertical: 6,
  },
});
