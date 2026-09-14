// The exact wire contract the driver client depends on, driven from Node.
//
//     node verify_handset_contract.mjs            # full loop, self-approving
//     node verify_handset_contract.mjs --wait     # stop before approval and
//                                                 # wait for a human to click
//                                                 # APPROVE REROUTE on the board
//
// WHAT THIS IS, AND WHAT IT IS NOT
// --------------------------------
// This is NOT the mobile app and must never be presented as one. It is the
// server-side half of the handset's contract, exercised over the same wire:
// the same POST /trips body that src/services/corridors.js sends, the same
// `truck_location_update` payload src/services/tracking.js emits, the same
// multipart POST /incidents/report that src/services/hazardSync.js builds, the
// same `subscribe` to `truck:<id>`, and the same `route_updated` the app's
// onRouteUpdated handler reads. It runs against the SAME truck the APK is
// built for (OD02-HANDSET), so a pass here means every failure left is on the
// device or the network between it and this laptop -- which is exactly the
// part a laptop cannot test.
//
// It is also the honest fallback if the phone will not join the venue wifi:
// the pipeline is real, only the sensor is a stand-in, which is the same
// claim src/services/simulatedDrive.js makes inside the app itself.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';
import pg from 'pg';

const API = process.env.API_URL ?? 'http://localhost:4000';
const DB = process.env.DATABASE_URL ?? 'postgresql://drishti:drishti@localhost:5433/drishti';
const ROOT = path.resolve(import.meta.dirname, '..');
const WAIT_FOR_HUMAN = process.argv.includes('--wait');

// The handset's truck, and the corridor the APK ships with (SIM_CORRIDOR).
// Both are build-time constants in mobile-app/.env; changing either there
// without changing it here breaks the demo silently.
const TRUCK_ID = process.env.TRUCK_ID ?? '651692e8-374b-401f-9b9f-e3ed86342ab5';
const CORRIDOR = process.env.SIM_CORRIDOR ?? 'ghy-shl';

const pool = new pg.Pool({ connectionString: DB });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = 0;
const say = (m) => console.log(`\n[${++step}] ${m}`);
const ok = (m) => console.log(`    ok  ${m}`);
const note = (m) => console.log(`        ${m}`);

async function api(method, url, body, isForm = false) {
  const options = { method };
  if (body && !isForm) {
    options.headers = { 'content-type': 'application/json' };
    options.body = JSON.stringify(body);
  } else if (body) options.body = body;
  const res = await fetch(`${API}${url}`, options);
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

async function main() {
  say('preflight');
  const health = await api('GET', '/health');
  assert.equal(health.status, 200, `backend not healthy at ${API}`);
  assert.equal(health.body.auto_block_on_ai_verdict, false,
    'AUTO_BLOCK_ON_AI_VERDICT must stay 0 -- a model may not close a road');
  const { rows: [truck] } = await pool.query(
    'SELECT id, plate FROM trucks WHERE id = $1', [TRUCK_ID]);
  assert.ok(truck, `the handset truck ${TRUCK_ID} is missing -- reseed it`);
  ok(`${health.body.graph.edges.toLocaleString()} edges, handset truck ${truck.plate}`);

  say(`open the trip the app opens (corridor ${CORRIDOR})`);
  const corridor = await api('GET', `/routes/corridors/${CORRIDOR}`);
  assert.equal(corridor.status, 200, `corridor ${CORRIDOR} not found`);
  const c = corridor.body.corridor ?? corridor.body;
  const trip = await api('POST', '/trips', {
    truck_id: TRUCK_ID,
    from: { lat: c.origin_lat, lng: c.origin_lng },
    to: { lat: c.destination_lat, lng: c.destination_lng },
  });
  assert.equal(trip.status, 201, `trip failed: ${JSON.stringify(trip.body)}`);
  const originalDistance = trip.body.distance_m;
  ok(`trip ${trip.body.trip.id.slice(0, 8)} — ${(originalDistance / 1000).toFixed(1)} km`);

  // The geometry the app would drive. Telemetry is emitted along it so the
  // truck is genuinely ON the road the hazard will close.
  const line = trip.body.geometry?.coordinates ?? [];
  assert.ok(line.length > 100, 'trip returned too little geometry to drive');

  say('connect the socket exactly as src/services/socket.js does');
  const socket = io(API, { transports: ['websocket'], reconnection: true });
  await new Promise((r) => socket.on('connect', r));
  socket.emit('subscribe', { room: `truck:${TRUCK_ID}` });
  const routeUpdates = [];
  socket.on('route_updated', (p) => routeUpdates.push(p));
  await sleep(200);
  ok(`connected, joined room truck:${TRUCK_ID.slice(0, 8)}…`);

  say('stream telemetry (the tracking.js payload, verbatim)');
  let last = null;
  for (let i = 0; i < 8; i += 1) {
    const point = line[Math.min(i * 12, line.length - 1)];
    const packet = {
      truck_id: TRUCK_ID,
      lat: point[1], lng: point[0],
      speed: 16.6,
      source: 'gps',
      timestamp: new Date().toISOString(),
      client_uid: randomUUID(),
    };
    const ack = await new Promise((r) => socket.emit('truck_location_update', packet, r));
    assert.equal(ack.ok, true, `packet ${i} rejected: ${ack.error}`);
    last = packet;
    await sleep(120);
  }
  const { rows: [seen] } = await pool.query(
    `SELECT ST_Y(geom) AS lat, source FROM truck_last_seen WHERE truck_id = $1`, [TRUCK_ID]);
  assert.ok(Math.abs(Number(seen.lat) - last.lat) < 1e-6, 'truck_last_seen not at last fix');
  ok(`8 fixes acked; truck_last_seen source=${seen.source} — the board is drawing this truck`);

  say('report a hazard (the hazardSync.js multipart, verbatim)');
  // ON the route, mid-corridor: only an edge the trip actually uses can
  // produce a detour. This mirrors where the driver would be standing.
  const { rows: [hazard] } = await pool.query(
    `WITH r AS (SELECT edge_id, seq FROM route_astar(
        ST_SetSRID(ST_MakePoint($1,$2),4326), ST_SetSRID(ST_MakePoint($3,$4),4326)) ORDER BY seq)
     SELECT e.id, e.name,
            ST_Y(ST_LineInterpolatePoint(e.geom,0.5)) AS lat,
            ST_X(ST_LineInterpolatePoint(e.geom,0.5)) AS lng
     FROM r JOIN road_edges e ON e.id = r.edge_id
     WHERE r.seq = (SELECT max(seq)/2 FROM r) LIMIT 1`,
    [c.origin_lng, c.origin_lat, c.destination_lng, c.destination_lat]);
  assert.ok(hazard, 'no mid-route edge to place the hazard on');

  const dir = path.join(ROOT, 'data/processed/vision/incident-cls/test/ACTIVE_LANDSLIDE_DEBRIS');
  const photo = readdirSync(dir).find((f) => f.endsWith('.jpg'));
  const form = new FormData();
  form.append('file', new Blob([readFileSync(path.join(dir, photo))],
    { type: 'image/jpeg' }), photo);
  form.append('lat', String(hazard.lat));
  form.append('lng', String(hazard.lng));
  form.append('kind', 'landslide');
  form.append('truck_id', TRUCK_ID);
  form.append('client_uid', randomUUID());
  const report = await api('POST', '/incidents/report', form, true);
  assert.equal(report.status, 201, `report failed: ${JSON.stringify(report.body)}`);
  assert.ok(report.body.ai?.predicted_class,
    'the AI service returned no class -- restart uvicorn and smoke-test it');
  ok(`AI: ${report.body.ai.predicted_class} @ ${report.body.ai.confidence.toFixed(3)}`);
  assert.equal(report.body.blocks_routing, false, 'a model verdict closed a road');
  assert.equal(report.body.incident.status, 'pending_dispatcher_approval');
  ok(`awaiting a human — ${report.body.closure_edges} edge(s) staged, nothing blocked yet`);

  const before = await api('POST', '/routes/plan',
    { from: { lat: c.origin_lat, lng: c.origin_lng },
      to: { lat: c.destination_lat, lng: c.destination_lng } });
  assert.equal(before.body.distance_m, originalDistance, 'route changed before approval');
  ok(`corridor still ${(originalDistance / 1000).toFixed(1)} km pending approval`);

  say('dispatcher approves');
  if (WAIT_FOR_HUMAN) {
    note('waiting for APPROVE REROUTE on the dashboard — up to 120 s');
    let approved = false;
    for (let i = 0; i < 240 && !approved; i += 1) {
      await sleep(500);
      const { rows: [row] } = await pool.query(
        'SELECT status FROM incidents WHERE id = $1', [report.body.incident.id]);
      approved = row?.status === 'verified';
    }
    assert.ok(approved, 'nobody approved it within 120 s');
    ok('approved from the dashboard by a human');
  } else {
    const approve = await api('POST', `/incidents/${report.body.incident.id}/approve`,
      { approved_by: 'handset-contract-check' });
    assert.equal(approve.status, 200, `approve failed: ${JSON.stringify(approve.body)}`);
    ok(`approved: ${approve.body.closed_edges} edge(s) closed, `
       + `${approve.body.reroutes.length} trip(s) rerouted`);
  }

  say('the phone must be told — route_updated on truck:<id>');
  for (let i = 0; i < 60 && routeUpdates.length === 0; i += 1) await sleep(250);
  assert.ok(routeUpdates.length > 0,
    'no route_updated reached the truck room -- the handset would never learn');
  const update = routeUpdates[0];

  // Everything App.jsx's onRouteUpdated reads. A missing key here is a phone
  // that receives the event and silently draws nothing, which is the failure
  // mode that is hardest to see on a stage.
  const coords = update.route_geom?.coordinates ?? update.geometry?.coordinates;
  assert.ok(Array.isArray(coords) && coords.length > 1,
    'route_updated carried no usable geometry (route_geom.coordinates)');
  assert.ok(Number.isFinite(update.new_distance_m ?? update.distance_m),
    'route_updated carried no distance for the banner');
  assert.equal(update.requires_ack, true, 'the detour arrived as an instruction, not an offer');
  assert.ok(update.reroute_id, 'no reroute_id -- the driver could not answer');
  assert.equal(update.avoids_closure, true, 'the detour does NOT avoid the closure');
  const newDistance = update.new_distance_m ?? update.distance_m;
  ok(`route_updated: ${(newDistance / 1000).toFixed(1)} km, `
     + `${update.delta_distance_m >= 0 ? '+' : ''}${(update.delta_distance_m / 1000).toFixed(1)} km, `
     + `reroute_id ${String(update.reroute_id).slice(0, 8)}…, requires_ack=true`);
  note(`the phone shows: "New route available" with ${(newDistance / 1000).toFixed(1)} km `
       + `and Accept reroute`);

  say('the driver accepts (POST /reroutes/:id/ack)');
  const ack = await api('POST', `/reroutes/${update.reroute_id}/ack`, { accepted: true });
  assert.equal(ack.status, 200, `ack failed: ${JSON.stringify(ack.body)}`);
  ok('detour accepted; the trip holds the new road');

  say('and the corridor really did move');
  const after = await api('POST', '/routes/plan',
    { from: { lat: c.origin_lat, lng: c.origin_lng },
      to: { lat: c.destination_lat, lng: c.destination_lng } });
  assert.notEqual(after.body.distance_m, originalDistance, 'the corridor did not change');
  const { rows: usesBlocked } = await pool.query(
    `SELECT 1 FROM route_astar(ST_SetSRID(ST_MakePoint($1,$2),4326),
                               ST_SetSRID(ST_MakePoint($3,$4),4326))
     WHERE edge_id = $5`,
    [c.origin_lng, c.origin_lat, c.destination_lng, c.destination_lat,
     report.body.incident.blocked_edge]);
  assert.equal(usesBlocked.length, 0, 'the new corridor still drives the blocked edge');
  ok(`${(originalDistance / 1000).toFixed(1)} km -> ${(after.body.distance_m / 1000).toFixed(1)} km, `
     + `blocked edge ${report.body.incident.blocked_edge} is gone from the path`);

  socket.close();
  await pool.end();
  console.log('\n============================================');
  console.log(' HANDSET CONTRACT OK — every wire the app uses');
  console.log('============================================');
  console.log(` incident   ${report.body.incident.id}`);
  console.log(` before     ${Math.round(originalDistance)} m`);
  console.log(` after      ${Math.round(after.body.distance_m)} m`);
  console.log(` delta      ${Math.round(after.body.distance_m - originalDistance)} m`);
  console.log(' NOTE       this drives the app\'s PROTOCOL, not the app. It says');
  console.log('            nothing about the handset, the APK or the wifi.');
}

main().catch(async (error) => {
  console.error(`\nFAILED: ${error.message}`);
  await pool.end().catch(() => {});
  process.exit(1);
});
