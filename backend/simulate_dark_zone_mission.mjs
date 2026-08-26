// Chunk 5 — the full dark-zone mission, end to end (workflow sections 1-4).
//
//   node simulate_dark_zone_mission.mjs
//
// Requires the stack up: postgis, redis, the API (npm start), the burst-sync
// worker (npm run worker) and the FastAPI service on :8000.
//
// This is not e2e_verify.mjs with more steps. That script proves each API
// contract in isolation with synthetic points; this one flies a single truck
// through one continuous mission and makes each phase depend on the real
// output of the one before it:
//
//   1. online   10 s of 1 Hz GNSS over Socket.IO, along a real OSM route
//   2. dark     60 s of 100 Hz IMU through the REAL C++ EKF + R*Tree matcher
//   3. incident the driver photographs a landslide with no network
//   4. burst    the C++ coordinate history syncs through BullMQ into PostGIS
//   5. reroute  the queued photo is verified, approved, and pgr_astar detours
//   6. notify   the driver's socket receives route_updated
//
// Phase 2 runs in a child process. Node cannot call the engine -- there is no
// N-API binding, only the flat C surface the JNI/ObjC++ shims use -- so the
// IMU stream is piped into test/edge/dark_zone_drive, which links the same
// DeadReckoning/MapMatcher/EdgeEngineApi translation units the handset does
// against the same shipped road_graph.sqlite.
//
// Honest about one mock: libtensorflowlite is an NDK/CocoaPods artefact and is
// not built on a laptop, so the 1D-CNN does NOT run. The speed measurement is
// injected with the model's own held-out error (RMSE 5.259 m/s, R = 27.66 from
// IMU_Constants.h). The EKF and the R*Tree map matching are real.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { io as ioClient } from 'socket.io-client';
import pg from 'pg';

const API = process.env.API_URL ?? 'http://localhost:4000';
const AI = process.env.AI_URL ?? 'http://localhost:8000';
const DB = process.env.DATABASE_URL ?? 'postgresql://drishti:drishti@localhost:5433/drishti';
const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..');
const GRAPH = path.join(ROOT, 'data/artifacts/edge/road_graph.sqlite');
const NATIVE = path.join(ROOT, 'mobile-app/native');
const DRIVE_SRC = path.join(HERE, 'test/edge/dark_zone_drive.cpp');
const DRIVE_BIN = path.join(HERE, 'test/edge/dark_zone_drive');
const EIGEN = process.env.EIGEN_INC ?? '/opt/homebrew/include/eigen3';

const GUWAHATI = { lat: 26.1445, lng: 91.7362 };
const SHILLONG = { lat: 25.5788, lng: 91.8933 };

const ONLINE_SECONDS = 10;
const DARK_SECONDS = 60;
const IMU_HZ = 100;
const MODEL_HZ = 10;              // kModelRateHz
const SPEED_RMSE = 5.259;         // sqrt(kSpeedMeasurementVariance)
const MATCH_EVERY_N = 50;         // mirrors Tracker.MAP_MATCH_EVERY_N_FIXES

const pool = new pg.Pool({ connectionString: DB });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let phase = 0;
const say = (msg) => console.log(`\n[${++phase}] ${msg}`);
const ok = (msg) => console.log(`    ok  ${msg}`);
const note = (msg) => console.log(`        ${msg}`);

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

/// Seeded so a failure is reproducible. A flaky mission test is worse than none.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rand) {
  // Box-Muller. u must be non-zero or log() diverges.
  const u = Math.max(rand(), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

function haversine(a, b) {
  const R = 6371008.8, toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad, dLng = (b.lng - a.lng) * toRad;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function buildDriveBinary() {
  if (existsSync(DRIVE_BIN)) return 'cached';
  execFileSync('c++', [
    '-std=c++17', '-O1', '-Wall', '-Wextra',
    '-I', NATIVE, '-isystem', EIGEN,
    DRIVE_SRC,
    path.join(NATIVE, 'DeadReckoning.cpp'),
    path.join(NATIVE, 'MapMatcher.cpp'),
    path.join(NATIVE, 'EdgeEngineApi.cpp'),
    '-lsqlite3', '-o', DRIVE_BIN,
  ], { stdio: 'pipe' });
  return 'compiled';
}

/**
 * Phase 2. Generate the IMU stream, push it through the C++ engine, collect
 * the dead-reckoned history.
 *
 * The sample distribution is taken from IMU_Constants.h's kFeatureMean /
 * kFeatureStd -- the statistics of the IO-VNBD data the model was trained on,
 * not invented numbers. Gravity sits on az at ~9.44 because that is what the
 * handset actually reports in a cradle.
 */
function driveDarkZone({ seed, seconds, startSpeed }) {
  const rand = rng(20260826);
  const lines = [];
  const samples = seconds * IMU_HZ;
  const everyNth = IMU_HZ / MODEL_HZ;

  for (let i = 0; i < samples; i += 1) {
    const t = seed.t0 + i / IMU_HZ;
    // A truck holding a road: near-zero lateral, gravity on Z, a slow drift
    // in yaw as the valley bends.
    const yawBias = 0.02 * Math.sin((i / samples) * Math.PI * 2);
    lines.push(
      `I ${(-0.0053 + 1.691 * gaussian(rand)).toFixed(5)} `
      + `${(-0.0504 + 1.557 * gaussian(rand)).toFixed(5)} `
      + `${(9.4408 + 0.853 * gaussian(rand)).toFixed(5)} `
      + `${(yawBias + 0.1125 * gaussian(rand)).toFixed(6)} `
      + `${(-0.0052 + 0.2299 * gaussian(rand)).toFixed(6)} `
      + `${(0.0004 + 0.137 * gaussian(rand)).toFixed(6)} `
      + `${t.toFixed(3)}`);

    // The weak speed measurement, at the model's rate. Noise is the model's
    // own RMSE: this is a stand-in for the CNN, not a better sensor.
    if (i % everyNth === 0) {
      lines.push(`S ${(startSpeed + SPEED_RMSE * gaussian(rand)).toFixed(4)}`);
    }
  }

  return new Promise((resolve, reject) => {
    const child = spawn(DRIVE_BIN, [
      GRAPH, String(seed.lat), String(seed.lng), String(seed.heading),
      String(startSpeed), String(seed.t0), String(MATCH_EVERY_N), '60.0',
    ]);
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`dark_zone_drive exited ${code}: ${err}`));
      const fixes = out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      resolve({ fixes, diagnostics: err.trim(), pushed: samples });
    });
    child.stdin.write(lines.join('\n') + '\n');
    child.stdin.end();
  });
}

async function main() {
  // ------------------------------------------------------------- preflight
  say('preflight — the mission needs every service live');
  const health = await api('GET', '/health');
  assert.equal(health.status, 200, 'backend not healthy on :4000');
  const aiRes = await fetch(`${AI}/health`);
  assert.equal(aiRes.status, 200, 'AI service not healthy on :8000');
  assert.equal(health.body.auto_block_on_ai_verdict, false,
    'AUTO_BLOCK_ON_AI_VERDICT must stay 0 -- a model verdict may not close a road');
  assert.ok(existsSync(GRAPH), `road graph missing at ${GRAPH}`);
  ok(`stack up: ${health.body.graph.edges.toLocaleString()} edges, `
     + `auto_block=${health.body.auto_block_on_ai_verdict}`);
  ok(`edge engine binary ${buildDriveBinary()}`);

  // -------------------------------------------------------- 1. the route
  say('plan a real OSM route and put a truck on it');
  const plate = `AS01-MSN-${Date.now() % 100000}`;
  const { rows: [truck] } = await pool.query(
    `INSERT INTO trucks (plate, driver_name, alert_lang) VALUES ($1,'Mission Driver','as')
     RETURNING id`, [plate]);

  const trip = await api('POST', '/trips',
    { truck_id: truck.id, from: GUWAHATI, to: SHILLONG });
  assert.equal(trip.status, 201, `trip failed: ${JSON.stringify(trip.body)}`);
  const originalDistance = trip.body.distance_m;
  ok(`trip ${trip.body.trip.id} planned, ${(originalDistance / 1000).toFixed(1)} km`);

  // The truck drives the first edges of its own planned route -- the online
  // phase must traverse the same geometry the reroute later has to avoid.
  const { rows: routePoints } = await pool.query(
    `WITH r AS (
       SELECT edge_id, seq FROM route_astar(
         ST_SetSRID(ST_MakePoint($1,$2),4326), ST_SetSRID(ST_MakePoint($3,$4),4326))
       ORDER BY seq)
     SELECT e.id, e.length_m,
            ST_Y(ST_LineInterpolatePoint(e.geom,0.5)) AS lat,
            ST_X(ST_LineInterpolatePoint(e.geom,0.5)) AS lng
     FROM r JOIN road_edges e ON e.id = r.edge_id
     WHERE r.seq <= $5 ORDER BY r.seq`,
    [GUWAHATI.lng, GUWAHATI.lat, SHILLONG.lng, SHILLONG.lat, ONLINE_SECONDS]);
  assert.ok(routePoints.length >= ONLINE_SECONDS, 'route too short to fly');
  ok(`first ${routePoints.length} route edges resolved for the online leg`);

  // ------------------------------------------------- 2. normal operation
  say(`normal operation — ${ONLINE_SECONDS} s of 1 Hz GNSS over Socket.IO`);
  const dispatcher = ioClient(API, { transports: ['websocket'] });
  const driver = ioClient(API, { transports: ['websocket'] });
  await Promise.all([
    new Promise((r) => dispatcher.on('connect', r)),
    new Promise((r) => driver.on('connect', r)),
  ]);
  dispatcher.emit('subscribe', { room: 'dispatchers' });
  driver.emit('subscribe', { room: `truck:${truck.id}` });
  await sleep(150);

  const broadcasts = [];
  dispatcher.on('truck_location_update', (p) => broadcasts.push(p));
  const routeUpdates = [];
  driver.on('route_updated', (p) => routeUpdates.push(p));

  let lastOnline = null;
  for (let i = 0; i < ONLINE_SECONDS; i += 1) {
    const point = routePoints[i];
    const packet = {
      truck_id: truck.id,
      lat: Number(point.lat), lng: Number(point.lng),
      speed: 12 + (i % 3),
      timestamp: new Date(Date.now() - (ONLINE_SECONDS - i) * 1000).toISOString(),
      client_uid: randomUUID(),
    };
    const ackd = await new Promise((resolve) =>
      driver.emit('truck_location_update', packet, resolve));
    assert.equal(ackd.ok, true, `GNSS packet ${i} rejected: ${ackd.error}`);
    lastOnline = packet;
  }
  await sleep(300);
  assert.equal(broadcasts.length, ONLINE_SECONDS,
    `dispatcher saw ${broadcasts.length}/${ONLINE_SECONDS} packets`);
  ok(`${ONLINE_SECONDS} GNSS packets acked and broadcast to dispatchers`);

  const { rows: [seen] } = await pool.query(
    `SELECT ST_Y(geom) AS lat, ST_X(geom) AS lng, source
     FROM truck_last_seen WHERE truck_id=$1`, [truck.id]);
  assert.equal(seen.source, 'gps', 'last seen source should be gps while online');
  assert.ok(Math.abs(seen.lat - lastOnline.lat) < 1e-6, 'truck_last_seen not at last fix');
  ok(`truck_last_seen at ${Number(seen.lat).toFixed(5)}, ${Number(seen.lng).toFixed(5)} (source=gps)`);

  // ------------------------------------------------------- 3. the dark zone
  say(`dark zone — ${DARK_SECONDS} s of ${IMU_HZ} Hz IMU through the C++ EKF + R*Tree`);
  note('socket telemetry stops here; nothing reaches the backend until burst sync');
  const seed = {
    lat: lastOnline.lat, lng: lastOnline.lng, heading: 135,
    t0: Math.floor(Date.now() / 1000) - DARK_SECONDS,
  };
  const drive = await driveDarkZone({ seed, seconds: DARK_SECONDS, startSpeed: 12 });
  const { fixes } = drive;

  note(drive.diagnostics.replace(/\n/g, ' | '));
  assert.ok(fixes.length > 0, 'the C++ engine emitted no fixes');
  // 100 Hz decimated to the model's 10 Hz: one fix per block, ~600 in 60 s.
  const expected = DARK_SECONDS * MODEL_HZ;
  assert.ok(Math.abs(fixes.length - expected) <= expected * 0.05,
    `expected ~${expected} fixes at ${MODEL_HZ} Hz, got ${fixes.length}`);
  ok(`${drive.pushed} IMU samples -> ${fixes.length} dead-reckoned fixes`);

  assert.ok(fixes.every((f) => Number.isFinite(f.lat) && Number.isFinite(f.lng)),
    'a fix went non-finite -- the filter diverged');
  assert.ok(fixes.every((f) => f.covariance_m2 > 0 && Number.isFinite(f.covariance_m2)),
    'covariance went non-positive or non-finite');
  ok('every fix is finite and every covariance is positive');

  const travelled = haversine(seed, fixes[fixes.length - 1]);
  // A truck at ~12 m/s covers ~720 m in 60 s. Allow generous slack for the
  // weak speed measurement, but catch a teleport.
  assert.ok(travelled > 50 && travelled < 12 * DARK_SECONDS * 3,
    `implausible dark-zone displacement: ${travelled.toFixed(0)} m`);
  ok(`travelled ${travelled.toFixed(0)} m from the last GNSS fix`);

  const matched = fixes.filter((f) => f.map_matched);
  assert.ok(matched.length > 0,
    'map matching never engaged -- the R*Tree is what bounds the drift');
  const edges = new Set(matched.map((f) => f.matched_edge_id).filter((id) => id !== 0));
  ok(`map matching engaged ${matched.length} times across ${edges.size} road edge(s)`);
  note(`final covariance ${fixes[fixes.length - 1].covariance_m2.toFixed(1)} m^2`);

  // -------------------------------------------- 4. the incident, offline
  say('the driver photographs a landslide — with no network');
  const photoDir = path.join(ROOT,
    'data/processed/vision/incident-cls/test/ACTIVE_LANDSLIDE_DEBRIS');
  const photoName = readdirSync(photoDir).find((f) => f.endsWith('.jpg'));
  assert.ok(photoName, 'no landslide photo in the vision test set');

  // The mock offline queue. On the handset this is WatermelonDB; here it is
  // an array, because what matters is that NOTHING is transmitted while the
  // link is down -- the report waits for reconnection like the coordinates do.
  const offlineQueue = [];

  // The hazard sits on the road AHEAD, not under the truck. A landslide the
  // driver photographs is by definition on the route they were going to take
  // -- and only an edge the route actually uses can produce a detour. An
  // earlier revision of this script reported at the dead-reckoned position,
  // which had map-matched onto 8 different edges while drifting off-route;
  // blocking one of those correctly rerouted nothing, and phase 8 failed.
  const { rows: [hazard] } = await pool.query(
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
  assert.ok(hazard, 'could not find a mid-route edge to place the hazard on');

  const lastDark = fixes[fixes.length - 1];
  offlineQueue.push({
    kind: 'incident_photo',
    file: path.join(photoDir, photoName),
    lat: Number(hazard.lat), lng: Number(hazard.lng),
    captured_at: new Date(lastDark.timestamp_s * 1000).toISOString(),
  });
  ok(`photo queued offline on route edge ${hazard.id} `
     + `(${hazard.name ?? 'unnamed'}, ${Number(hazard.length_m).toFixed(0)} m) at `
     + `${Number(hazard.lat).toFixed(5)}, ${Number(hazard.lng).toFixed(5)}`);
  note(`queue depth ${offlineQueue.length}; nothing transmitted while the link is down`);

  // ------------------------------------------------------- 5. burst sync
  say('network restored — burst-sync the C++ coordinate history');
  const points = fixes.map((f) => ({
    lat: f.lat, lng: f.lng,
    speed: f.speed_mps,
    heading: f.heading_deg,
    source: 'ekf',
    covariance_m2: f.covariance_m2,
    map_matched: f.map_matched,
    client_uid: randomUUID(),
    timestamp: new Date(f.timestamp_s * 1000).toISOString(),
  }));
  const queued = await api('POST', '/sync/telemetry', { truck_id: truck.id, points });
  assert.equal(queued.status, 202,
    `expected 202 Accepted, got ${queued.status}: ${JSON.stringify(queued.body)}`);
  ok(`202 Accepted immediately, job ${queued.body.job_id} queued (${points.length} points)`);

  let jobResult = null;
  for (let i = 0; i < 80 && !jobResult; i += 1) {
    await sleep(500);
    const status = await api('GET', `/sync/jobs/${queued.body.job_id}`);
    if (status.body.state === 'completed') jobResult = status.body.result;
    if (status.body.state === 'failed') assert.fail(`job failed: ${status.body.failed_reason}`);
  }
  assert.ok(jobResult,
    'burst-sync job never completed — is the worker running? (cd backend && npm run worker)');
  assert.equal(jobResult.rejected.length, 0,
    `worker rejected points: ${JSON.stringify(jobResult.rejected[0])}`);
  ok(`BullMQ drained ${jobResult.written}/${jobResult.received} points`);

  const { rows: [stored] } = await pool.query(
    `SELECT count(*)::int AS n FROM telemetry WHERE truck_id=$1 AND source='ekf'`,
    [truck.id]);
  assert.equal(stored.n, points.length,
    `PostGIS holds ${stored.n} ekf rows, expected ${points.length}`);
  ok(`${stored.n} dark-zone points committed to PostGIS`);

  // ---------------------------------------------- 6. verify and reroute
  say('drain the offline incident queue — AI verification, then a human');
  const job = offlineQueue.shift();
  const form = new FormData();
  form.append('file', new Blob([readFileSync(job.file)], { type: 'image/jpeg' }), photoName);
  form.append('lat', String(job.lat));
  form.append('lng', String(job.lng));
  form.append('truck_id', truck.id);
  const report = await api('POST', '/incidents/report', form, true);
  assert.equal(report.status, 201, `report failed: ${JSON.stringify(report.body)}`);
  assert.equal(offlineQueue.length, 0, 'offline queue did not drain');
  ok(`AI classified ${report.body.ai.predicted_class} `
     + `(conf ${report.body.ai.confidence.toFixed(3)}) -> kind ${report.body.incident.kind}`);

  // The safety valve. A confident model verdict must not close a road.
  assert.equal(report.body.blocks_routing, false,
    'the AI verdict blocked routing without a human');
  assert.equal(report.body.incident.status, 'pending_dispatcher_approval');
  const blockedEdge = report.body.incident.blocked_edge;
  ok(`road NOT blocked — status ${report.body.incident.status}, edge ${blockedEdge} targeted`);

  const stillOriginal = await api('POST', '/routes/plan', { from: GUWAHATI, to: SHILLONG });
  assert.equal(stillOriginal.body.distance_m, originalDistance,
    'the route changed before any human approved it');
  ok(`route unchanged at ${(originalDistance / 1000).toFixed(1)} km pending approval`);

  say('dispatcher approves — pgr_astar must detour');
  const approve = await api('POST', `/incidents/${report.body.incident.id}/approve`,
    { approved_by: 'mission-dispatcher' });
  assert.equal(approve.status, 200, `approve failed: ${JSON.stringify(approve.body)}`);
  ok(`approved; ${approve.body.reroutes.length} active trip(s) rerouted`);

  const after = await api('POST', '/routes/plan', { from: GUWAHATI, to: SHILLONG });
  assert.notEqual(after.body.distance_m, originalDistance,
    'pgr_astar returned the same route after the edge was blocked');
  assert.ok(after.body.distance_m < originalDistance * 3,
    `detour implausibly long (${after.body.distance_m} m) -- is the 999999 leaking?`);
  const delta = after.body.distance_m - originalDistance;
  ok(`route recalculated: ${originalDistance.toFixed(0)} m -> ${after.body.distance_m.toFixed(0)} m `
     + `(${delta >= 0 ? '+' : ''}${delta.toFixed(0)} m)`);

  const { rows: usesBlocked } = await pool.query(
    `SELECT 1 FROM route_astar(ST_SetSRID(ST_MakePoint($1,$2),4326),
                               ST_SetSRID(ST_MakePoint($3,$4),4326))
     WHERE edge_id = $5`,
    [GUWAHATI.lng, GUWAHATI.lat, SHILLONG.lng, SHILLONG.lat, blockedEdge]);
  assert.equal(usesBlocked.length, 0, 'the new route still traverses the blocked edge');
  ok(`blocked edge ${blockedEdge} is no longer in the route`);

  // ------------------------------------------------------ 7. notification
  say('the driver must be told');
  for (let i = 0; i < 20 && routeUpdates.length === 0; i += 1) await sleep(200);
  assert.ok(routeUpdates.length > 0, 'the driver never received route_updated');
  ok(`route_updated received over Socket.IO `
     + `(${(routeUpdates[0].distance_m / 1000).toFixed(1)} km)`);

  // --------------------------------------------------------- 8. restore
  // Not part of the mission, but a mission you cannot run twice is not a
  // regression test. Clearing also re-proves decision 6: the 999999 lives in
  // the routable_edges view, so restoring must be exact.
  say('restore — clear the incident and leave routing exactly as found');
  const cleared = await api('POST', `/incidents/${report.body.incident.id}/clear`);
  assert.equal(cleared.status, 200);
  const restored = await api('POST', '/routes/plan', { from: GUWAHATI, to: SHILLONG });
  assert.equal(restored.body.distance_m, originalDistance,
    'clearing did not restore the original route');
  ok(`restored to ${(restored.body.distance_m / 1000).toFixed(1)} km exactly`);

  const { rows: [edgeRow] } = await pool.query(
    `SELECT cost, length_m FROM road_edges WHERE id=$1`, [blockedEdge]);
  assert.ok(Math.abs(Number(edgeRow.cost) - Number(edgeRow.length_m)) < 1e-6,
    'road_edges.cost was mutated -- the 999999 must live in the view');
  ok('road_edges.cost never mutated');

  dispatcher.close();
  driver.close();
  await pool.query(`DELETE FROM trucks WHERE id=$1`, [truck.id]);
  await pool.end();

  console.log('\n================================================');
  console.log(' DARK ZONE MISSION PASSED — all phases asserted');
  console.log('================================================');
  console.log(` online   ${ONLINE_SECONDS} GNSS packets over Socket.IO`);
  console.log(` dark     ${drive.pushed} IMU samples -> ${fixes.length} EKF fixes, `
    + `${matched.length} map-matched`);
  console.log(` burst    ${jobResult.written} points through BullMQ into PostGIS`);
  console.log(` reroute  edge ${blockedEdge} blocked, ${delta >= 0 ? '+' : ''}${delta.toFixed(0)} m detour`);
  console.log(` notify   route_updated delivered to the driver`);
  console.log(' NOTE     the TFLite 1D-CNN did not run (no libtensorflowlite on a');
  console.log('          laptop); speed was injected at the model\'s own RMSE.');
  console.log('          The EKF and the R*Tree map matching were real.');
}

main().catch(async (error) => {
  console.error(`\nFAILED: ${error.message}`);
  await pool.end().catch(() => {});
  process.exit(1);
});
