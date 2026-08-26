// The fleet marker: a top-down truck silhouette, inlined as a data URI.
//
// Inlined rather than fetched for the same reason the basemap has a fallback:
// this dashboard has to keep working when the network is the thing that broke.
// A sprite sheet on a CDN would leave a fleet of blank squares at exactly the
// moment a dispatcher needs to see where the trucks are.
//
// Drawn as a white silhouette on transparent and used with IconLayer's
// `mask: true`, which makes deck.gl treat the alpha channel as a stencil and
// paint it with `getColor`. That is what lets one sprite render cyan for a
// GNSS fix and amber for dead reckoning without a second asset -- and it is
// why nothing in the SVG below has a colour of its own.
//
// The shape points NORTH at angle 0, matching IconLayer's convention, so
// `getAngle: -heading_deg` orients it correctly (deck.gl measures angles
// counter-clockwise, compass headings run clockwise).

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <g fill="#ffffff">
    <!-- nose: reads as direction of travel even at 28px -->
    <path d="M32 3 L41 13 L23 13 Z"/>
    <!-- cab -->
    <rect x="21" y="14" width="22" height="15" rx="3"/>
    <!-- trailer, separated by a transparent gap so the pair reads as a
         truck rather than as one blob at small sizes -->
    <rect x="19" y="32" width="26" height="28" rx="3"/>
  </g>
</svg>`;

/// encodeURIComponent, not base64: the SVG stays readable in devtools and the
/// payload is smaller than the base64 of the same bytes.
const DATA_URI = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SVG)}`;

export const TRUCK_ICON = {
  url: DATA_URI,
  width: 64,
  height: 64,
  // Anchored at the centre so the marker sits ON the coordinate rather than
  // hanging below it -- a 28px offset is ~40 m at street zoom, which is enough
  // to put a truck on the wrong side of a junction.
  anchorX: 32,
  anchorY: 32,
  mask: true,
};
