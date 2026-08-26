// The sovereign basemap: ISRO / NRSC Bhuvan, served from bhuvan-vec1 (Task 1).
//
// Bhuvan's GeoWebCache speaks WMTS over the EPSG:900913 tile matrix set, which
// is the same Web Mercator grid MapLibre's raster source already assumes -- so
// TILEMATRIX/TILEROW/TILECOL map straight onto {z}/{y}/{x} with no reprojection
// and no proxy. That is the entire integration.
//
// TWO things about this basemap drove the design below.
//
// 1. It is a LIGHT cartographic raster. Dropping it unmodified under a dark
//    command-center HUD produces a white sheet with cyan markers floating on
//    it, and the markers lose the contrast the whole interface depends on. So
//    the style sandwiches the raster: an ink background beneath it (so tiles
//    that have not loaded yet read as substrate, not as white flash), and a
//    translucent ink background layer ABOVE it as a scrim. MapLibre draws
//    background layers in layer order like any other layer, so a background
//    placed last is a full-viewport scrim. `basemapDim` drives its alpha and
//    is a dispatcher-facing control, because how much terrain you want to see
//    through the data genuinely differs between planning and monitoring.
//
// 2. It is a government service reached over the public internet, and this is
//    a platform whose entire premise is that connectivity fails. If Bhuvan is
//    unreachable -- down, blocked, or serving without the CORS header MapLibre
//    needs -- the dispatcher must not get a blank map. `probeBhuvan()` tests
//    one tile before the map commits, and CommandMap also listens for source
//    errors at runtime; either path flips to the CARTO dark-matter fallback
//    that CLAUDE.md decision 13 already established. Sovereign when it can be,
//    never blank.

/// Host is fixed by the brief. Layer and matrix set are configurable because
/// Bhuvan publishes several and the useful one differs by deployment.
const BHUVAN_HOST = 'https://bhuvan-vec1.nrsc.gov.in';
const BHUVAN_LAYER = import.meta.env.VITE_BHUVAN_LAYER ?? 'india3';
const BHUVAN_MATRIX = import.meta.env.VITE_BHUVAN_TILEMATRIXSET ?? 'EPSG:900913';

/** The WMTS GetTile template, in MapLibre's {z}/{x}/{y} placeholder form. */
export const BHUVAN_TILE_URL =
  `${BHUVAN_HOST}/bhuvan/gwc/service/wmts`
  + '?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0'
  + `&LAYER=${encodeURIComponent(BHUVAN_LAYER)}`
  + '&STYLE='
  + `&TILEMATRIXSET=${encodeURIComponent(BHUVAN_MATRIX)}`
  + `&TILEMATRIX=${encodeURIComponent(BHUVAN_MATRIX)}:{z}`
  + '&TILEROW={y}&TILECOL={x}'
  + '&FORMAT=image/png';

/// CLAUDE.md decision 13. No API key, no Mapbox token, already dark.
export const FALLBACK_STYLE_URL =
  import.meta.env.VITE_MAP_STYLE
  ?? 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

export const BHUVAN_ATTRIBUTION =
  '<a href="https://bhuvan.nrsc.gov.in/" target="_blank" rel="noreferrer">ISRO / NRSC Bhuvan</a>';

/// Guwahati: the largest city in the NER and the hub for the corridors this
/// platform routes over. Wide enough to hold a regional view, per Task 1 --
/// the camera is never hard-locked, this is only where it opens.
export const INITIAL_VIEW_STATE = {
  longitude: 91.7362,
  latitude: 26.1445,
  zoom: 8.2,
  pitch: 0,
  bearing: 0,
  minZoom: 4,
  maxZoom: 17,
};

/**
 * A complete MapLibre style with Bhuvan as the primary raster layer.
 *
 * @param {number} dim  0..1 alpha of the scrim over the raster.
 */
export function bhuvanStyle(dim = 0.55) {
  const alpha = Math.max(0, Math.min(1, dim));
  return {
    version: 8,
    // No glyphs or sprite entry: this style has no symbol layers. Every label
    // and icon on this map is drawn by deck.gl, which carries its own font
    // atlas, so the basemap needs no second network dependency to render text.
    sources: {
      bhuvan: {
        type: 'raster',
        tiles: [BHUVAN_TILE_URL],
        tileSize: 256,
        maxzoom: 17,
        attribution: BHUVAN_ATTRIBUTION,
      },
    },
    layers: [
      // Beneath: substrate. An unloaded tile reads as the panel colour rather
      // than as a white hole punched in the map.
      {
        id: 'substrate',
        type: 'background',
        paint: { 'background-color': '#0A0A0A' },
      },
      {
        id: 'bhuvan-raster',
        type: 'raster',
        source: 'bhuvan',
        paint: {
          // Pulled toward monochrome and darkened before the scrim even
          // lands, so the scrim can stay light enough to leave terrain
          // legible. Doing all the work with alpha alone washes the imagery
          // into flat grey.
          'raster-saturation': -0.45,
          'raster-contrast': 0.15,
          'raster-brightness-max': 0.88,
          'raster-fade-duration': 200,
        },
      },
      // Above: the scrim. See the header note on layer order.
      {
        id: 'basemap-scrim',
        type: 'background',
        paint: { 'background-color': `rgba(10, 10, 10, ${alpha})` },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------
//
// A third basemap, and on this platform not a cosmetic one. Every hazard this
// system predicts is a function of terrain -- the XGBoost model's own features
// are elevation, slope and aspect -- so a dispatcher judging whether a
// landslide report is plausible, or which of two detours climbs less, is
// asking a question a flat vector basemap physically cannot answer.
//
// Esri World Hillshade: no key, no account, CORS-enabled, and already
// grayscale, which means it composites under a dark command UI without the
// colour-cast fight a topographic raster like OpenTopoMap would bring.
//
// Note the tile path order is {z}/{y}/{x}, NOT the usual {z}/{x}/{y} -- an
// easy way to end up with a map that renders plausibly and is silently
// transposed.
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';

export const HILLSHADE_TILE_URL = `${ESRI}/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}`;
/// Transparent labels and boundaries. Relief with no place names is a
/// beautiful, unusable picture -- a dispatcher has to be able to say WHERE the
/// slope is, not just that there is one.
export const PLACES_TILE_URL =
  `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`;

export const TERRAIN_ATTRIBUTION =
  '<a href="https://www.esri.com/" target="_blank" rel="noreferrer">Esri</a>, USGS, NOAA';

/**
 * Shaded relief with place labels, sunk behind the data layers.
 *
 * Deliberately NOT Esri's World_Terrain_Base. That service has no coverage at
 * street zoom over the NER, and instead of failing it serves a tile with "Map
 * data not yet available" printed across it -- which then tiles into a
 * watermark across the dispatcher's map. World_Hillshade covers the region to
 * z16, so relief comes from that alone and the labels come from the
 * transparent reference overlay.
 *
 * The relief is pulled dark: `raster-brightness-max` at 0.5 is doing most of
 * the work, because hillshade is a near-white image and the scrim alone cannot
 * darken it without also erasing the shape. Ridges still read, they just stop
 * glowing under the cyan markers.
 */
export function terrainStyle(dim = 0.45) {
  const alpha = Math.max(0, Math.min(1, dim));
  return {
    version: 8,
    sources: {
      hillshade: {
        type: 'raster',
        tiles: [HILLSHADE_TILE_URL],
        tileSize: 256,
        maxzoom: 16,
        attribution: TERRAIN_ATTRIBUTION,
      },
      places: {
        type: 'raster',
        tiles: [PLACES_TILE_URL],
        tileSize: 256,
        maxzoom: 16,
      },
    },
    layers: [
      { id: 'substrate', type: 'background', paint: { 'background-color': '#0A0A0A' } },
      {
        id: 'hillshade',
        type: 'raster',
        source: 'hillshade',
        paint: {
          'raster-opacity': 0.9,
          'raster-contrast': 0.35,
          'raster-saturation': -1,
          // 0.4, not 0.5. Hillshade is a near-white image, and at 0.5 the
          // whole map still sits at mid-grey -- bright enough that the cyan
          // fleet markers lose the contrast the interface depends on. This is
          // the exposure, and the scrim is the fine adjustment on top of it.
          'raster-brightness-max': 0.4,
        },
      },
      {
        // Above the scrim would be brighter, but labels belong UNDER the dim
        // control like everything else on the basemap -- otherwise turning the
        // basemap down leaves the place names floating at full strength over
        // a dark ground.
        id: 'places',
        type: 'raster',
        source: 'places',
        paint: { 'raster-opacity': 0.5, 'raster-saturation': -0.6, 'raster-brightness-max': 0.7 },
      },
      { id: 'basemap-scrim', type: 'background', paint: { 'background-color': `rgba(10, 10, 10, ${alpha})` } },
    ],
  };
}

/**
 * Can MapLibre actually use Bhuvan from this origin?
 *
 * That is a narrower question than "is Bhuvan up", and it is the one that
 * decides whether the dispatcher gets a map or a black rectangle. MapLibre
 * fetches raster tiles through fetch() with CORS, so the probe has to do the
 * same thing: a tile that loads perfectly in an <img> but carries no
 * `Access-Control-Allow-Origin` header is unusable to the renderer.
 *
 * That is not hypothetical -- it is what bhuvan-vec1 does today. The service
 * answers 200 with a valid PNG and sends no CORS header, so an <img>-based
 * probe reports the layer healthy and the map then renders nothing. This
 * probe therefore runs BOTH:
 *
 *   fetch(cors)  the real question. Usable or not.
 *   <img>        only to tell the two failures apart, so the banner can say
 *                "blocks cross-origin reads" rather than "unreachable" --
 *                different problems with very different fixes (a proxy vs.
 *                a network route).
 *
 * Resolves { usable, reason }.
 */
export async function probeBhuvan({ timeoutMs = 6000 } = {}) {
  // z=5 over the NER: a tile that certainly has content, so a blank-but-valid
  // ocean tile cannot pass for a working layer.
  const url = BHUVAN_TILE_URL
    .replace('{z}', '5').replace('{x}', '23').replace('{y}', '13');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { mode: 'cors', signal: controller.signal });
    clearTimeout(timer);
    if (response.ok) return { usable: true, reason: null };
    return { usable: false, reason: `Bhuvan answered HTTP ${response.status}` };
  } catch {
    clearTimeout(timer);
    // Either CORS-blocked or genuinely unreachable. The image probe separates
    // them, purely so the message is actionable.
    const reachable = await imageReachable(url, timeoutMs);
    return {
      usable: false,
      reason: reachable
        ? 'Bhuvan is serving tiles but blocks cross-origin reads (no CORS header)'
        : 'Bhuvan tiles did not respond',
    };
  }
}

function imageReachable(url, timeoutMs) {
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      image.onload = null;
      image.onerror = null;
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    image.onload = () => { clearTimeout(timer); finish(true); };
    image.onerror = () => { clearTimeout(timer); finish(false); };
    image.src = url;
  });
}
