// End-to-end verification for Chunk 2 (API-01 .. API-04).
//
//   node test/e2e_verify.mjs
//
// Requires the stack up: postgis, redis, the API (npm start), the burst-sync
// worker (npm run worker) and the FastAPI service on :8000.
//
// Proves the whole reactive loop, in order:
//   1. a trip is planned with pgRouting
//   2. a mock telemetry packet crosses Socket.IO and is persisted
//   3. an offline backlog burst-syncs through BullMQ
//   4. a driver's photo is classified and does NOT block the road
//   5. a dispatcher approves it and pgRouting recalculates around it
//   6. clearing the incident restores the original route exactly
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { io as ioClient } from 'socket.io-client';
import pg from 'pg';

const API = process.env.API_URL ?? 'http://localhost:4000';
const DB = process.env.DATABASE_URL ?? 'postgresql://drishti:drishti@localhost:5433/drishti';
const ROOT = path.resolve(import.meta.dirname, '..', '..');

const pool = new pg.Pool({ connectionString: DB });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = 0;
const say = (msg) => console.log(`\n[${++step}] ${msg}`);
const ok = (msg) => console.log(`    ok  ${msg}`);

const GUWAHATI = { lat: 26.1445, lng: 91.7362 };
const SHILLONG = { lat: 25.5788, lng: 91.8933 };

async function api(method, url, body, isForm = false) {
  const options = { method };
  if (body && !isForm) {
    options.headers = { 'content-type': 'application/json' };
    options.body = JSON.stringify(body);
  } else if (body) {
    options.body = body;
  }
  const response = await fetch(`${API}${url}`, options);
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: response.status, body: json };
}

function landslidePhoto() {
  const dir = path.join(ROOT, 'data/processed/vision/incident-cls/test/ACTIVE_LANDSLIDE_DEBRIS');
  const file = readdirSync(dir).find((f) => f.endsWith('.jpg'));
  return { name: file, buffer: readFileSync(path.join(dir, file)) };
}

async function main() {
  const health = await api('GET', '/health');
  assert.equal(health.status, 200, 'API not healthy');
  console.log(`stack: ${health.body.graph.edges.toLocaleString()} edges, ` +
    `${health.body.graph.nodes.toLocaleString()} nodes, ` +
    `auto_block=${health.body.auto_block_on_ai_verdict}`);

  // ---------------------------------------------------------------- truck
  say('create a truck and plan a trip Guwahati -> Shillong');
  const plate = `AS01-E2E-${Date.now() % 100000}`;
  const { rows: [truck] } = await pool.query(
    `INSERT INTO trucks (plate, driver_name, alert_lang) VALUES ($1,'E2E Driver','as')
     RETURNING id`, [plate]);

  const trip = await api('POST', '/trips', { truck_id: truck.id, from: GUWAHATI, to: SHILLONG });
  assert.equal(trip.status, 201, `trip failed: ${JSON.stringify(trip.body)}`);
  const originalDistance = trip.body.distance_m;
  ok(`trip ${trip.body.trip.id} planned, ${(originalDistance / 1000).toFixed(1)} km`);

  // ------------------------------------------------------------ socket.io
  say('emit a mock telemetry packet over Socket.IO');
  const dispatcher = ioClient(API, { transports: ['websocket'] });
  const driver = ioClient(API, { transports: ['websocket'] });
  await Promise.all([
    new Promise((r) => dispatcher.on('connect', r)),
    new Promise((r) => driver.on('connect', r)),
  ]);
  dispatcher.emit('subscribe', { room: 'dispatchers' });
  driver.emit('subscribe', { room: `truck:${truck.id}` });
  await sleep(150);

  const seenOnDashboard = new Promise((resolve) =>
    dispatcher.once('truck_location_update', resolve));
  const routeUpdates = [];
  driver.on('route_updated', (payload) => routeUpdates.push(payload));

  const packet = {
    truck_id: truck.id, lat: 26.1445, lng: 91.7362,
    speed: 12.5, timestamp: new Date().toISOString(), client_uid: randomUUID(),
  };
  const ackd = await new Promise((resolve) =>
    driver.emit('truck_location_update', packet, resolve));
  assert.equal(ackd.ok, true, `telemetry rejected: ${ackd.error}`);
  const broadcastPacket = await seenOnDashboard;
  assert.equal(broadcastPacket.truck_id, truck.id);
  ok(`packet acked and broadcast to dispatchers (source=${broadcastPacket.source})`);

  const { rows: [seen] } = await pool.query(
    `SELECT ST_Y(geom) AS lat, ST_X(geom) AS lng, source FROM truck_last_seen WHERE truck_id=$1`,
    [truck.id]);
  assert.ok(Math.abs(seen.lat - packet.lat) < 1e-6, 'truck_last_seen not updated');
  ok(`persisted to truck_last_seen at ${seen.lat}, ${seen.lng}`);

  // ----------------------------------------------------------- burst sync
  say('burst-sync an offline backlog through BullMQ');
  const backlog = Array.from({ length: 250 }, (_, i) => ({
    lat: 26.1445 - i * 0.0002, lng: 91.7362 + i * 0.0002,
    speed: 9 + (i % 5), source: 'ekf', covariance_m2: 25 + i,
    map_matched: true, client_uid: randomUUID(),
    timestamp: new Date(Date.now() - (250 - i) * 1000).toISOString(),
  }));
  const queued = await api('POST', '/sync/telemetry', { truck_id: truck.id, points: backlog });
  assert.equal(queued.status, 202, `expected 202 Accepted, got ${queued.status}`);
  ok(`202 Accepted immediately, job ${queued.body.job_id} queued (${backlog.length} points)`);

  let jobResult = null;
  for (let i = 0; i < 60 && !jobResult; i += 1) {
    await sleep(500);
    const status = await api('GET', `/sync/jobs/${queued.body.job_id}`);
    if (status.body.state === 'completed') jobResult = status.body.result;
    if (status.body.state === 'failed') assert.fail(`job failed: ${status.body.failed_reason}`);
  }
  assert.ok(jobResult, 'burst-sync job never completed');
  assert.equal(jobResult.rejected.length, 0, `rejected: ${JSON.stringify(jobResult.rejected[0])}`);
  ok(`worker drained ${jobResult.written}/${jobResult.received} points`);

  const { rows: [stored] } = await pool.query(
    `SELECT count(*) FROM telemetry WHERE truck_id=$1 AND source='ekf'`, [truck.id]);
  ok(`${stored.count} dark-zone points now in telemetry`);

  // Replaying the same batch must write nothing new (client_uid is UNIQUE).
  const replay = await api('POST', '/sync/telemetry', { truck_id: truck.id, points: backlog });
  let replayResult = null;
  for (let i = 0; i < 60 && !replayResult; i += 1) {
    await sleep(500);
    const status = await api('GET', `/sync/jobs/${replay.body.job_id}`);
    if (status.body.state === 'completed') replayResult = status.body.result;
  }
  const { rows: [afterReplay] } = await pool.query(
    `SELECT count(*) FROM telemetry WHERE truck_id=$1 AND source='ekf'`, [truck.id]);
  assert.equal(afterReplay.count, stored.count, 'replay duplicated rows -- not idempotent');
  ok(`replayed the same batch: still ${afterReplay.count} rows, burst sync is idempotent`);

  // ------------------------------------------------------------ incident
  say('report a landslide on an edge the route actually uses');
  const { rows: [target] } = await pool.query(
    `WITH r AS (
        SELECT edge_id, seq FROM route_astar(
          ST_SetSRID(ST_MakePoint($1,$2),4326), ST_SetSRID(ST_MakePoint($3,$4),4326))
        ORDER BY seq)
     SELECT e.id, e.name, e.length_m,
            ST_Y(ST_LineInterpolatePoint(e.geom,0.5)) AS lat,
            ST_X(ST_LineInterpolatePoint(e.geom,0.5)) AS lng
     FROM r JOIN road_edges e ON e.id = r.edge_id
     WHERE r.seq = (SELECT max(seq)/2 FROM r) LIMIT 1`,
    [GUWAHATI.lng, GUWAHATI.lat, SHILLONG.lng, SHILLONG.lat]);
  ok(`targeting edge ${target.id} (${target.name ?? 'unnamed'}, ` +
     `${Number(target.length_m).toFixed(0)} m) at ${target.lat.toFixed(5)}, ${target.lng.toFixed(5)}`);

  const photo = landslidePhoto();
  const form = new FormData();
  form.append('file', new Blob([photo.buffer], { type: 'image/jpeg' }), photo.name);
  form.append('lat', String(target.lat));
  form.append('lng', String(target.lng));
  form.append('truck_id', truck.id);
  const report = await api('POST', '/incidents/report', form, true);
  assert.equal(report.status, 201, `report failed: ${JSON.stringify(report.body)}`);
  ok(`AI classified ${report.body.ai.predicted_class} ` +
     `(conf ${report.body.ai.confidence.toFixed(3)}) -> kind ${report.body.incident.kind}`);

  // The safety valve: a confident model verdict must NOT close a road.
  assert.equal(report.body.blocks_routing, false, 'AI verdict blocked routing without a human');
  assert.equal(report.body.awaiting_dispatcher, true);
  assert.equal(report.body.incident.status, 'pending_dispatcher_approval');
  ok('road NOT blocked -- incident is pending_dispatcher_approval (Q2 decision honoured)');

  const stillSame = await api('POST', '/routes/plan', { from: GUWAHATI, to: SHILLONG });
  assert.equal(stillSame.body.distance_m, originalDistance, 'route changed before approval');
  ok(`route unchanged at ${(stillSame.body.distance_m / 1000).toFixed(1)} km`);

  // ------------------------------------------------------------- approval
  say('dispatcher approves -> pgRouting must recalculate around the blocked edge');
  const approve = await api('POST', `/incidents/${report.body.incident.id}/approve`,
    { approved_by: 'e2e-dispatcher' });
  assert.equal(approve.status, 200, `approve failed: ${JSON.stringify(approve.body)}`);
  ok(`approved; ${approve.body.reroutes.length} active trip(s) rerouted`);

  const after = await api('POST', '/routes/plan', { from: GUWAHATI, to: SHILLONG });
  assert.notEqual(after.body.distance_m, originalDistance,
    'pgRouting returned the same route after the edge was blocked');
  // A detour must cost something but must not be absurd -- a 999999 cost
  // leaking into the total would show up here as a route tens of thousands
  // of km long, which is exactly what blocking-by-UPDATE used to cause.
  assert.ok(after.body.distance_m < originalDistance * 3,
    `detour is implausibly long (${after.body.distance_m} m) -- is the 999999 ` +
    'blocked cost leaking into the returned total?');
  const delta = after.body.distance_m - originalDistance;
  ok(`route recalculated: ${originalDistance.toFixed(0)} m -> ` +
     `${after.body.distance_m.toFixed(0)} m (${delta >= 0 ? '+' : ''}${delta.toFixed(0)} m ` +
     `detour around a ${Number(target.length_m).toFixed(0)} m edge)`);

  const { rows: usesBlocked } = await pool.query(
    `SELECT 1 FROM route_astar(ST_SetSRID(ST_MakePoint($1,$2),4326),
                               ST_SetSRID(ST_MakePoint($3,$4),4326))
     WHERE edge_id = $5`,
    [GUWAHATI.lng, GUWAHATI.lat, SHILLONG.lng, SHILLONG.lat, target.id]);
  assert.equal(usesBlocked.length, 0, 'the new route still traverses the blocked edge');
  ok(`blocked edge ${target.id} is no longer in the route`);

  await sleep(400);
  assert.ok(routeUpdates.length > 0, 'the driver never received a route_updated event');
  const ru = routeUpdates[0];
  assert.ok(ru.route_geom?.coordinates?.length >= 2,
    'route_updated carried no usable route_geom');
  assert.ok(Number.isFinite(ru.new_distance_m) && ru.new_distance_m > 0,
    'route_updated carried no new_distance_m');
  assert.ok(Number.isFinite(ru.estimated_time_sec) && ru.estimated_time_sec > 0,
    'route_updated carried no estimated_time_sec');
  assert.equal(ru.geometry, undefined,
    'the superseded `geometry` key is still being duplicated onto the payload');
  ok(`driver received route_updated over Socket.IO ` +
     `(${(ru.new_distance_m / 1000).toFixed(1)} km, ` +
     `${Math.round(ru.estimated_time_sec / 60)} min, ` +
     `${ru.route_geom.coordinates.length} pts)`);

  // -------------------------------------------------------------- restore
  say('clear the incident -> the original route returns with zero cost writes');
  const cleared = await api('POST', `/incidents/${report.body.incident.id}/clear`);
  assert.equal(cleared.status, 200);
  const restored = await api('POST', '/routes/plan', { from: GUWAHATI, to: SHILLONG });
  assert.equal(restored.body.distance_m, originalDistance,
    'clearing did not restore the original route');
  ok(`restored to ${(restored.body.distance_m / 1000).toFixed(1)} km exactly`);

  const { rows: [edgeRow] } = await pool.query(
    `SELECT cost, length_m FROM road_edges WHERE id=$1`, [target.id]);
  assert.ok(Math.abs(Number(edgeRow.cost) - Number(edgeRow.length_m)) < 1e-6,
    'road_edges.cost was mutated -- the 999999 must live in the view');
  ok('road_edges.cost never mutated -- the blocked cost lives in routable_edges');

  dispatcher.close();
  driver.close();
  await pool.query(`DELETE FROM trucks WHERE id=$1`, [truck.id]);
  await pool.end();

  console.log('\n============================================');
  console.log(' CHUNK 2 END-TO-END VERIFICATION PASSED');
  console.log('============================================');
}

main().catch(async (error) => {
  console.error('\nFAILED:', error.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
