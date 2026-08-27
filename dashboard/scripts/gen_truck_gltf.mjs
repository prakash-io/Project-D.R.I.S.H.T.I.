#!/usr/bin/env node
// Generates public/models/truck.glb — the 3D vehicle the map draws (WEB-03).
//
//     node scripts/gen_truck_gltf.mjs
//
// Why .glb and not .gltf, which is what this emitted first
// --------------------------------------------------------
// A JSON .gltf loaded and post-processed perfectly under Node and failed in
// the browser with:
//
//     Geometry truck-primitive-0 attribute POSITION:
//     must be typed array or object with value as typed array
//
// The cause is content-type, not geometry. Vite serves a .gltf as
// application/json, so loaders.gl's auto-detection hands it to the JSON
// loader rather than the GLTFLoader. The result is the raw glTF object with
// no `.json` wrapper — and deck.gl's ScenegraphLayer decides whether to
// post-process on exactly that key:
//
//     const processedGLTF = gltf.json ? postProcessGLTF(gltf) : gltf;
//
// So the accessors were never resolved into typed arrays, and the failure
// surfaced deep inside luma.gl's geometry constructor with nothing pointing
// back at the MIME type. A .glb is detected by its `glTF` magic bytes and
// cannot be routed to the wrong loader whatever the server sends.
//
// It is also simply the better format here: the binary chunk replaces a
// base64 data URI, which was costing 33% in transfer for no benefit.
//
// Why generate rather than commit a downloaded model
// ---------------------------------------------------
// A ScenegraphLayer needs a real glTF, and the obvious way to get one is to
// pull a truck off a model library. That fails this project twice over: the
// console must load with no third-party fetch (the same constraint that put
// the basemap behind our own /tiles proxy and kept the fonts on system
// stacks), and a binary blob in git is a thing nobody can review or adjust.
// This script is the source; the .gltf is its build output.
//
// The model is deliberately UNTINTED — every material is near-white. The map
// tints per truck through ScenegraphLayer's getColor, because GNSS blue vs.
// dead-reckoning amber is the encoded distinction the whole product turns on
// (index.css and MapView both spend real care on it). Baking a body colour in
// here would put a second, competing source of truth on the same pixel.
//
// Geometry is boxes on purpose. At the zoom a dispatcher watches a corridor
// at, a truck occupies a few dozen pixels: a silhouette that reads as
// "cab + body + wheels" is all the resolution that survives, and every
// triangle beyond that is payload nobody can see.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'public', 'models', 'truck.glb');

// glTF is Y-up; deck.gl is Z-up. The model is built Y-up per the spec and the
// map corrects with a roll of 90 in getOrientation, which is the convention
// deck.gl's own scenegraph examples use. Length runs along +X, so a yaw of 0
// points the truck east and the layer's -heading maps compass to scene.
const BOXES = [
  // name          min                    max                  material
  ['cargo',   [-2.30, 0.62, -0.85],  [ 0.75, 2.35,  0.85], 0],
  ['cab',     [ 0.75, 0.62, -0.82],  [ 2.30, 1.95,  0.82], 0],
  ['glass',   [ 1.55, 1.30, -0.78],  [ 2.28, 1.92,  0.78], 1],
  ['chassis', [-2.35, 0.38, -0.70],  [ 2.30, 0.66,  0.70], 2],
  ['wheelFL', [ 1.20, 0.00, -0.95],  [ 1.95, 0.72, -0.72], 2],
  ['wheelFR', [ 1.20, 0.00,  0.72],  [ 1.95, 0.72,  0.95], 2],
  ['wheelRL', [-1.85, 0.00, -0.95],  [-1.05, 0.72, -0.72], 2],
  ['wheelRR', [-1.85, 0.00,  0.72],  [-1.05, 0.72,  0.95], 2],
];

/** The six faces of an axis-aligned box, with flat per-face normals. */
function box([x0, y0, z0], [x1, y1, z1]) {
  const faces = [
    { n: [ 0,  0,  1], v: [[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]] },
    { n: [ 0,  0, -1], v: [[x1,y0,z0],[x0,y0,z0],[x0,y1,z0],[x1,y1,z0]] },
    { n: [ 0,  1,  0], v: [[x0,y1,z1],[x1,y1,z1],[x1,y1,z0],[x0,y1,z0]] },
    { n: [ 0, -1,  0], v: [[x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1]] },
    { n: [ 1,  0,  0], v: [[x1,y0,z1],[x1,y0,z0],[x1,y1,z0],[x1,y1,z1]] },
    { n: [-1,  0,  0], v: [[x0,y0,z0],[x0,y0,z1],[x0,y1,z1],[x0,y1,z0]] },
  ];

  const positions = [];
  const normals = [];
  const indices = [];

  faces.forEach((face, f) => {
    face.v.forEach((vertex) => {
      positions.push(...vertex);
      normals.push(...face.n);
    });
    const b = f * 4;
    // Two triangles, counter-clockwise seen from outside — glTF's front-face
    // winding. Getting this backwards renders the truck inside-out, which
    // looks like a lighting bug rather than a winding one.
    indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });

  return { positions, normals, indices };
}

/** Pad a byte length up to the 4-byte alignment glTF accessors require. */
const pad4 = (n) => (n + 3) & ~3;

const chunks = [];   // { bytes, target }
let offset = 0;
const bufferViews = [];
const accessors = [];
const primitives = [];

function pushView(bytes, target) {
  const start = pad4(offset);
  if (start > offset) chunks.push(Buffer.alloc(start - offset));
  chunks.push(bytes);
  bufferViews.push({ buffer: 0, byteOffset: start, byteLength: bytes.length, target });
  offset = start + bytes.length;
  return bufferViews.length - 1;
}

for (const [, min, max, material] of BOXES) {
  const { positions, normals, indices } = box(min, max);

  const posBytes = Buffer.from(new Float32Array(positions).buffer);
  const nrmBytes = Buffer.from(new Float32Array(normals).buffer);
  const idxBytes = Buffer.from(new Uint16Array(indices).buffer);

  // 34962 ARRAY_BUFFER, 34963 ELEMENT_ARRAY_BUFFER.
  const posView = pushView(posBytes, 34962);
  const nrmView = pushView(nrmBytes, 34962);
  const idxView = pushView(idxBytes, 34963);

  // POSITION accessors MUST carry min/max — loaders.gl builds the bounding
  // volume from them, and deck.gl sizes and culls the model with it. Omit
  // them and the truck can be culled off screen at some zooms only.
  accessors.push({
    bufferView: posView, componentType: 5126, count: positions.length / 3,
    type: 'VEC3', min, max,
  });
  accessors.push({
    bufferView: nrmView, componentType: 5126, count: normals.length / 3,
    type: 'VEC3',
  });
  accessors.push({
    bufferView: idxView, componentType: 5123, count: indices.length,
    type: 'SCALAR',
  });

  const a = accessors.length - 3;
  primitives.push({
    attributes: { POSITION: a, NORMAL: a + 1 },
    indices: a + 2,
    material,
  });
}

const buffer = Buffer.concat(chunks);

const gltf = {
  asset: { version: '2.0', generator: 'drishti gen_truck_gltf.mjs' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, name: 'truck' }],
  meshes: [{ name: 'truck', primitives }],
  materials: [
    {
      name: 'body',
      // Near-white and fairly rough: this surface is what getColor multiplies
      // against, so anything darker here would mute the semantic tint and
      // anything glossier would blow it out under the map's lighting.
      pbrMetallicRoughness: {
        baseColorFactor: [0.94, 0.94, 0.94, 1],
        metallicFactor: 0.05,
        roughnessFactor: 0.75,
      },
    },
    {
      name: 'glass',
      pbrMetallicRoughness: {
        baseColorFactor: [0.42, 0.52, 0.60, 1],
        metallicFactor: 0.35,
        roughnessFactor: 0.20,
      },
    },
    {
      name: 'tyre',
      pbrMetallicRoughness: {
        baseColorFactor: [0.13, 0.13, 0.14, 1],
        metallicFactor: 0.0,
        roughnessFactor: 0.95,
      },
    },
  ],
  bufferViews,
  accessors,
  // No `uri`: in a .glb the single buffer IS the binary chunk below.
  buffers: [{ byteLength: buffer.length }],
};

/**
 * Wrap the JSON and the geometry as a binary glTF container.
 *
 * Layout, per the glTF 2.0 spec:
 *
 *     header  magic 'glTF' | version 2 | total length      (12 bytes)
 *     chunk 0 length | type 'JSON' | JSON, space-padded
 *     chunk 1 length | type 'BIN'  | geometry, zero-padded
 *
 * Both chunks must be padded to a 4-byte boundary, and the padding byte
 * differs by chunk: JSON pads with 0x20 (space) so the text stays parseable,
 * BIN pads with 0x00. Padding JSON with zeros produces a file that most
 * loaders reject with a JSON syntax error at the very last character.
 */
function glb(json, bin) {
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = Buffer.alloc(pad4(jsonBytes.length) - jsonBytes.length, 0x20);
  const binPad = Buffer.alloc(pad4(bin.length) - bin.length, 0x00);

  const jsonChunk = Buffer.concat([jsonBytes, jsonPad]);
  const binChunk = Buffer.concat([bin, binPad]);

  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.write('JSON', 4, 'ascii');

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binChunk.length, 0);
  // 'BIN\0' — the trailing NUL is part of the four-character chunk type.
  binHeader.writeUInt32LE(0x004e4942, 4);

  return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]);
}

const out = glb(gltf, buffer);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, out);
console.log(
  `wrote ${OUT}\n`
  + `  ${BOXES.length} primitives, ${accessors.length} accessors, `
  + `${buffer.length} B geometry, ${out.length} B total`,
);
