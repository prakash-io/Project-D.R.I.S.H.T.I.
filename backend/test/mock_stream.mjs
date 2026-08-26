// Mock telemetry + a pending incident, for verifying the dashboard (WEB-03/05).
//
//     node test/mock_stream.mjs [--seconds 600]
//
// Drives two trucks along the real Guwahati -> Shillong route at 1 Hz: one
// reporting GNSS, one dead-reckoning with a growing covariance so the
// dashboard's uncertainty halo has something to draw. Also files one incident
// that lands in pending_dispatcher_approval, which is what the Incident Review
// panel exists to clear.
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { io } from 'socket.io-client';
import pg from 'pg';

const API = process.env.API_URL ?? 'http://localhost:4000';
const DB = process.env.DATABASE_URL ?? 'postgresql://drishti:drishti@localhost:5433/drishti';
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SECONDS = Number(process.argv.includes('--seconds')
  ? process.argv[process.argv.indexOf('--seconds') + 1] : 900);

const GUWAHATI = { lat: 26.1445, lng: 91.7362 };
const SHILLONG = { lat: 25.5788, lng: 91.8933 };
const pool = new pg.Pool({ connectionString: DB });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Route geometry from pgRouting, so the mock trucks drive on real roads
  // rather than along a straight line through the hills.
  const { rows } = await pool.query(
    `SELECT ST_AsGeoJSON(ST_LineMerge(ST_Collect(edge_geom))) AS geojson
     FROM route_astar(ST_SetSRID(ST_MakePoint($1,$2),4326),
                      ST_SetSRID(ST_MakePoint($3,$4),4326))`,
    [GUWAHATI.lng, GUWAHATI.lat, SHILLONG.lng, SHILLONG.lat]);
  const merged = JSON.parse(rows[0].geojson);
  const path_ = merged.type === 'LineString'
    ? merged.coordinates
    : merged.coordinates.flat();
  console.log(`route: ${path_.length} vertices`);

  const trucks = [];
  for (const [plate, mode] of [['AS01-DEMO-1', 'gps'], ['AS01-DEMO-2', 'ekf']]) {
    const { rows: [truck] } = await pool.query(
      `INSERT INTO trucks (plate, driver_name, alert_lang) VALUES ($1,$2,'as')
       ON CONFLICT (plate) DO UPDATE SET driver_name = EXCLUDED.driver_name
       RETURNING id`, [plate, `Demo ${mode.toUpperCase()}`]);
    trucks.push({ id: truck.id, plate, mode, index: mode === 'gps' ? 0 : 40 });
  }

  // An ACTIVE TRIP, so approving the incident has something to reroute.
  // Without one the approval still blocks the edge but reports "0 trucks
  // rerouted", which understates what the pipeline actually does.
  for (const truck of trucks) {
    await pool.query(`UPDATE trips SET status = 'completed'
                      WHERE truck_id = $1 AND status = 'active'`, [truck.id]);
    const response = await fetch(`${API}/trips`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ truck_id: truck.id, from: GUWAHATI, to: SHILLONG }),
    });
    const body = await response.json();
    console.log(`trip for ${truck.plate}: ${body.trip?.id?.slice(0, 8)} ` +
      `${(body.distance_m / 1000).toFixed(1)} km`);
  }

  await fileIncident(trucks[0].id, path_);

  const socket = io(API, { transports: ['websocket'] });
  await new Promise((resolve) => socket.on('connect', resolve));
  console.log('socket connected; streaming at 1 Hz — Ctrl-C to stop');

  for (let tick = 0; tick < SECONDS; tick += 1) {
    for (const truck of trucks) {
      const point = path_[truck.index % path_.length];
      truck.index += 3;   // ~3 vertices a second along the route

      const packet = {
        truck_id: truck.id,
        lat: point[1],
        lng: point[0],
        speed: truck.mode === 'gps' ? 16 + Math.sin(tick / 8) * 4 : 11,
        source: truck.mode,
        timestamp: new Date().toISOString(),
        client_uid: randomUUID(),
      };
      if (truck.mode === 'ekf') {
        // Grows the way a real blackout does, so the halo visibly widens.
        packet.covariance_m2 = 25 + (tick % 120) * 12;
        packet.map_matched = tick % 20 < 10;
      }
      socket.emit('truck_location_update', packet);
    }
    if (tick % 30 === 0) console.log(`  t=${tick}s`);
    await sleep(1000);
  }

  socket.close();
  await pool.end();
}

async function fileIncident(truckId, routePath) {
  const dir = path.join(ROOT, 'data/processed/vision/incident-cls/test/ACTIVE_LANDSLIDE_DEBRIS');
  const file = readdirSync(dir).find((f) => f.endsWith('.jpg'));
  const point = routePath[Math.floor(routePath.length / 2)];

  const form = new FormData();
  form.append('file', new Blob([readFileSync(path.join(dir, file))], { type: 'image/jpeg' }), file);
  form.append('lat', String(point[1]));
  form.append('lng', String(point[0]));
  form.append('truck_id', truckId);

  const response = await fetch(`${API}/incidents/report`, { method: 'POST', body: form });
  const body = await response.json();
  console.log(`incident ${body.incident?.id}: ${body.incident?.status} ` +
    `(${body.ai?.predicted_class} ${body.ai?.confidence?.toFixed(3)}) ` +
    `blocks_routing=${body.blocks_routing}`);
}

main().catch(async (error) => {
  console.error('mock stream failed:', error.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
