// A driver's report must always reach a human (Workflow 4, WEB-05).
//
//   node test/incident_visibility_verify.mjs
//
// Requires the API on :4000, PostGIS on :5433 and the FastAPI service on
// :8000. Set DATA_ROOT if the vision corpus lives outside this checkout --
// data/ is gitignored, so a worktree has the code but not the photographs.
//
// This exists because of a report that vanished. On 2026-08-27 a driver sent
// a hazard photo from the handset; it was stored, classified NORMAL_TERRAIN at
// 0.9999999, written as `rejected`, and never shown to anyone. The dispatcher
// queue asks for `pending_dispatcher_approval` alone, so the row was invisible
// on the board while the driver's app reported success and deleted the photo.
//
// That is the model deciding, by itself, that a driver was wrong -- which is
// the single thing INCIDENT_REQUIRE_REVIEW and AUTO_BLOCK_ON_AI_VERDICT=0
// exist to prevent. It is also the EXPECTED verdict rather than a rare one:
// both hazard classes were trained on satellite and aerial imagery, so a
// ground-level phone photo is out of distribution (CLAUDE.md, open Q8) and
// "nothing wrong here" is the confident answer for a real landslide.
//
// What is asserted here is the safety property, not the model's accuracy:
// whatever the model says, the report reaches the queue and no road closes
// without a person. The model may keep being wrong; it may not be final.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { io as ioClient } from 'socket.io-client';
import pg from 'pg';

const API = process.env.API_URL ?? 'http://localhost:4000';
const DB = process.env.DATABASE_URL ?? 'postgresql://drishti:drishti@localhost:5433/drishti';
const ROOT = process.env.DATA_ROOT ?? path.resolve(import.meta.dirname, '..', '..');

const pool = new pg.Pool({ connectionString: DB });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let step = 0;
let failures = 0;
const say = (msg) => console.log(`\n[${++step}] ${msg}`);
const ok = (msg) => console.log(`    ok  ${msg}`);
const bad = (msg) => { failures += 1; console.log(`    FAIL ${msg}`); };

// Somewhere with road under it: a report that snaps to nothing is a 422 and
// never reaches the part of the pipeline this file is about.
const ON_NH37 = { lat: 26.1445, lng: 91.7362 };

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

/**
 * An ordinary ground-level photograph -- the shape of thing a driver actually
 * sends, and the input the model is weakest on.
 *
 * Deliberately NOT a satellite landslide tile. A test that feeds the model the
 * imagery it was trained on proves only the happy path, and the happy path was
 * never what broke.
 */
function groundLevelPhoto() {
  const candidates = [
    path.join(ROOT, 'data/raw/vision/normal_terrain'),
    path.join(ROOT, 'data/processed/vision/incident-cls/test/NORMAL_TERRAIN'),
  ];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    const file = readdirSync(dir).find((f) => /\.(jpg|jpeg|png)$/i.test(f));
    if (file) return { name: file, buffer: readFileSync(path.join(dir, file)) };
  }
  throw new Error(
    `no ground-level photo found under ${candidates.join(' or ')} -- `
    + 'set DATA_ROOT to a checkout that has the vision corpus');
}

async function main() {
  const health = await api('GET', '/health');
  assert.equal(health.status, 200, 'API is not up');

  // The guardrails this whole file depends on. If auto-block is on, a model
  // verdict CAN close a road and the property under test does not hold.
  assert.equal(health.body.auto_block_on_ai_verdict, false,
    'AUTO_BLOCK_ON_AI_VERDICT must be 0 -- see CLAUDE.md decision 5');

  // ------------------------------------------------- the report
  say('a driver sends a ground-level photo the model will not call a hazard');

  const photo = groundLevelPhoto();
  const clientUid = randomUUID();
  const form = new FormData();
  form.append('file', new Blob([photo.buffer], { type: 'image/jpeg' }), photo.name);
  form.append('lat', String(ON_NH37.lat));
  form.append('lng', String(ON_NH37.lng));
  form.append('client_uid', clientUid);
  form.append('kind', 'landslide');   // what the DRIVER says it is

  // The dashboard learns about new reports over Socket.IO. A report that is
  // stored but never announced is invisible until a manual refresh, which on
  // a command centre board is the same as not arriving.
  //
  // JOINS `dispatchers`, exactly as the console does on connect. It did not
  // used to have to: `incident_reported` was emitted to every connected
  // socket, so any listener at all received it -- which is precisely the
  // defect that let one driver's unreviewed photograph raise a full-screen
  // hazard alert on every other handset in the fleet. Delivery is scoped by
  // room now, so a test client that never subscribes is modelling a client
  // that does not exist. The property asserted below is unchanged: the board
  // is told without a refresh.
  const socket = ioClient(API, { transports: ['websocket'] });
  const announced = [];
  socket.on('incident_reported', (p) => announced.push(p));
  await new Promise((resolve, reject) => {
    socket.once('connect', () => { socket.emit('subscribe', { room: 'dispatchers' }); resolve(); });
    socket.once('connect_error', reject);
    setTimeout(() => reject(new Error('socket never connected')), 5000);
  });
  // The join is a server-side effect of an event with no acknowledgement, so
  // it has to land before the report is filed or the emit races the room.
  await sleep(250);

  const report = await api('POST', '/incidents/report', form, true);
  assert.ok([201, 202].includes(report.status),
    `report rejected with HTTP ${report.status}: ${JSON.stringify(report.body).slice(0, 300)}`);

  const incident = report.body.incident;
  const verdict = report.body.ai ?? {};
  console.log(`    model said ${verdict.predicted_class ?? 'nothing (service down)'}`
    + (verdict.confidence != null ? ` @ ${(verdict.confidence * 100).toFixed(1)}%` : '')
    + ` -> status '${incident.status}'`);

  // ------------------------------------------------- the safety property
  say('it is waiting for a person, whatever the model thought');

  incident.status === 'pending_dispatcher_approval'
    ? ok(`stored as '${incident.status}'`)
    : bad(`stored as '${incident.status}' -- a model verdict must not be `
        + 'the final word on a driver report');

  report.body.awaiting_dispatcher === true
    ? ok('response tells the handset a human still has to look')
    : bad(`awaiting_dispatcher was ${report.body.awaiting_dispatcher}`);

  // The driver said landslide. Nothing may quietly downgrade that to the
  // generic fallback just because the model saw no debris.
  incident.kind === 'landslide'
    ? ok("the driver's own classification survived the model disagreeing")
    : bad(`kind became '${incident.kind}', losing what the driver reported`);

  say('it is on the dispatcher board');

  const queue = await api('GET', '/incidents?status=pending_dispatcher_approval');
  const listed = (queue.body.incidents ?? []).find((i) => i.id === incident.id);
  listed
    ? ok('listed in the review queue the dashboard polls')
    : bad('NOT in the review queue -- this is the report that vanished');

  // The dispatcher is being asked to close a highway on this evidence, so the
  // model's dissent has to be on the card, not merely in the database.
  if (listed) {
    'ai_class' in listed && 'confidence' in listed
      ? ok(`card carries the model verdict (${listed.ai_class ?? 'none'})`)
      : bad('queue row omits ai_class/confidence -- the dispatcher cannot '
          + 'see whether the model agreed');
    listed.model_agrees === false || listed.model_agrees === true
      ? ok(`card states agreement explicitly (model_agrees=${listed.model_agrees})`)
      : bad('queue row has no model_agrees flag to triage by');
  }

  await sleep(400);
  announced.some((p) => p.id === incident.id)
    ? ok('broadcast over Socket.IO, so the board updates without a refresh')
    : bad('no incident_reported broadcast -- the board would not know');

  // ------------------------------------------------- nothing closed
  say('and no road closed on the model\'s say-so');

  const { rows: [blocking] } = await pool.query(
    `SELECT count(*)::int AS n FROM incidents
      WHERE id = $1 AND status = 'verified'`, [incident.id]);
  blocking.n === 0
    ? ok('incident is not verified, so routable_edges still costs the edge normally')
    : bad('the edge was blocked without a dispatcher');

  const { rows: [blocked] } = await pool.query(
    `SELECT count(*)::int AS n FROM routable_edges WHERE cost >= 999999`);
  ok(`${blocked.n} edge(s) blocked platform-wide (unchanged by this report)`);

  // ------------------------------------------------- clean up after itself
  // Leaves the queue exactly as it was found. A verification that grows the
  // dispatcher's backlog by one every run trains people to ignore it.
  socket.close();
  await pool.query(`DELETE FROM incidents WHERE id = $1`, [incident.id]);

  console.log(failures === 0
    ? `\nincident visibility OK (${step} groups)`
    : `\nincident visibility FAILED (${failures})`);
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('\nincident visibility ERRORED:', error.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
