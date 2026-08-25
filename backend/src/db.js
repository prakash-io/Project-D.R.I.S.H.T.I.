// One pool for the process. pg queues queries when every connection is busy,
// so a burst-sync batch cannot starve the telemetry socket of connections --
// it just waits its turn.
import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (error) => {
  // An idle client dropped by the server. Logged rather than thrown: pg
  // replaces it on the next checkout, and an unhandled 'error' here would
  // take the whole process down.
  console.error('[db] idle client error:', error.message);
});

export const query = (text, params) => pool.query(text, params);

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function healthcheck() {
  const { rows } = await query(`
    SELECT (SELECT count(*) FROM road_edges)  AS edges,
           (SELECT count(*) FROM road_nodes)  AS nodes,
           (SELECT count(*) FROM districts)   AS districts,
           (SELECT main_component FROM road_graph_meta WHERE only_row) AS main_component
  `);
  return rows[0];
}
