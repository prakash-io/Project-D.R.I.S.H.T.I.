// Basemap style.
//
// Bhuvan (ISRO / NRSC) raster, NOT CARTO/OpenStreetMap.
//
// This is a territorial-accuracy requirement, not an aesthetic one. CARTO's
// dark-matter style is rendered from OpenStreetMap, which draws Jammu &
// Kashmir the way the international community does: the northern districts
// are split off behind dotted "disputed" boundaries and labelled
// GILGIT-BALTISTAN and AZAD KASHMIR. Both were verified directly against the
// served tiles at z6 over 73-80E / 32-37N.
//
// That is not the boundary of India as depicted by the Survey of India, and a
// platform built for an Indian agency cannot ship a dispatcher console that
// draws it. Bhuvan's india3 layer is the national basemap: J&K and Ladakh
// appear as complete Indian states with solid, undotted boundaries.
//
// Bhuvan is also keyless, which is what the CARTO choice was originally
// protecting -- and the CARTO raster endpoint has since started stamping
// "API KEY REQUIRED" across its tiles, so that protection had lapsed anyway.
//
// OSM is deliberately NOT stacked underneath as a gap filler the way it is in
// the mobile client. Here it would be the wrong boundary showing through
// exactly the holes we are trying to correct.
//
// Tiles come through our own backend rather than from Bhuvan directly, and
// that indirection is REQUIRED, not a caching nicety: Bhuvan sends no
// Access-Control-Allow-Origin, and MapLibre uploads raster tiles into a WebGL
// texture, so the browser rejects every tile as `TypeError: Failed to fetch`
// and renders an empty map with no HTTP error to point at. See
// backend/src/routes/tiles.js. The mobile client keeps its direct URL because
// MapLibre Native is not a browser and has no CORS to satisfy.
import { API_URL } from './api';

const BHUVAN_TILES = `${API_URL}/tiles/bhuvan/{z}/{x}/{y}.png`;

export const BASEMAP_STYLE = {
  version: 8,
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {
    bhuvan: {
      type: 'raster',
      tiles: [BHUVAN_TILES],
      tileSize: 256,
      attribution: '© ISRO / NRSC Bhuvan',
    },
  },
  layers: [
    // NOTE: this colour looks inverted because it IS. The whole basemap canvas
    // is flipped to dark in CSS (see `.maplibregl-canvas` in index.css), so
    // every colour declared here must be written as its LIGHT pre-inversion
    // value. #e8eef2 is Bhuvan's own off-map fill, so a missing tile inverts
    // to precisely the same dark tone as the sea and the land beyond the
    // border rather than punching a hole in the map.
    { id: 'void', type: 'background', paint: { 'background-color': '#e8eef2' } },
    { id: 'bhuvan-layer', type: 'raster', source: 'bhuvan', minzoom: 0, maxzoom: 19 },
  ],
};

// Guwahati. The largest city in the NER and the natural hub for the corridors
// this platform routes over.
// Pitched, and that is a functional choice rather than a flourish. The trucks
// are 3D glTF models drawn by a ScenegraphLayer (MapView), and at pitch 0 a
// model is seen from directly above: the silhouette collapses to a rectangle,
// the heading it encodes becomes unreadable, and the layer costs a great deal
// more than the ScatterplotLayer it replaced for no gain at all.
//
// 40 degrees rather than more. Past roughly 50 the far half of the viewport
// compresses into the horizon and a corridor running north-south stops being
// comparable end to end, which is exactly the judgement this console exists
// to support. The dispatcher can still tilt and rotate freely -- MapView
// enables dragRotate -- so this is only the opening frame.
export const INITIAL_VIEW_STATE = {
  longitude: 91.7362,
  latitude: 26.1445,
  zoom: 9,
  pitch: 40,
  bearing: -18,
};
