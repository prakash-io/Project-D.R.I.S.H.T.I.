// The bundled place list must stay the seeder's list.
//
// `src/services/places.seed.js` is what the destination picker falls back to
// when dispatch is unreachable, and its whole claim to correctness is that
// every row is an endpoint of a corridor in `backend/seed_corridors.mjs` --
// each of which was checked to route over `routable_edges` before it was
// added there. That claim is only true while the two files agree, and nothing
// enforces it at runtime: a corridor added to the seeder simply never appears
// on a handset that cannot reach the server, silently, which is the exact
// failure the bundle exists to prevent.
//
// So this compares them, and then exercises the merge the app actually
// performs. The seeder is read as TEXT rather than imported -- it pulls in
// `src/db.js` and would open a pool against a database this check has no
// business needing. places.seed.js is imported for real: it is deliberately
// free of React Native imports, which is what lets the one list the handset
// ships be the same object asserted on here rather than a regex's idea of it.
//
// Run with:  node verify_places_seed.mjs
import { readFileSync } from 'node:fs';
import { BUNDLED_PLACES, mergePlaces } from './src/services/places.seed.js';

const SEEDER = '../backend/seed_corridors.mjs';

/// The server's id derivation, copied exactly. If this drifts from
/// routing.js the bundled and fetched rows stop deduping and the driver sees
/// Guwahati twice.
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

function readSeeder() {
  const src = readFileSync(SEEDER, 'utf8');
  const block = src.match(/const CORRIDORS = \[([\s\S]*?)\n\];/);
  if (!block) throw new Error(`could not find the CORRIDORS literal in ${SEEDER}`);

  const byId = new Map();
  for (const [, row] of block[1].matchAll(/\[([^\]]+)\]/g)) {
    const cells = row.split(',').map((c) => c.trim().replace(/^'|'$/g, ''));
    const [, , originName, destinationName, oLat, oLng, dLat, dLng] = cells;
    for (const [name, lat, lng] of [
      [originName, oLat, oLng], [destinationName, dLat, dLng],
    ]) {
      const id = slug(name);
      const place = { id, name, lat: Number(lat), lng: Number(lng) };
      const seen = byId.get(id);
      // The server averages duplicate names in SQL, so two corridors that
      // disagree about where Guwahati is would produce a coordinate the
      // bundle cannot reproduce by copying either one. Catch it here.
      if (seen && (seen.lat !== place.lat || seen.lng !== place.lng)) {
        throw new Error(`${SEEDER} gives ${name} two different positions`);
      }
      byId.set(id, place);
    }
  }
  return byId;
}

const seeded = readSeeder();
const bundled = new Map(BUNDLED_PLACES.map((p) => [p.id, p]));

const problems = [];
for (const [id, place] of seeded) {
  const mine = bundled.get(id);
  if (!mine) { problems.push(`missing from the bundle: ${place.name}`); continue; }
  if (mine.name !== place.name) {
    problems.push(`${id}: bundle says "${mine.name}", seeder says "${place.name}"`);
  }
  if (mine.lat !== place.lat || mine.lng !== place.lng) {
    problems.push(`${place.name}: bundle has ${mine.lat},${mine.lng}`
      + ` but the seeder has ${place.lat},${place.lng}`);
  }
}
for (const [id, place] of bundled) {
  // A bundled row with no corridor behind it is the dangerous direction: it
  // is exactly the unverified destination the picker promises never to offer.
  if (!seeded.has(id)) {
    problems.push(`${place.name} is in the bundle but no corridor ends there`);
  }
}
// Sorted by name, because the picker renders them in array order when the
// server is unreachable and mergePlaces sorts only what it merges.
const names = [...bundled.values()].map((p) => p.name);
const sorted = [...names].sort((a, b) => a.localeCompare(b));
if (names.join('|') !== sorted.join('|')) {
  problems.push('the bundled list is not in name order');
}

// The merge the picker depends on. Each of these is a way the list could go
// wrong on the handset without any file having drifted.
const check = (label, condition) => {
  if (condition) { console.log(`  ok   ${label}`); return; }
  problems.push(label);
};

const server = [
  // A row the bundle also has, moved: the server is the one that knows the
  // current seed, so its coordinates must win.
  { id: 'shillong', name: 'Shillong', lat: 25.5, lng: 91.8 },
  // A town no corridor ended at when this bundle was built.
  { id: 'jorhat', name: 'Jorhat', lat: 26.7509, lng: 94.2037 },
];
const merged = mergePlaces(server);

check('a fetched place overrides the bundled one',
  merged.find((p) => p.id === 'shillong')?.lat === 25.5);
check('a place only the server knows is added',
  merged.some((p) => p.id === 'jorhat'));
check('bundled places the server omitted survive',
  merged.some((p) => p.id === 'gangtok'));
check('nothing appears twice',
  new Set(merged.map((p) => p.id)).size === merged.length);
check('the merged list is in name order',
  merged.map((p) => p.name).join('|')
    === [...merged.map((p) => p.name)].sort((a, b) => a.localeCompare(b)).join('|'));
check('a row with no usable position is dropped',
  !mergePlaces([{ id: 'broken', name: 'Broken', lat: null, lng: 91 }])
    .some((p) => p.id === 'broken'));
// The case in the bug report: dispatch unreachable, no cache, nothing fetched.
// listPlaces returns BUNDLED_PLACES directly on that path, so what matters is
// that the constant itself is never empty.
check('the fallback list is never empty',
  BUNDLED_PLACES.length > 0 && mergePlaces([]).length === BUNDLED_PLACES.length);
check('every bundled place carries a finite position',
  BUNDLED_PLACES.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)));

console.log(`\n${seeded.size} corridor endpoints, ${bundled.size} bundled place(s)`);
if (problems.length) {
  for (const p of problems) console.log(`  FAIL ${p}`);
  console.log(`\n${problems.length} drift(s) between the seeder and the bundle`);
  console.log('regenerate src/services/places.seed.js from backend/seed_corridors.mjs');
  process.exit(1);
}
console.log('the bundled place list matches the seeded corridors exactly');
