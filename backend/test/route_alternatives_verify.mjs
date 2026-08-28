// A reroute must go somewhere else, and an unreviewed report must not alarm
// the fleet (migration 011, workflow section 4).
//
//   npm run verify:alternatives          # API on :4000, PostGIS on :5433
//
// Both properties this asserts were broken together, and by the same absence:
// the platform only ever knew ONE path between two places.
//
//   A reroute that was not one. Blocking the edge a driver snapped to -- 104 m
//   of NH37 -- and replanning returned a path 99.6% identical to the one it
//   replaced. A* had left the highway at the landslide and rejoined it 7 m
//   later over the parallel carriageway. The driver was told "rerouted" and
//   sent through the hazard.
//
//   An alert that went everywhere. `incident_reported` was broadcast to every
//   connected socket, so one driver's photograph raised a full-screen ROAD
//   OBSTRUCTION AHEAD on every handset in the fleet -- before a dispatcher had
//   looked at it, and on trucks in other states. Nothing was blocked at that
//   point: routable_edges honours 'verified' alone.
//
// Three sockets are opened -- a dispatcher, the REPORTING driver and a
// BYSTANDER driver on the same corridor -- because the property under test is
// about WHO HEARS WHAT, and a test with one listener cannot see it.
import { io } from 'socket.io-client';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const API = process.env.API_URL ?? 'http://localhost:4000';
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
    ?? 'postgresql://drishti:drishti@localhost:5433/drishti' });

// Any valid JPEG. The vision model's verdict is irrelevant here -- what is
// asserted is that no verdict closes a road without a human, which is the
// same safety property incident_visibility_verify.mjs covers from the other
// side.
const HAZARD_PHOTO = path.join(
  path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hazard.jpg');

const REPORTER = '92763b27-6af4-43fc-9c0f-b546b4def9cb';   // AS01-E2E-425
const BYSTANDER = '907d7901-de08-448e-842e-00285c291977';  // AS01-E2E-69822
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
const ok = (m) => console.log(`    ok   ${m}`);
const bad = (m) => { fails += 1; console.log(`    FAIL ${m}`); };
const step = (m) => console.log(`\n== ${m}`);

function watcher(room) {
  const socket = io(API, { transports: ['websocket'] });
  const seen = { incidents: [], routes: [], trips: [] };
  socket.on('connect', () => socket.emit('subscribe', { room }));
  socket.on('incident_reported', (p) => seen.incidents.push(p));
  socket.on('route_updated', (p) => seen.routes.push(p));
  socket.on('trip_route', (p) => seen.trips.push(p));
  return { socket, seen, room };
}

async function main() {
  // Both trucks on the Guwahati -> Shillong corridor, so both are genuinely
  // "on the route" -- which is what makes the visibility test meaningful.
  step('planning two trips on the same corridor');
  const trips = {};
  for (const [label, id] of [['reporter', REPORTER], ['bystander', BYSTANDER]]) {
    const r = await fetch(`${API}/trips`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ truck_id: id,
        from: { lat: 26.1445, lng: 91.7362 }, to: { lat: 25.5788, lng: 91.8933 } }),
    }).then((x) => x.json());
    trips[label] = r;
    console.log(`    ${label}: ${(r.distance_m / 1000).toFixed(1)} km, `
      + `${r.alternatives.length} alternatives `
      + `[${r.alternatives.map((a) => (a.distance_m / 1000).toFixed(1)).join(', ')} km]`);
  }
  if (trips.reporter.alternatives.length >= 2) {
    ok(`the planner found ${trips.reporter.alternatives.length} distinct routes, not one`);
  } else {
    bad('only one route was found; alternatives are not working');
  }

  // Put both trucks on the road so the reroute plans from a real position.
  for (const id of [REPORTER, BYSTANDER]) {
    await pool.query(
      `INSERT INTO truck_last_seen (truck_id, geom, source, speed_mps, captured_at)
       VALUES ($1, ST_SetSRID(ST_MakePoint(91.7362, 26.1445), 4326), 'gps', 12, now())
       ON CONFLICT (truck_id) DO UPDATE SET geom = EXCLUDED.geom,
         captured_at = EXCLUDED.captured_at`, [id]);
  }

  const dispatcher = watcher('dispatchers');
  const reporter = watcher(`truck:${REPORTER}`);
  const bystander = watcher(`truck:${BYSTANDER}`);
  await sleep(600);

  // --------------------------------------------------------------------
  step('BUG 3 -- a driver uploads a hazard photo (nothing approved yet)');
  const form = new FormData();
  form.append('file', new Blob([readFileSync(HAZARD_PHOTO)], { type: 'image/jpeg' }),
    'hazard.jpg');
  // Mid-corridor, on the NH37 edge the investigation blocked by hand.
  const { rows: [pt] } = await pool.query(
    `SELECT ST_Y(ST_LineInterpolatePoint(geom,0.5)) lat,
            ST_X(ST_LineInterpolatePoint(geom,0.5)) lng
       FROM road_edges WHERE id = 150110`);
  form.append('lat', String(pt.lat));
  form.append('lng', String(pt.lng));
  form.append('kind', 'landslide');
  form.append('truck_id', REPORTER);

  const report = await fetch(`${API}/incidents/report`, { method: 'POST', body: form })
    .then((r) => r.json());
  const incidentId = report.incident?.id;
  console.log(`    incident ${incidentId} status=${report.incident?.status} `
    + `closes ${report.closure_edges} edges within ${report.closure_radius_m} m`);
  await sleep(1200);

  if (report.closure_edges > 1) ok(`the closure covers ${report.closure_edges} edges, not just the snapped one`);
  else bad(`the closure is only ${report.closure_edges} edge(s) -- A* will jog around it`);

  if (reporter.seen.incidents.length === 1) ok('the reporting driver was told their report landed');
  else bad(`the reporting driver saw ${reporter.seen.incidents.length} incident events, expected 1`);

  if (reporter.seen.incidents[0]?.scope === 'awaiting_approval') {
    ok("the reporter's card is scoped 'awaiting_approval', not a hazard warning");
  } else {
    bad(`reporter scope was ${reporter.seen.incidents[0]?.scope}`);
  }

  if (bystander.seen.incidents.length === 0) {
    ok('the OTHER driver on the same corridor was NOT alerted before approval');
  } else {
    bad(`the other driver got ${bystander.seen.incidents.length} alert(s) before any approval`);
  }

  if (dispatcher.seen.incidents.length === 1) ok('the dispatcher board received it for review');
  else bad(`dispatcher saw ${dispatcher.seen.incidents.length} incident events, expected 1`);

  const { rows: [blk] } = await pool.query(
    `SELECT count(*)::int n FROM routable_edges WHERE blocked`);
  if (blk.n === 0) ok('no edge is blocked while the report awaits a human');
  else bad(`${blk.n} edges blocked before approval`);

  // --------------------------------------------------------------------
  step('BUG 2 -- the dispatcher approves, and both drivers are rerouted');
  const before = await pool.query(
    `SELECT id, ST_Length(planned_route::geography) m, planned_route
       FROM trips WHERE id = ANY($1::uuid[])`,
    [[trips.reporter.trip.id, trips.bystander.trip.id]]);

  const startedAt = Date.now();
  const approval = await fetch(`${API}/incidents/${incidentId}/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approved_by: 'verify-script' }),
  }).then((r) => r.json());
  const approveMs = Date.now() - startedAt;
  console.log(`    approved in ${(approveMs / 1000).toFixed(1)}s: `
    + `closed ${approval.closed_edges} edges, `
    + `rerouted ${approval.reroutes.length} trip(s), `
    + `notified ${approval.notified_trucks.length} truck(s)`);

  // A latency assertion on a correctness test, because this endpoint has
  // already been ruined once by a change that kept every answer correct.
  //
  // Asking "which trucks does this closure affect" with the set of EVERY edge
  // closed anywhere -- rather than this incident's own closure -- made the
  // scan grow with the platform's whole incident history, and each edge in it
  // re-cast a 4,400-point route to geography per trip. The dispatcher's
  // approve click went to 203 seconds and returned exactly the same one trip.
  // Nothing failed; the console simply stopped responding, and it surfaced as
  // a UI test timing out rather than as a routing bug.
  //
  // 15 s is deliberately loose -- it is a wall against a return of the
  // quadratic scan, not a benchmark. This path legitimately runs one A* per
  // affected truck.
  if (approveMs < 15_000) ok(`approval returned in ${(approveMs / 1000).toFixed(1)}s`);
  else bad(`approval took ${(approveMs / 1000).toFixed(1)}s -- the affected-trip `
    + 'scan has gone quadratic again');

  await sleep(1500);

  for (const [label, trip] of [['reporter', trips.reporter], ['bystander', trips.bystander]]) {
    const { rows: [after] } = await pool.query(
      `SELECT ST_Length(planned_route::geography) m FROM trips WHERE id = $1`,
      [trip.trip.id]);
    const old = before.rows.find((r) => r.id === trip.trip.id);
    const { rows: [ov] } = await pool.query(
      `SELECT ST_Length(ST_Intersection(
                ST_Buffer($1::geography, 20)::geometry,
                (SELECT planned_route FROM trips WHERE id = $2))::geography) shared`,
      [old.planned_route, trip.trip.id]);
    const shared = Number(ov.shared) / Number(after.m);
    console.log(`    ${label}: ${(old.m / 1000).toFixed(1)} km -> `
      + `${(after.m / 1000).toFixed(1)} km, ${(shared * 100).toFixed(1)}% shared`);
    if (shared < 0.95) ok(`${label} was moved onto a genuinely different road`);
    else bad(`${label}'s "reroute" is ${(shared * 100).toFixed(1)}% the same road`);
  }

  const reroutedThrough = approval.reroutes.filter((r) => r.avoids_closure === false);
  if (reroutedThrough.length === 0) ok('every detour actually avoids the closure');
  else bad(`${reroutedThrough.length} detour(s) still run through the closed road`);

  // --------------------------------------------------------------------
  step('BUG 3 -- after approval the alert reaches the other driver too');
  if (bystander.seen.incidents.length >= 1) {
    ok('the other driver on the route was alerted once a human approved it');
  } else {
    bad('the other driver was never alerted, even after approval');
  }
  if (bystander.seen.incidents.at(-1)?.scope === 'verified') {
    ok("that alert is scoped 'verified' -- a real warning, not a receipt");
  } else {
    bad(`post-approval scope was ${bystander.seen.incidents.at(-1)?.scope}`);
  }
  if (bystander.seen.routes.length >= 1) ok('the other driver received a detour offer');
  else bad('the other driver got no detour');

  // --------------------------------------------------------------------
  step('cleanup');
  await fetch(`${API}/incidents/${incidentId}/clear`, { method: 'POST' });
  const { rows: [after] } = await pool.query(
    `SELECT count(*)::int n FROM routable_edges WHERE blocked`);
  if (after.n === 0) ok('clearing the incident restored every edge');
  else bad(`${after.n} edges still blocked after clear`);

  for (const w of [dispatcher, reporter, bystander]) w.socket.close();
  await pool.end();

  console.log(fails === 0 ? '\nALL CHECKS PASSED' : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
