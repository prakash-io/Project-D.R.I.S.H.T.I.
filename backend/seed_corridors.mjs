// Plan the demonstration corridors over the real road graph and cache them.
//
// Idempotent: re-running replans every corridor and overwrites the cached
// geometry. That is the intended way to refresh after the graph changes --
// there is no separate "update" path to forget to run.
//
// Run with:  node seed_corridors.mjs
import { query, pool } from './src/db.js';
import { routeBetween } from './src/services/routing.js';

/**
 * The corridors themselves.
 *
 * Chosen to span the dataset's coverage rather than to cluster around one
 * city: Assam, Meghalaya, Sikkim/North Bengal, Nagaland, Manipur, Tripura,
 * Mizoram and Arunachal are all represented. Each pair was checked to
 * actually route over routable_edges before being added here -- a pretty name
 * with no path through the extract is worse than no corridor at all.
 */
const CORRIDORS = [
  ['ghy-shl', 'Guwahati → Shillong',   'Guwahati',  'Shillong',  26.1445, 91.7362, 25.5788, 91.8933],
  ['ghy-tez', 'Guwahati → Tezpur',     'Guwahati',  'Tezpur',    26.1445, 91.7362, 26.6338, 92.7926],
  ['slg-gtk', 'Siliguri → Gangtok',    'Siliguri',  'Gangtok',   26.7271, 88.3953, 27.3314, 88.6138],
  ['dmu-koh', 'Dimapur → Kohima',      'Dimapur',   'Kohima',    25.9063, 93.7276, 25.6751, 94.1086],
  ['agt-udp', 'Agartala → Udaipur',    'Agartala',  'Udaipur',   23.8315, 91.2868, 23.5333, 91.4833],
  ['imf-dmu', 'Imphal → Dimapur',      'Imphal',    'Dimapur',   24.8170, 93.9368, 25.9063, 93.7276],
  ['itn-ghy', 'Itanagar → Guwahati',   'Itanagar',  'Guwahati',  27.0844, 93.6053, 26.1445, 91.7362],
  ['sch-azl', 'Silchar → Aizawl',      'Silchar',   'Aizawl',    24.8333, 92.7789, 23.7271, 92.7176],
  ['ghy-dbr', 'Guwahati → Dibrugarh',  'Guwahati',  'Dibrugarh', 26.1445, 91.7362, 27.4728, 94.9120],
  ['shl-sch', 'Shillong → Silchar',    'Shillong',  'Silchar',   25.5788, 91.8933, 24.8333, 92.7789],
];

async function main() {
  console.log(`planning ${CORRIDORS.length} corridors over the real graph\n`);
  let failures = 0;

  for (const [i, c] of CORRIDORS.entries()) {
    const [id, name, oName, dName, oLat, oLng, dLat, dLng] = c;
    process.stdout.write(`  ${name.padEnd(24)}`);

    let route = null;
    try {
      route = await routeBetween({ lat: oLat, lng: oLng }, { lat: dLat, lng: dLng });
    } catch (error) {
      console.log(`FAILED  ${error.message}`);
      failures += 1;
    }

    // The definition row is written even when planning fails, so the corridor
    // is visibly present-but-unplanned rather than silently missing. A NULL
    // geometry is a signal to replan, not a corrupt row.
    await query(
      `INSERT INTO corridors
         (id, name, origin_name, destination_name, origin, destination,
          planned_route, distance_m, edge_count, planned_at, sort_order)
       VALUES ($1, $2, $3, $4,
               ST_SetSRID(ST_MakePoint($5, $6), 4326),
               ST_SetSRID(ST_MakePoint($7, $8), 4326),
               CASE WHEN $9::text IS NULL THEN NULL
                    ELSE ST_GeomFromGeoJSON($9) END,
               $10, $11, CASE WHEN $9::text IS NULL THEN NULL ELSE now() END, $12)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         origin = EXCLUDED.origin,
         destination = EXCLUDED.destination,
         planned_route = EXCLUDED.planned_route,
         distance_m = EXCLUDED.distance_m,
         edge_count = EXCLUDED.edge_count,
         planned_at = EXCLUDED.planned_at,
         sort_order = EXCLUDED.sort_order`,
      [id, name, oName, dName, oLng, oLat, dLng, dLat,
       route ? JSON.stringify(route.geometry) : null,
       route ? route.distanceM : null,
       route ? route.edges.length : null,
       i],
    );

    if (route) {
      console.log(`${(route.distanceM / 1000).toFixed(1).padStart(7)} km  `
        + `${String(route.edges.length).padStart(4)} edges  `
        + `${route.geometry.coordinates.length} pts`);
    }
  }

  const { rows } = await query(
    'SELECT count(*) AS total, count(planned_route) AS planned FROM corridors');
  console.log(`\n${rows[0].planned}/${rows[0].total} corridors planned`);
  await pool.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
