#!/usr/bin/env node
// Asserts that Three.js never reaches the map (Task 2, crucial constraint).
//
//     npm run build && node scripts/check_three_isolation.mjs
//
// The rule is that the map is deck.gl over MapLibre and three.js draws only
// the console's own chrome — the navigation mark and the analytics chart.
// That is easy to state and easy to violate by accident: one `import { ... }
// from 'three'` inside a map component and rollup quietly folds the whole
// renderer into the map chunk, with no error and no visible symptom until two
// WebGL renderers are fighting over the same projection.
//
// So this checks it two ways, because either alone is weak:
//
//   1. SOURCE — no module the map subtree reaches may import three. Catches
//      the mistake at the place a human made it, with a filename to fix.
//   2. BUILD  — the emitted map and deck chunks must not contain three's
//      symbols. Catches transitive routes that a source grep would miss,
//      e.g. a helper that imports three and is pulled in by a map component.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '..', 'src');
const DIST = resolve(here, '..', 'dist', 'assets');

let failures = 0;
const ok = (label, extra = '') => console.log(`  ok   ${label}${extra ? `  ${extra}` : ''}`);
const fail = (label, why) => { failures += 1; console.log(`  FAIL ${label}  ${why}`); };

// The modules that may import three. Everything else in src/ may not.
const THREE_ALLOWED = new Set(['components/Logo3D.jsx', 'components/RiskBars3D.jsx']);
// The entry points of the map subtree. Anything these reach, transitively,
// is "the map" for the purposes of this rule.
const MAP_ROOTS = ['components/MapView.jsx', 'lib/mapStyle.js'];

const THREE_IMPORT = /from\s+['"](three|@react-three\/[\w-]+)['"]/;

/** Every .js/.jsx file under src/, as paths relative to src/. */
function walk(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
    else if (/\.jsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const files = walk(SRC);

// ------------------------------------------------------------- 1. source
const importers = files.filter((f) => THREE_IMPORT.test(readFileSync(join(SRC, f), 'utf8')));
const unexpected = importers.filter((f) => !THREE_ALLOWED.has(f));

unexpected.length === 0
  ? ok('three.js imported only by the allowed chrome modules', [...importers].join(', '))
  : fail('unexpected three.js import', unexpected.join(', '));

// Walk the map subtree's relative imports and confirm none of them is an
// allowed-three module either — that would be a legal import in a legal file
// reached from an illegal place.
const seen = new Set();
const queue = [...MAP_ROOTS];
while (queue.length > 0) {
  const file = queue.shift();
  if (seen.has(file) || !files.includes(file)) continue;
  seen.add(file);
  const source = readFileSync(join(SRC, file), 'utf8');
  for (const m of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const base = resolve(dirname(join(SRC, file)), m[1]).slice(SRC.length + 1);
    for (const candidate of [base, `${base}.jsx`, `${base}.js`, `${base}/index.jsx`]) {
      if (files.includes(candidate)) { queue.push(candidate); break; }
    }
  }
}
const tainted = [...seen].filter((f) => THREE_ALLOWED.has(f) || importers.includes(f));
tainted.length === 0
  ? ok('map subtree reaches no three.js module', `${seen.size} modules walked`)
  : fail('map subtree reaches three.js', tainted.join(', '));

// -------------------------------------------------------------- 2. build
let chunks;
try {
  chunks = readdirSync(DIST).filter((f) => f.endsWith('.js'));
} catch {
  fail('dist/assets', 'not found — run `npm run build` first');
  chunks = [];
}

if (chunks.length > 0) {
  const pick = (name) => chunks.find((c) => c.startsWith(`${name}-`));
  const mapChunk = pick('map');
  const deckChunk = pick('deck');
  const threeChunk = pick('three');

  // A marker string that three's WebGLRenderer emits and that nothing else
  // in this app would contain. Checking for the bare word "three" would
  // match any English prose that survived minification.
  const MARKER = /WebGLRenderer|THREE\.WebGL|isMesh/;

  threeChunk && MARKER.test(readFileSync(join(DIST, threeChunk), 'utf8'))
    ? ok('three.js is emitted in its own chunk', threeChunk)
    : fail('three chunk', threeChunk ? 'no renderer symbols found' : 'chunk not emitted');

  for (const [label, chunk] of [['map', mapChunk], ['deck', deckChunk]]) {
    if (!chunk) { fail(`${label} chunk`, 'not emitted'); continue; }
    MARKER.test(readFileSync(join(DIST, chunk), 'utf8'))
      ? fail(`${label} chunk contains three.js`, chunk)
      : ok(`${label} chunk is free of three.js`, chunk);
  }
}

console.log(failures === 0
  ? '\nthree.js isolation OK'
  : `\nthree.js isolation FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
