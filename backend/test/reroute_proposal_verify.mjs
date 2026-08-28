// Verification for the reroute PROPOSAL loop (workflow §4, driver side).
//
//   node test/reroute_proposal_verify.mjs
//
// Requires postgis and the API (npm start). The FastAPI service is optional:
// with it down the report is stored unclassified as 'pending', which this
// script approves exactly the same way -- the proposal path is what is under
// test here, not the vision model.
//
// What it proves, and why each step is worth a check:
//
//   1. a proposal carries what a DRIVER needs to decide, not just a geometry:
//      a reroute_id, both routes costed, and the deltas between them
//   2. DECLINING restores the superseded path, so the dashboard never shows a
//      truck on a road the driver refused
//   3. ACCEPTING keeps the new path and is idempotent, because a handset in a
//      valley will retry an answer it never saw acknowledged
//   4. answering twice with a DIFFERENT answer is a 409, not a silent
//      last-write-wins -- a truck cannot be on two routes
//   5. planning a second trip supersedes the first, so one landslide produces
//      one proposal per truck rather than one per route ever planned
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
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

/// A real landslide photograph when the dataset is present, a 1x1 JPEG when it
/// is not. The class the model returns does not matter here: both paths land
/// in a status the dispatcher can approve, which is all this script needs.
function photo() {
  const dir = path.join(ROOT, 'data/processed/vision/incident-cls/test/ACTIVE_LANDSLIDE_DEBRIS');
  if (existsSync(dir)) {
    const file = readdirSync(dir).find((f) => f.endsWith('.jpg'));
    if (file) return { name: file, buffer: readFileSync(path.join(dir, file)) };
  }
  return {
    name: 'synthetic.jpg',
    buffer: Buffer.from(
      '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
      + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
      + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64'),
  };
}

/// The mid-route edge, so the block is guaranteed to force a detour rather
/// than trimming an end the route barely touches.
async function midRouteEdge() {
  const { rows: [target] } = await pool.query(
    `WITH r AS (
        SELECT edge_id, seq FROM route_astar(
          ST_SetSRID(ST_MakePoint($1,$2),4326), ST_SetSRID(ST_MakePoint($3,$4),4326))
        ORDER BY seq)
     SELECT e.id,
            ST_Y(ST_LineInterpolatePoint(e.geom,0.5)) AS lat,
            ST_X(ST_LineInterpolatePoint(e.geom,0.5)) AS lng
     FROM r JOIN road_edges e ON e.id = r.edge_id
     WHERE r.seq = (SELECT max(seq)/2 FROM r) LIMIT 1`,
    [GUWAHATI.lng, GUWAHATI.lat, SHILLONG.lng, SHILLONG.lat]);
  return target;
}

/// Report a hazard on `target`, approve it, and return the proposal the truck
/// received over its own socket room.
async function provokeProposal(truckId, target, driver) {
  const image = photo();
  const form = new FormData();
  form.append('file', new Blob([image.buffer], { type: 'image/jpeg' }), image.name);
  form.append('lat', String(target.lat));
  form.append('lng', String(target.lng));
  form.append('truck_id', truckId);

  const proposals = [];
  const onRoute = (p) => proposals.push(p);
  driver.on('route_updated', onRoute);

  const report = await api('POST', '/incidents/report', form, true);
  assert.ok([201, 202].includes(report.status),
    `report failed: ${JSON.stringify(report.body)}`);
  const incidentId = report.body.incident.id;

  const approve = await api('POST', `/incidents/${incidentId}/approve`,
    { approved_by: 'proposal-verify' });
  assert.equal(approve.status, 200, `approve failed: ${JSON.stringify(approve.body)}`);

  for (let i = 0; i < 40 && proposals.length === 0; i += 1) await sleep(100);
  driver.off('route_updated', onRoute);
  return { incidentId, approve, proposal: proposals[0] };
}

async function tripRoute(tripId) {
  const { rows: [row] } = await pool.query(
    `SELECT ST_AsGeoJSON(planned_route) AS geom, planned_distance_m, planned_duration_sec
       FROM trips WHERE id = $1`, [tripId]);
  return row;
}

async function main() {
  const health = await api('GET', '/health');
  assert.equal(health.status, 200, 'API not healthy');
  console.log(`stack: ${health.body.graph.edges.toLocaleString()} edges, `
    + `auto_block=${health.body.auto_block_on_ai_verdict}`);
  assert.equal(health.body.auto_block_on_ai_verdict, false,
    'AUTO_BLOCK_ON_AI_VERDICT must stay 0');

  const plate = `AS01-PROP-${Date.now() % 100000}`;
  const { rows: [truck] } = await pool.query(
    `INSERT INTO trucks (plate, driver_name, alert_lang) VALUES ($1,'Proposal Driver','as')
     RETURNING id`, [plate]);
  const cleanup = [];

  try {
    // ---------------------------------------------------------- 1. places
    say('the driver picks two named ends the graph can actually reach');
    const places = await api('GET', '/routes/places');
    assert.equal(places.status, 200);
    assert.ok(places.body.places.length >= 2, 'no places to pick from');
    const named = new Set(places.body.places.map((p) => p.name));
    assert.ok(named.has('Guwahati') && named.has('Shillong'),
      'the seeded corridor ends are missing from /routes/places');
    ok(`${places.body.places.length} routable places offered `
       + `(${places.body.places.slice(0, 3).map((p) => p.name).join(', ')}…)`);

    // ----------------------------------------------------------- 2. trip
    say('plan the trip, and check it is costed at creation');
    const trip = await api('POST', '/trips',
      { truck_id: truck.id, from: GUWAHATI, to: SHILLONG });
    assert.equal(trip.status, 201, `trip failed: ${JSON.stringify(trip.body)}`);
    assert.ok(Number.isFinite(trip.body.estimated_time_sec) && trip.body.estimated_time_sec > 0,
      'POST /trips returned no ETA -- the route card would open empty');
    const originalDistance = trip.body.distance_m;
    ok(`${(originalDistance / 1000).toFixed(1)} km, `
       + `${Math.round(trip.body.estimated_time_sec / 60)} min at creation`);

    const driver = ioClient(API, { transports: ['websocket'] });
    cleanup.push(() => driver.close());
    await new Promise((r) => driver.on('connect', r));
    driver.emit('subscribe', { room: `truck:${truck.id}` });
    await sleep(150);

    // ------------------------------------------------------ 3. supersede
    say('planning again must supersede the first trip, not stack on it');
    const second = await api('POST', '/trips',
      { truck_id: truck.id, from: GUWAHATI, to: SHILLONG });
    assert.equal(second.status, 201);
    assert.equal(second.body.trip.superseded, 1, 'the previous trip was left active');
    const { rows: [{ count: activeCount }] } = await pool.query(
      `SELECT count(*) FROM trips WHERE truck_id = $1 AND status = 'active'`, [truck.id]);
    assert.equal(Number(activeCount), 1,
      `truck has ${activeCount} active trips -- one hazard would raise that many proposals`);
    const tripId = second.body.trip.id;
    ok('exactly one active trip after replanning');

    // -------------------------------------------------------- 4. propose
    say('a hazard mid-route must arrive as an OFFER, costed against the old road');
    const target = await midRouteEdge();
    const first = await provokeProposal(truck.id, target, driver);
    cleanup.push(() => api('POST', `/incidents/${first.incidentId}/clear`));
    assert.ok(first.proposal, 'the driver never received route_updated');

    const p = first.proposal;
    assert.ok(p.reroute_id, 'proposal carries no reroute_id -- it cannot be answered');
    assert.equal(p.requires_ack, true, 'proposal is not flagged as needing a tap');
    assert.ok(Array.isArray(p.route_geom?.coordinates) && p.route_geom.coordinates.length > 1,
      'proposal carries no usable geometry');
    assert.ok(Number.isFinite(p.new_distance_m), 'no new_distance_m');
    assert.ok(Number.isFinite(p.estimated_time_sec), 'no estimated_time_sec');
    assert.ok(Number.isFinite(p.previous_distance_m),
      'no previous_distance_m -- the driver has nothing to compare against');
    assert.ok(Number.isFinite(p.delta_distance_m), 'no delta_distance_m');
    // Both deltas, because the sheet quotes both and a null one silently
    // drops half the comparison the driver is deciding on.
    assert.ok(Number.isFinite(p.previous_time_sec),
      'no previous_time_sec -- the trip was not costed when it was created');
    assert.ok(Number.isFinite(p.delta_time_sec), 'no delta_time_sec');
    assert.ok(p.incident && 'kind' in p.incident,
      'proposal carries no incident -- the alert cannot name the hazard');
    // The join key. `route_updated` is the ONLY event carrying what a detour
    // costs, and `incident_reported` is the only one that opens the driver's
    // hazard card, so the handset has to match them up by this id -- see the
    // rerouteCost map in App.jsx. Without it the card cannot quote a delay or
    // an extra distance for the hazard it is describing, which is exactly the
    // state that shipped: both tiles showed an em-dash on every alert.
    assert.equal(p.incident.id, first.incidentId,
      'proposal does not name the incident that caused it -- the driver\'s '
      + 'alert cannot be joined to its detour figures');
    // The comparison has to be arithmetic the client can trust, because both
    // the handset and the dashboard render it and they must not disagree.
    assert.ok(Math.abs((p.previous_distance_m + p.delta_distance_m) - p.new_distance_m) < 1,
      'delta_distance_m does not reconcile the two distances');
    assert.equal(p.blocked_edge, Number(target.id), 'proposal names the wrong blocked edge');

    // The check that actually proves a detour happened. Distance is NOT it:
    // the mid-route edge is often one carriageway of a dual carriageway, so
    // routing around it costs single-digit metres and a delta assertion would
    // pass just as happily against a block that never took effect. What
    // matters is that the blocked edge is gone from the path.
    const { rows: [{ c: stillUses }] } = await pool.query(
      `SELECT count(*)::int AS c FROM route_astar(
          ST_SetSRID(ST_MakePoint($1,$2),4326),
          ST_SetSRID(ST_MakePoint($3,$4),4326)) WHERE edge_id = $5`,
      [GUWAHATI.lng, GUWAHATI.lat, SHILLONG.lng, SHILLONG.lat, target.id]);
    assert.equal(stillUses, 0, 'the proposed route still traverses the blocked edge');
    ok(`blocked edge ${target.id} is gone from the path`);

    ok(`offer: ${(p.new_distance_m / 1000).toFixed(1)} km `
       + `(${p.delta_distance_m >= 0 ? '+' : ''}${(p.delta_distance_m / 1000).toFixed(1)} km, `
       + `${p.delta_time_sec >= 0 ? '+' : ''}${Math.round(p.delta_time_sec / 60)} min) `
       + `because of ${p.incident.kind ?? 'an obstruction'}`);

    // -------------------------------------------------------- 5. decline
    say('declining must put the trip back on the road the driver chose');
    const detoured = await tripRoute(tripId);
    const declined = await api('POST', `/reroutes/${p.reroute_id}/ack`, { accepted: false });
    assert.equal(declined.status, 200, JSON.stringify(declined.body));
    assert.equal(declined.body.driver_response, 'declined');
    assert.equal(declined.body.route_restored, true, 'nothing was restored');

    const restored = await tripRoute(tripId);
    assert.notEqual(restored.geom, detoured.geom, 'the trip still holds the refused detour');
    assert.ok(Math.abs(Number(restored.planned_distance_m) - originalDistance) < 1,
      `restored trip measures ${restored.planned_distance_m} m, not the original `
      + `${originalDistance} m`);
    ok(`trip is back on the original ${(originalDistance / 1000).toFixed(1)} km route`);

    // ------------------------------------------------------- 6. conflict
    say('changing the answer afterwards must be refused, not silently applied');
    const flip = await api('POST', `/reroutes/${p.reroute_id}/ack`, { accepted: true });
    assert.equal(flip.status, 409, `expected 409, got ${flip.status}`);
    const repeat = await api('POST', `/reroutes/${p.reroute_id}/ack`, { accepted: false });
    assert.equal(repeat.status, 200, 'a retry of the same answer must be idempotent');
    assert.equal(repeat.body.duplicate, true);
    ok('409 on a changed answer, 200 + duplicate on a retried one');

    // --------------------------------------------------------- 7. accept
    say('accepting must keep the detour');
    await api('POST', `/incidents/${first.incidentId}/clear`);
    const target2 = await midRouteEdge();
    const secondRun = await provokeProposal(truck.id, target2, driver);
    cleanup.push(() => api('POST', `/incidents/${secondRun.incidentId}/clear`));
    assert.ok(secondRun.proposal, 'no second proposal arrived');

    const accepted = await api('POST', `/reroutes/${secondRun.proposal.reroute_id}/ack`,
      { accepted: true });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.driver_response, 'accepted');
    assert.equal(accepted.body.route_restored, false, 'accepting must not restore anything');

    const kept = await tripRoute(tripId);
    assert.ok(Math.abs(Number(kept.planned_distance_m)
      - secondRun.proposal.new_distance_m) < 1, 'the accepted detour was not kept');
    ok(`trip holds the accepted ${(secondRun.proposal.new_distance_m / 1000).toFixed(1)} km detour`);

    // -------------------------------------------------------- 8. restore
    say('clear the incident and leave routing exactly as found');
    for (const undo of cleanup) await undo();
    cleanup.length = 0;
    const after = await api('POST', '/routes/plan', { from: GUWAHATI, to: SHILLONG });
    assert.equal(after.body.distance_m, originalDistance,
      'clearing did not restore the original route');
    ok(`restored to ${(after.body.distance_m / 1000).toFixed(1)} km exactly`);

    console.log('\n  PASS  reroute proposals are offered, compared, refused and accepted\n');
  } finally {
    for (const undo of cleanup) {
      try { await undo(); } catch { /* best effort */ }
    }
    await pool.query(`DELETE FROM trucks WHERE id = $1`, [truck.id]).catch(() => {});
    await pool.end();
  }
}

main().catch((error) => {
  console.error('\n  FAIL ', error.message);
  process.exitCode = 1;
  process.exit(1);
});
