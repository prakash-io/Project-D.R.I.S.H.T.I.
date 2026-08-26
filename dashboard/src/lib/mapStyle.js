// Basemap style.
//
// CARTO's dark-matter style over OpenStreetMap data: free, no API key, no
// account, and no Mapbox token to leak into a public repo. The plan named
// Mapbox GL; using MapLibre with a CARTO style keeps the same rendering
// engine lineage without a paid dependency, which matters for a demonstrator
// that has to run on someone else's laptop.
export const BASEMAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

// Guwahati. The largest city in the NER and the natural hub for the corridors
// this platform routes over.
export const INITIAL_VIEW_STATE = {
  longitude: 91.7362,
  latitude: 26.1445,
  zoom: 9,
  pitch: 0,
  bearing: 0,
};
