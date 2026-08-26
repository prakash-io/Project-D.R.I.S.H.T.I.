// Full-screen map base layer (Workflow 1/2, Epic 4 UI).
//
// MapLibre, not react-native-maps: the Google provider needs an API key and
// streams its tiles, so it renders a grey rectangle in exactly the dark zones
// this app exists for. MapLibre lets us point at a raster WMTS and pre-cache
// the corridor ahead of the truck.
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, AccessibilityInfo } from 'react-native';
import * as MapLibreRN from '@maplibre/maplibre-react-native';
import RNFS from 'react-native-fs';
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
  fix, route, hazards, forecast, zoom, follow, followKey, children,
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
        // The offline pack needs a style URI rather than an inline object, so
        // the same style is written to disk once and referenced by file://.
        const stylePath = `${RNFS.DocumentDirectoryPath}/bhuvan-style.json`;
        await RNFS.writeFile(stylePath, JSON.stringify(STYLE), 'utf8');

        // VERSIONED. createPack bakes the style into the pack, and the
        // getPack short-circuit below means an existing pack is never
        // refreshed -- so a handset that cached the old style would keep
        // rendering Bhuvan over OSM at z14 no matter what STYLE now says.
        // Bump this suffix whenever STYLE changes so the old pack is bypassed.
        const name = 'drishti-corridor-v2';
        // Reclaim the pack cut loose by the version bump. A handset flashed
        // before the STYLE change still has the v1 corridor on disk, and
        // nothing else will ever ask for it again.
        await MapLibreRN.offlineManager.deletePack('drishti-corridor').catch(() => {});

        const existing = await MapLibreRN.offlineManager.getPack(name).catch(() => null);
        if (existing) { setCacheState('ready'); return; }

        setCacheState('caching');
        await MapLibreRN.offlineManager.createPack(
          {
            name,
            styleURL: `file://${stylePath}`,
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
  }, [fix]);

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
      // Bottom is deepest: the speed card, stat cards and the hazard button
      // all sit over the lower third of the map.
      paddingTop: 50, paddingRight: 50, paddingBottom: 200, paddingLeft: 50,
    };
  }, [route]);

  const routeLine = route && route.length >= 2
    ? { type: 'Feature', geometry: { type: 'LineString', coordinates: route } }
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
          key={`cam-${follow ? 'follow' : 'free'}-${followKey ?? 0}`}
          defaultSettings={{ centerCoordinate: centre, zoomLevel: fix ? 14 : 4 }}
          followUserLocation={false}
          {...(follow
            ? { centerCoordinate: centre, zoomLevel: zoom ?? 14 }
            : routeBounds
              ? { bounds: routeBounds }
              : {})}
          animationDuration={reduceMotion ? 0 : 600}
        />

        {routeLine ? (
          <MapLibreRN.ShapeSource id="route" shape={routeLine}>
            <MapLibreRN.LineLayer
              id="route-line"
              style={{
                lineColor: t.color.accent,
                lineWidth: 5,
                lineCap: 'round',
                lineJoin: 'round',
                lineOpacity: 0.85,
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
            a glance that it is an estimate, not a satellite fix. */}
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
                circleRadius: 10,
                // GNSS blue / dead-reckoning amber -- the same two colours the
                // dispatcher's map uses for the same two things. A driver and
                // a dispatcher discussing one truck must not be looking at
                // different colours for the same fix. Terminal green stays
                // reserved for link state alone.
                circleColor: fix.source === 'ekf'
                  ? t.color.sourceDeadReckoning
                  : t.color.sourceGnss,
                circleStrokeWidth: 3,
                circleStrokeColor: '#FFFFFF',
              }}
            />
          </MapLibreRN.ShapeSource>
        ) : null}

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
