// Load the road graph into a PostGIS that `docker exec psql` cannot reach --
// a hosted database, over its connection URL. Same SQL as the local load in
// scripts/ingest_geo.py, fed by that script's CSV:
//
//     ai-services/.venv/bin/python scripts/ingest_geo.py --csv-only --scratch scratch
//     DATABASE_URL=... node backend/load_road_edges.mjs scratch/road_edges.csv
//
// The CSV is staged BEFORE road_edges is touched, and the swap -- truncate,
// insert, nodes, components, meta -- is one transaction. A wrong path, a
// malformed row or a dropped connection leaves the graph that was there,
// rather than an empty road_edges (and, through CASCADE, an emptied incident
// history) that routing then reads as "every road is closed".
import fs from 'node:fs';
import pg from 'pg';
import copyFrom from 'pg-copy-streams';
import { pipeline } from 'node:stream/promises';

const dbUrl = process.env.DATABASE_URL;
const file = process.argv[2];

if (!dbUrl || !file) {
  console.error('Usage: DATABASE_URL=... node load_road_edges.mjs <csv_file>');
  process.exit(1);
}
// Checked before connecting: a read stream only reports a bad path once piped.
if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
  console.error(`[ingest] ${file} is missing or empty -- nothing was touched`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: dbUrl });

async function run() {
  await client.connect();
  console.log('[ingest] Connected to DB');
  await client.query('SET statement_timeout = 0;');

  await client.query(`
    DROP TABLE IF EXISTS stage_edges;
    CREATE UNLOGGED TABLE stage_edges (
        source BIGINT, target BIGINT, osm_id BIGINT, name TEXT,
        highway TEXT, surface TEXT, is_bridge BOOLEAN, is_tunnel BOOLEAN,
        geom GEOMETRY);
  `);
  console.log(`[ingest] Streaming ${file} to stage_edges...`);
  await pipeline(fs.createReadStream(file), client.query(copyFrom.from(
    'COPY stage_edges (source,target,osm_id,name,highway,surface,is_bridge,is_tunnel,geom) '
    + 'FROM STDIN WITH (FORMAT csv)')));

  const { rows: [staged] } = await client.query(
    'SELECT count(*)::int AS n FROM stage_edges WHERE ST_NPoints(geom) >= 2 AND NOT ST_IsEmpty(geom)');
  if (staged.n === 0) throw new Error(`${file} staged 0 routable edges`);
  console.log(`[ingest] Staged ${staged.n} edges. Swapping road_edges in one transaction...`);

  await client.query('BEGIN');
  await client.query('TRUNCATE road_edges RESTART IDENTITY CASCADE;');
  await client.query(`
    INSERT INTO road_edges
        (source, target, cost, reverse_cost, geom, name, osm_id,
         highway, surface, is_bridge, is_tunnel, length_m)
    SELECT source, target,
           ST_Length(geom::geography), ST_Length(geom::geography),
           ST_SetSRID(geom, 4326)::geometry(LineString, 4326),
           name, osm_id, highway, surface, is_bridge, is_tunnel,
           ST_Length(geom::geography)
    FROM stage_edges
    WHERE ST_NPoints(geom) >= 2 AND NOT ST_IsEmpty(geom);
  `);
  const { rows: rRows } = await client.query('SELECT count(*) FROM road_edges;');
  console.log(`[ingest] road_edges: ${rRows[0].count} rows`);

  const { rows: nRows } = await client.query('SELECT rebuild_road_nodes();');
  console.log(`[ingest] road_nodes: ${nRows[0].rebuild_road_nodes} rows`);

  const { rows: cRows } = await client.query(
    'SELECT components, largest_component, largest_nodes FROM rebuild_road_components();');
  await client.query('SELECT refresh_road_graph_meta();');
  await client.query('COMMIT');
  console.log(`[ingest] ${cRows[0].components} components; largest is `
    + `${cRows[0].largest_nodes} nodes, id ${cRows[0].largest_component}`);

  console.log('[ingest] Running ANALYZE...');
  await client.query('ANALYZE road_edges; ANALYZE road_nodes;');
  console.log('[ingest] DONE');
}

run()
  .catch(async (err) => {
    console.error('[ingest] Fatal:', err.message);
    // A no-op (with a warning) when no transaction is open.
    await client.query('ROLLBACK').catch(() => {});
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.query('DROP TABLE IF EXISTS stage_edges;').catch(() => {});
    await client.end().catch(() => {});
  });
