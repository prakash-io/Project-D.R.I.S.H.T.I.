// Guards GET /tiles/style.json and, more importantly, the thing that endpoint
// can silently get wrong.
//
// The offline corridor pack fetches its style from the backend because
// MapLibre will not accept a `file://` style URL for a pack (its offline
// downloader runs every resource through OnlineFileSource, which on Android is
// OkHttp, and HttpUrl.parse() returns null for any non-http(s) scheme). That
// leaves two copies of the basemap style: the inline one the app renders from,
// and this one the pack is built from.
//
// If they disagree about SOURCES the pack is worse than useless. The offline
// database keys cached tiles by URL, so a pack built from different tile URLs
// downloads tiles the live map will never ask for -- the driver would have a
// full corridor cache and still see a blank map in the dark zone, with nothing
// logged. Zoom ranges decide which tiles are stored at all.
//
// Paint is deliberately NOT compared: the night treatment is applied by the
// app at render time and has no bearing on what a pack contains.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const backendStyle = JSON.parse(
  readFileSync(new URL('../src/mapStyle.json', import.meta.url), 'utf8'),
);

// Pull the app's STYLE object straight out of the component, so this compares
// what actually ships rather than a third transcription of it.
const canvasUrl = new URL('../../mobile-app/src/ui/MapCanvas.jsx', import.meta.url);
const canvas = readFileSync(canvasUrl, 'utf8');
const start = canvas.indexOf('const STYLE = {');
assert.notEqual(start, -1, 'STYLE not found in MapCanvas.jsx');
const end = canvas.indexOf('\n};', start);
assert.notEqual(end, -1, 'end of STYLE not found in MapCanvas.jsx');
const literal = canvas.slice(start + 'const STYLE = '.length, end + 2);
// eslint-disable-next-line no-new-func
const appStyle = new Function(`return ${literal}`)();

let checks = 0;
let failures = 0;
function check(name, fn) {
  checks += 1;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

check('backend style is a v8 MapLibre style', () => {
  assert.equal(backendStyle.version, 8);
  assert.ok(backendStyle.sources && backendStyle.layers);
});

check('glyphs match (a pack with no glyph source stores no labels)', () => {
  assert.equal(backendStyle.glyphs, appStyle.glyphs);
});

check('the same sources exist on both sides', () => {
  assert.deepEqual(
    Object.keys(backendStyle.sources).sort(),
    Object.keys(appStyle.sources).sort(),
  );
});

for (const id of Object.keys(appStyle.sources)) {
  check(`source "${id}" caches the tile URLs the live map requests`, () => {
    assert.deepEqual(backendStyle.sources[id].tiles, appStyle.sources[id].tiles);
    assert.equal(backendStyle.sources[id].maxzoom, appStyle.sources[id].maxzoom);
    assert.equal(backendStyle.sources[id].tileSize, appStyle.sources[id].tileSize);
  });
}

check('layer zoom ranges match, so the pack stores the zooms drawn', () => {
  const shape = (s) => s.layers.map((l) => `${l.id}:${l.source}:${l.minzoom}-${l.maxzoom}`);
  assert.deepEqual(shape(backendStyle), shape(appStyle));
});

check('the route serves the shared file rather than its own literal', () => {
  const route = readFileSync(new URL('../src/routes/tiles.js', import.meta.url), 'utf8');
  assert.match(route, /mapStyle\.json/);
  assert.match(route, /style\.json/);
});

check('the app no longer builds a file:// style URL for the pack', () => {
  assert.doesNotMatch(canvas, /file:\/\/\$\{stylePath\}/);
  assert.doesNotMatch(canvas, /bhuvan-style\.json/);
});

console.log(`\n${checks} checks, ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
