// The dataset's named endpoints, compiled into the app.
//
// GET /routes/places is the authority: it reads the `corridors` table, so it
// reflects whatever the operator has actually seeded. But it is a network
// call, and the destination field is the FIRST thing a driver touches -- often
// before the handset has ever reached dispatch. On a clean install there is no
// cache to fall back to either, so a driver who opened "Choose source" saw an
// empty list and a sentence asking them to wait for a server they have no way
// to check. A navigator whose destination field can be empty is not a
// navigator.
//
// So these fourteen ship in the bundle. They are not decoration and not
// invented: they are exactly the origins and destinations of the ten seeded
// corridors in `backend/seed_corridors.mjs`, each of which was checked to
// route over `routable_edges` before it was added there. That is the property
// the picker depends on -- every row is provably reachable in this extract --
// and it is preserved here because the list is derived from the same source,
// not written by hand.
//
// The `id` derivation is the server's, character for character
// (`name.toLowerCase().replace(/[^a-z0-9]+/g, '-')`), which is what lets a
// bundled row and a fetched row be the same row: a selection made offline
// stays ticked when the real list arrives, and the union below dedupes
// cleanly instead of showing Guwahati twice.
//
// Kept in sync by `verify_places_seed.mjs`, which re-derives this list from
// the seeder and fails if the two have drifted. Add a corridor there and the
// check tells you to regenerate rather than letting the bundle rot.
export const BUNDLED_PLACES = [
  { id: 'agartala', name: 'Agartala', lat: 23.8315, lng: 91.2868 },
  { id: 'aizawl', name: 'Aizawl', lat: 23.7271, lng: 92.7176 },
  { id: 'dibrugarh', name: 'Dibrugarh', lat: 27.4728, lng: 94.912 },
  { id: 'dimapur', name: 'Dimapur', lat: 25.9063, lng: 93.7276 },
  { id: 'gangtok', name: 'Gangtok', lat: 27.3314, lng: 88.6138 },
  { id: 'guwahati', name: 'Guwahati', lat: 26.1445, lng: 91.7362 },
  { id: 'imphal', name: 'Imphal', lat: 24.817, lng: 93.9368 },
  { id: 'itanagar', name: 'Itanagar', lat: 27.0844, lng: 93.6053 },
  { id: 'kohima', name: 'Kohima', lat: 25.6751, lng: 94.1086 },
  { id: 'shillong', name: 'Shillong', lat: 25.5788, lng: 91.8933 },
  { id: 'silchar', name: 'Silchar', lat: 24.8333, lng: 92.7789 },
  { id: 'siliguri', name: 'Siliguri', lat: 26.7271, lng: 88.3953 },
  { id: 'tezpur', name: 'Tezpur', lat: 26.6338, lng: 92.7926 },
  { id: 'udaipur', name: 'Udaipur', lat: 23.5333, lng: 91.4833 },
];

/**
 * Merge a fetched (or cached) list over the bundled one, by id.
 *
 * The server wins on every field for an id it also carries, because it is the
 * one that knows the current seed -- if a corridor's endpoint moved, the
 * fetched coordinates are the right ones. Bundled rows the server did not
 * return are KEPT rather than dropped: the alternative is a picker that
 * shrinks when dispatch is half-reachable, and a town vanishing from the list
 * is a worse answer for the driver than a town that turns out to need a
 * replan.
 *
 * Sorted by name so the list reads the same whichever half of it loaded.
 */
export function mergePlaces(fetched) {
  const byId = new Map(BUNDLED_PLACES.map((p) => [p.id, p]));
  for (const place of fetched ?? []) {
    if (!place?.id || !Number.isFinite(place.lat) || !Number.isFinite(place.lng)) continue;
    byId.set(place.id, place);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}
