#!/usr/bin/env node
// Validates public/models/truck.glb (the output of gen_truck_gltf.mjs).
//
//     node scripts/validate_truck_gltf.mjs
//
// This does not shape-check the JSON. It reproduces the exact path deck.gl's
// ScenegraphLayer takes, because the failure this file exists to catch was
// invisible to every structural check:
//
//     Geometry truck-primitive-0 attribute POSITION:
//     must be typed array or object with value as typed array
//
// The model was valid. The problem was that ScenegraphLayer post-processes
// conditionally --
//
//     const processedGLTF = gltf.json ? postProcessGLTF(gltf) : gltf;
//
// -- and a .gltf served as application/json parses to an object with no
// `.json` key, so the accessors were never resolved into typed arrays. The
// assertions below therefore check `.json` is present and that POSITION comes
// out of postProcessGLTF as an actual typed array, which is the property
// luma.gl's Geometry constructor actually requires.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@loaders.gl/core';
import { GLTFLoader, postProcessGLTF } from '@loaders.gl/gltf';

const here = dirname(fileURLToPath(import.meta.url));
const MODEL = join(here, '..', 'public', 'models', 'truck.glb');

let failures = 0;
const ok = (label, extra = '') => console.log(`  ok   ${label}${extra ? `  ${extra}` : ''}`);
const fail = (label, why) => { failures += 1; console.log(`  FAIL ${label}  ${why}`); };

const raw = readFileSync(MODEL);

// ------------------------------------------------------- container format
// The magic is the whole reason this is a .glb: it is what lets loaders.gl
// identify the file by content instead of by the server's content-type.
raw.subarray(0, 4).toString('ascii') === 'glTF'
  ? ok('glB magic present', `version ${raw.readUInt32LE(4)}`)
  : fail('glB magic', raw.subarray(0, 4).toString('ascii'));

raw.readUInt32LE(8) === raw.length
  ? ok('declared length matches the file', `${raw.length} B`)
  : fail('declared length', `header says ${raw.readUInt32LE(8)}, file is ${raw.length}`);

// -------------------------------------------------------- deck.gl's path
const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
let processed = null;

try {
  const gltf = await parse(ab, GLTFLoader);

  // THE assertion. ScenegraphLayer branches on this exact key, and when it is
  // absent the layer silently skips post-processing and fails much later,
  // deep inside a geometry constructor, with nothing pointing back here.
  gltf.json
    ? ok('parsed result carries .json (deck.gl will post-process)',
      `keys: ${Object.keys(gltf).join(', ')}`)
    : fail('parsed result has no .json',
      'ScenegraphLayer would skip postProcessGLTF and fail on raw accessors');

  processed = gltf.json ? postProcessGLTF(gltf) : gltf;
  ok('post-processed',
    `${processed.meshes.length} mesh, ${processed.meshes[0].primitives.length} primitives`);
} catch (error) {
  fail('GLTFLoader parse', error.message);
}

if (processed) {
  const primitives = processed.meshes[0].primitives;

  // What luma.gl's Geometry constructor actually demands.
  const bad = primitives.filter((p) => !ArrayBuffer.isView(p.attributes?.POSITION?.value));
  bad.length === 0
    ? ok('every POSITION resolves to a typed array',
      `${primitives.length} primitives, first has ${primitives[0].attributes.POSITION.value.length} floats`)
    : fail('POSITION not a typed array', `${bad.length} of ${primitives.length} primitives`);

  const noNormals = primitives.filter((p) => !ArrayBuffer.isView(p.attributes?.NORMAL?.value));
  noNormals.length === 0
    ? ok('every NORMAL resolves to a typed array')
    : fail('NORMAL not a typed array', `${noNormals.length} primitives`);

  const noIndices = primitives.filter((p) => !ArrayBuffer.isView(p.indices?.value));
  noIndices.length === 0
    ? ok('every primitive has resolved indices')
    : fail('indices unresolved', `${noIndices.length} primitives`);

  // The map tints per truck through getColor, which multiplies against
  // baseColorFactor. A dark body would mute GNSS blue and dead-reckoning
  // amber into the same tone — the one distinction the console exists to show.
  const body = processed.materials.find((m) => m.name === 'body');
  const [r, g, b] = body.pbrMetallicRoughness.baseColorFactor;
  Math.min(r, g, b) >= 0.85
    ? ok('body material stays near-white for tinting', `rgb(${r}, ${g}, ${b})`)
    : fail('body material too dark to tint', `rgb(${r}, ${g}, ${b})`);
}

console.log(failures === 0
  ? '\ntruck.glb OK'
  : `\ntruck.glb FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
