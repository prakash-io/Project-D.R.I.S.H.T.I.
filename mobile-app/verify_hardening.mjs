// Asserts the first-APK safeguards are actually in place (task 4).
//
//     node verify_hardening.mjs
//
// This app has never been built or rendered on a handset. verify_parse proves
// every file parses and every import resolves; verify_runtime proves no
// web-only global reaches the device. Neither can say anything about the two
// risks that actually matter on the first APK:
//
//   1. A NATIVE view failing to mount. React unmounts the whole tree when a
//      component throws during render, so an unboundaried MarkerView that does
//      not bridge on some OEM's Android build blanks the driver's screen
//      entirely -- in a valley, with no signal, which is the moment the app
//      exists for.
//
//   2. A font that is not on the device. A missing family does not throw on
//      Android; it silently falls back to something with different metrics,
//      and a layout tuned on iOS reflows. The defence is to name only families
//      guaranteed by the platform, and the way that regresses is someone
//      writing `fontFamily: 'Inter'` in one new component.
//
// These are structural properties, checkable from source without a device.
// They are NOT a substitute for running the APK -- nothing here proves the map
// renders. They prove that when it does not, the rest of the app survives.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, 'src');

let failures = 0;
const ok = (label, extra = '') => console.log(`  ok   ${label}${extra ? `  ${extra}` : ''}`);
const fail = (label, why) => { failures += 1; console.log(`  FAIL ${label}  ${why}`); };

function walk(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
    else if (/\.jsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const files = walk(SRC).map((f) => ({ path: `src/${f}`, text: readFileSync(join(SRC, f), 'utf8') }));
files.push({ path: 'App.jsx', text: readFileSync(join(here, 'App.jsx'), 'utf8') });
const byPath = Object.fromEntries(files.map((f) => [f.path, f.text]));

// ------------------------------------------------------------------ fonts
// Families guaranteed present by the platform itself. 'System' and 'Menlo'
// ship with iOS; 'sans-serif', 'sans-serif-medium' and 'monospace' are Android
// family ALIASES the framework always resolves, not font files that have to be
// bundled. Anything else needs a file in android/app/src/main/assets/fonts and
// a matching iOS entry, and silently degrades if either is missing.
const SAFE_FAMILIES = new Set([
  'System', 'Menlo',
  'sans-serif', 'sans-serif-medium', 'monospace',
]);

const tokens = byPath['src/ui/tokens.js'];
const stackLines = tokens.split('\n').filter((l) => /^const (sans|sansMedium|mono) =/.test(l));
// Only the families named in the three stack lines count. Scanning the whole
// file would sweep up every unrelated string literal in it.
const declared = stackLines.flatMap((line) =>
  [...line.matchAll(/'([^']+)'/g)]
    .map((m) => m[1])
    .filter((v) => SAFE_FAMILIES.has(v)));

const unsafeInStack = stackLines.flatMap((line) =>
  [...line.matchAll(/'([^']+)'/g)]
    .map((m) => m[1])
    .filter((v) => !SAFE_FAMILIES.has(v) && !['ios', 'android', 'default'].includes(v)));

stackLines.length === 3 && unsafeInStack.length === 0
  ? ok('font stacks name only platform-guaranteed families',
    [...new Set(declared)].join(', '))
  : fail('font stack', unsafeInStack.length
    ? `unsafe families: ${unsafeInStack.join(', ')}`
    : `expected 3 stack definitions, found ${stackLines.length}`);

// Every fontFamily must come from the token, never a literal. A literal is how
// an unbundled family gets in without anyone editing tokens.js.
//
// The value is captured and tested in JS rather than excluded with a negative
// lookahead. `fontFamily:\s*(?!t\.font)` looks right and is not: `\s*` gives
// back the space on backtracking, the lookahead then succeeds one character
// early, and EVERY correct `fontFamily: t.font.sans` is reported as a literal.
const literalFonts = files.flatMap((f) =>
  [...f.text.matchAll(/fontFamily:\s*([^,\n}]+)/g)]
    .map((m) => m[1].trim())
    .filter((value) => !value.startsWith('t.font'))
    .map((value) => `${f.path}: ${value}`));
literalFonts.length === 0
  ? ok('every fontFamily resolves through the token', `${files.length} files`)
  : fail('literal fontFamily', literalFonts.join('; '));

// fontVariant: ['tabular-nums'] keeps ticking digits from reflowing. React
// Native supports it on Android only from 0.73; below that it is silently
// ignored and every speed readout jitters. Assert the floor rather than trust
// a memory of it.
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
const rnVersion = pkg.dependencies['react-native'];
const [major, minor] = rnVersion.replace(/[^\d.]/g, '').split('.').map(Number);
const usesTabular = files.some((f) => f.text.includes("fontVariant"));
if (!usesTabular) {
  ok('no fontVariant in use');
} else if (major > 0 || minor >= 73) {
  ok('fontVariant is supported on Android at this RN version', `react-native ${rnVersion}`);
} else {
  fail('fontVariant on Android', `react-native ${rnVersion} < 0.73 ignores it silently`);
}

// -------------------------------------------------------------- boundaries
const boundary = byPath['src/ui/ErrorBoundary.jsx'];
boundary && /getDerivedStateFromError/.test(boundary) && /componentDidCatch/.test(boundary)
  ? ok('ErrorBoundary implements both React error hooks')
  : fail('ErrorBoundary', 'missing getDerivedStateFromError or componentDidCatch');

// The map, in App.jsx. Checked as "the MapCanvas element is inside a boundary"
// rather than merely "both words appear in the file".
const app = byPath['App.jsx'];
const mapWrapped = /<ErrorBoundary[^>]*>\s*(\{\/\*[\s\S]*?\*\/\}\s*)?<MapCanvas/.test(app);
mapWrapped
  ? ok('MapCanvas is wrapped in an ErrorBoundary')
  : fail('MapCanvas boundary', 'no <ErrorBoundary> immediately around <MapCanvas>');

// The marker, in MapCanvas. This one must also carry a fallback -- a boundary
// with no fallback would render the default error card ON the map.
const canvas = byPath['src/ui/MapCanvas.jsx'];
const markerWrapped = /<ErrorBoundary[^>]*fallback=\{<VehicleMarkerFallback[\s\S]{0,200}?<VehicleMarker\b/.test(canvas);
markerWrapped
  ? ok('VehicleMarker is boundaried with a pure-GL fallback')
  : fail('VehicleMarker boundary', 'no ErrorBoundary with a VehicleMarkerFallback around <VehicleMarker>');

// --------------------------------------------------------- native fallback
const marker = byPath['src/ui/VehicleMarker.jsx'];

/MapLibreRN\.MarkerView/.test(marker) && /if \(!MapLibreRN\.MarkerView\)/.test(marker)
  ? ok('VehicleMarker checks MarkerView exists before using it')
  : fail('MarkerView guard', 'no availability check before the native view is rendered');

// The fallback must not itself depend on the bridge that just failed. A
// MarkerView-based fallback for a MarkerView failure is not a fallback.
const fallbackBody = marker.slice(marker.indexOf('export function VehicleMarkerFallback'),
  marker.indexOf('export default function VehicleMarker'));
!/MarkerView/.test(fallbackBody) && /CircleLayer/.test(fallbackBody)
  ? ok('the fallback is pure GL (CircleLayer), not another native view')
  : fail('fallback', 'VehicleMarkerFallback must draw a CircleLayer and use no MarkerView');

console.log(failures === 0
  ? `\nhardening OK (${files.length} files)`
  : `\nhardening FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
