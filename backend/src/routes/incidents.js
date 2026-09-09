// Crowdsourced incident reporting and dispatcher approval (API-03, workflow §4).
import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { query, withTransaction } from '../db.js';
import { config } from '../config.js';
import { verifyIncident, AiServiceError } from '../services/aiClient.js';
import { snapToEdge, tripsUsingEdges, routeBetween, routeAlternatives,
         closureEdges, blockedEdgeIds, incidentClosureEdges } from '../services/routing.js';
import { emitTo, emitToMany, INCIDENT_EVENT, ROUTE_EVENT } from '../sockets/telemetry.js';
import { randomUUID } from 'node:crypto';

// In memory first: the buffer is forwarded to the AI service, then written to
// disk so WEB-05 can show it. 8 MB covers a phone camera JPEG with room to
// spare.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/// Mirrors the CHECK constraint on incidents.kind (migration 001).
const REPORTABLE_KINDS = new Set(['landslide', 'flood', 'obstruction']);

/**
 * Persist the driver's photo.
 *
 * A dispatcher is being asked to close a highway. Showing them only a class
 * name and a confidence would make the review a rubber stamp -- the photo IS
 * the evidence, and it is the whole reason the approval step exists.
 *
 * Stored under the incident's own uuid rather than the uploaded filename:
 * a client-supplied name is attacker-controlled and path traversal here would
 * write anywhere the process can reach.
 */
async function storePhoto(buffer, mimetype) {
  const extension = mimetype === 'image/png' ? 'png'
    : mimetype === 'image/webp' ? 'webp' : 'jpg';
  await fs.mkdir(config.uploadDir, { recursive: true });
  const name = `${randomUUID()}.${extension}`;
  await fs.writeFile(path.join(config.uploadDir, name), buffer);
  return name;
}

export const incidentsRouter = Router();

/**
 * POST /incidents/report   multipart: file, lat, lng, truck_id?
 *
 * Snap -> classify -> record. What it deliberately does NOT do is block the
 * road. The vision model has no "no incident" class (its NORMAL_TERRAIN
 * labels are filename arithmetic) and it was trained on satellite and aerial
 * imagery while this endpoint receives ground-level phone photos, so a
 * confident verdict is not sufficient evidence to close a highway. Reports
 * land in `pending_dispatcher_approval` and WEB-05 is the safety valve.
 */
incidentsRouter.post('/report', upload.single('file'), async (req, res, next) => {
  try {
    // Idempotency key from the device's queue. The column is uuid, so a
    // malformed value is rejected here rather than as a 500 from Postgres.
    const rawUid = req.body?.client_uid;
    const clientUid = typeof rawUid === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawUid)
      ? rawUid : null;
    if (rawUid != null && clientUid === null) {
      return res.status(400).json({ error: 'client_uid must be a uuid' });
    }

    // A replay of a report already stored. Answer with the original and skip
    // the snap and the model inference entirely: the device is retrying
    // because it never saw our response, not because anything changed.
    if (clientUid) {
      const existing = await findByClientUid(clientUid);
      if (existing) {
        return res.status(200).json({ incident: existing, duplicate: true });
      }
    }

    const lat = Number.parseFloat(req.body?.lat);
    const lng = Number.parseFloat(req.body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'lat and lng are required numbers' });
    }
    // What the driver says it is. Whitelisted against the table's own CHECK
    // constraint rather than passed through, so a bad value is a 400 here
    // instead of a 500 out of Postgres. Advisory only -- it never blocks a
    // road on its own, it just stops the driver's account of the hazard being
    // thrown away when the model cannot corroborate it.
    const rawKind = req.body?.kind;
    if (rawKind != null && !REPORTABLE_KINDS.has(rawKind)) {
      return res.status(400).json({
        error: `kind must be one of ${[...REPORTABLE_KINDS].join(', ')}`,
      });
    }
    const reportedKind = rawKind ?? null;

    if (!req.file) return res.status(400).json({ error: 'a photo file is required' });
    if (!ALLOWED_IMAGE_TYPES.has(req.file.mimetype)) {
      return res.status(415).json({
        error: `unsupported photo type ${req.file.mimetype}`,
        accepted: [...ALLOWED_IMAGE_TYPES],
      });
    }

    // Snap first: a report nowhere near a road is bad GPS, and there is no
    // point spending a model inference on it.
    const snap = await snapToEdge(lat, lng);
    if (!snap) {
      return res.status(422).json({
        error: `no road within ${config.incidentSnapMaxM} m of (${lat}, ${lng})`,
        hint: 'the report is probably a bad GPS fix; it was not recorded',
      });
    }

    // Stored before classification, so a report survives the AI service being
    // down -- the dispatcher can still look at the photo and decide.
    let photoPath = null;
    try {
      photoPath = await storePhoto(req.file.buffer, req.file.mimetype);
    } catch (error) {
      console.error('[incidents] could not store photo:', error.message);
    }

    let verdict;
    try {
      verdict = await verifyIncident(req.file.buffer, req.file.originalname, req.file.mimetype);
    } catch (error) {
      if (error instanceof AiServiceError) {
        // Record it anyway, unclassified. Losing a driver's landslide report
        // because a model was down is worse than a row that needs a human.
        //
        // Queued for a dispatcher, not parked in 'pending': the review panel
        // asks for `pending_dispatcher_approval` and nothing else, so a row
        // written under any other name is invisible on the board -- which is
        // indistinguishable, to everyone involved, from never having been
        // sent. An unclassified report needs a human MORE than a classified
        // one, not less.
        const pending = await insertIncident({
          lat, lng, truckId: req.body?.truck_id ?? null, edgeId: snap.edgeId,
          kind: reportedKind ?? 'obstruction', status: 'pending_dispatcher_approval',
          confidence: null, aiClass: null, aiReviewed: false, photoPath, clientUid,
        });
        await recordClosure(pending?.id, lat, lng);
        // ...and announced, to the board and to the driver who sent it. NOT
        // to the fleet -- see announceReport.
        announceReport(pending, req.body?.truck_id, {
          ai: { available: false, error: error.message },
          snapped_to_edge: snap.edgeId,
        });
        return res.status(202).json({
          incident: pending,
          snapped_to_edge: snap.edgeId,
          distance_m: snap.distanceM,
          ai: { available: false, error: error.message },
          awaiting_dispatcher: true,
          note: 'stored unclassified; the AI service was unreachable',
        });
      }
      throw error;
    }

    const blockable = verdict.verified && verdict.incident_kind;
    const needsHuman = verdict.requires_human_review !== false;

    // 'verified' is the only status routable_edges honours, so this single
    // choice decides whether a road closes.
    //
    // What it does NOT decide is whether a person ever sees the report. A
    // model that does not confirm a hazard sends the photo to the dispatcher
    // exactly as one that does; the difference is carried on the card, as
    // dissent for a human to weigh, and `rejected` is reserved for a verdict
    // a human actually reached.
    //
    // Auto-rejecting was a real defect and not a hypothetical one. Both hazard
    // classes were trained on satellite and aerial imagery while this endpoint
    // receives ground-level phone photos, so NORMAL_TERRAIN is the CONFIDENT,
    // EXPECTED answer for a genuine landslide (CLAUDE.md, open Q8). Treating
    // it as final meant the model quietly overruling the one participant who
    // was actually standing on the road -- and the handset, reading 201,
    // deleted its only copy of the photograph.
    let status = 'pending_dispatcher_approval';
    if (blockable && !needsHuman && config.autoBlockOnAiVerdict) {
      status = 'verified';
    }

    const incident = await insertIncident({
      lat, lng, truckId: req.body?.truck_id ?? null, edgeId: snap.edgeId,
      // The model's class when it found one, otherwise what the DRIVER called
      // it. Falling straight through to 'obstruction' discarded the only
      // first-hand account of the hazard on the strength of a verdict that
      // just said it could not see one.
      kind: verdict.incident_kind ?? reportedKind ?? 'obstruction',
      status, confidence: verdict.confidence ?? null,
      aiClass: verdict.predicted_class ?? null, aiReviewed: true, photoPath, clientUid,
    });

    // The road this report closes, worked out and stored NOW rather than at
    // approval. It costs 13 ms here, off the dispatcher's click, and it is
    // inert until the incident reaches 'verified' -- routable_edges reads
    // these rows only for a verified incident, so recording them changes no
    // route. What it buys is that approval is a status change and nothing
    // else, and that the closure a dispatcher approves is the one computed
    // from the geometry at the time of the report.
    const closure = await recordClosure(incident?.id, lat, lng);

    const affected = status === 'verified'
      ? await rerouteAffectedTrips(snap.edgeId, incident.id, incident) : [];

    announceReport(incident, req.body?.truck_id, {
      ai: verdict,
      snapped_to_edge: snap.edgeId,
      closed_edges: closure.length,
    }, affected);

    res.status(201).json({
      incident,
      snapped_to_edge: snap.edgeId,
      distance_m: snap.distanceM,
      // How much road this closes if a dispatcher approves it. Surfaced so
      // the review panel can say "closes 7 segments of NH37" rather than
      // implying a single point on the map.
      closure_edges: closure.length,
      closure_radius_m: config.closureRadiusM,
      ai: verdict,
      blocks_routing: status === 'verified',
      awaiting_dispatcher: status === 'pending_dispatcher_approval',
      reroutes: affected,
    });
  } catch (error) {
    next(error);
  }
});

/** GET /incidents?status=... -- the WEB-05 review queue. */
incidentsRouter.get('/', async (req, res, next) => {
  try {
    const status = req.query.status ?? null;
    const { rows } = await query(
      `SELECT id, kind, status, confidence, ai_class, ai_reviewed, blocked_edge,
              photo_path IS NOT NULL AS has_photo,
              -- Did the model back the driver up? Computed here so the panel
              -- and any other client cannot disagree about what counts as
              -- agreement. NULL means the model never ran at all, which is a
              -- third state and must not read as "it said no".
              CASE WHEN NOT ai_reviewed THEN NULL
                   ELSE (ai_class IS NOT NULL AND ai_class <> 'NORMAL_TERRAIN')
              END AS model_agrees,
              ST_Y(geom) AS lat, ST_X(geom) AS lng, reported_at, verified_at,
              approved_by, approved_at
       FROM incidents
       WHERE ($1::text IS NULL OR status = $1)
       ORDER BY reported_at DESC LIMIT 200`,
      [status],
    );
    res.json({ incidents: rows });
  } catch (error) { next(error); }
});

/**
 * GET /incidents/:id/photo -- the evidence WEB-05 shows the dispatcher.
 *
 * Streamed from disk by the incident's uuid. The stored filename is generated
 * server-side, never taken from the upload, so there is no path the client
 * can influence.
 */
incidentsRouter.get('/:id/photo', async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT photo_path FROM incidents WHERE id = $1`,
      [req.params.id]);
    if (rows.length === 0 || !rows[0].photo_path) {
      return res.status(404).json({ error: 'no photo for that incident' });
    }
    const stored = path.basename(rows[0].photo_path);
    const full = path.join(config.uploadDir, stored);
    res.type(path.extname(stored) || '.jpg');
    // Immutable: an incident photo never changes, so a dispatcher scrolling
    // the queue should not re-fetch it.
    res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
    return createReadStream(full)
      .on('error', () => res.status(404).json({ error: 'photo file is missing on disk' }))
      .pipe(res);
  } catch (error) { return next(error); }
});

/**
 * POST /incidents/:id/approve   { approved_by }
 *
 * The load-bearing step. Promoting to 'verified' is what makes
 * routable_edges cost the edge 999999, so this is the moment a road closes.
 */
incidentsRouter.post('/:id/approve', async (req, res, next) => {
  try {
    const { rows } = await query(
      `UPDATE incidents
       SET status = 'verified', verified_at = now(),
           approved_by = $2, approved_at = now()
       WHERE id = $1 AND status IN ('pending', 'pending_dispatcher_approval')
       RETURNING id, kind, status, blocked_edge,
                 ST_Y(geom) AS lat, ST_X(geom) AS lng`,
      [req.params.id, req.body?.approved_by ?? 'dispatcher'],
    );
    if (rows.length === 0) {
      return res.status(409).json({ error: 'no incident awaiting approval with that id' });
    }
    const incident = rows[0];
    // Rerouted BEFORE the alert goes out, deliberately. rerouteAffectedTrips
    // is what discovers which trucks are on this road, and it is also what
    // costs each detour -- so doing it first means the alert can be addressed
    // to exactly those drivers and can carry "+11.4 km, +18 min" with it,
    // instead of a card that says COSTING… until a second event lands.
    const reroutes = await rerouteAffectedTrips(incident.blocked_edge, incident.id, incident);

    // NOW it is a fleet event, and this is the moment it becomes one. Until a
    // dispatcher approved it, this hazard was one driver's photograph.
    //
    // Still not a broadcast: it goes to the dispatchers, to every driver whose
    // route crosses the closure, and to whoever reported it. A truck on the
    // Silchar-Aizawl corridor has no business being told about a landslide
    // outside Guwahati, and telling it anyway is how a driver learns to
    // dismiss these without reading them.
    const reporter = await reporterOf(incident.id);
    announceVerified(incident, reroutes, reporter);

    res.json({
      incident,
      blocks_routing: true,
      reroutes,
      // What the approval actually closed. The dispatcher pressed a button
      // that shuts a road; the response should say how much road.
      closed_edges: await closureSize(incident.id),
      notified_trucks: notifiedTruckIds(reroutes, reporter),
    });
  } catch (error) { next(error); }
});

/** POST /incidents/:id/reject -- the dispatcher disagrees with the model. */
incidentsRouter.post('/:id/reject', async (req, res, next) => {
  try {
    const { rows } = await query(
      `UPDATE incidents SET status = 'rejected', approved_by = $2, approved_at = now()
       WHERE id = $1 AND status <> 'cleared'
       RETURNING id, status`,
      [req.params.id, req.body?.approved_by ?? 'dispatcher'],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'no such incident' });
    res.json({ incident: rows[0] });
  } catch (error) { next(error); }
});

/**
 * POST /incidents/:id/clear -- the road is open again.
 *
 * Zero writes to road_edges: the blocked cost lives in a view, so clearing
 * the incident restores the original routing exactly.
 */
incidentsRouter.post('/:id/clear', async (req, res, next) => {
  try {
    const { rows } = await query(
      `UPDATE incidents SET status = 'cleared' WHERE id = $1
       RETURNING id, status, blocked_edge`,
      [req.params.id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'no such incident' });
    res.json({ incident: rows[0], blocks_routing: false });
  } catch (error) { next(error); }
});

async function insertIncident({ lat, lng, truckId, edgeId, kind, status, confidence,
                                aiClass, aiReviewed, photoPath, clientUid }) {
  const { rows } = await query(
    `INSERT INTO incidents (reported_by, geom, kind, status, confidence,
                            blocked_edge, ai_class, ai_reviewed, photo_path, verified_at,
                            client_uid)
     VALUES ($1, ST_SetSRID(ST_MakePoint($3, $2), 4326), $4, $5, $6, $7, $8, $9, $10,
             CASE WHEN $5 = 'verified' THEN now() END, $11)
     ON CONFLICT (client_uid) WHERE client_uid IS NOT NULL DO NOTHING
     RETURNING id, kind, status, confidence, ai_class, blocked_edge, photo_path,
               ST_Y(geom) AS lat, ST_X(geom) AS lng, reported_at, client_uid`,
    [truckId, lat, lng, kind, status, confidence, edgeId, aiClass, aiReviewed,
     photoPath ?? null, clientUid ?? null],
  );
  // DO NOTHING returns no row: the device is replaying a report we already
  // have. Hand back the original so the client can drop it from its queue.
  return rows[0] ?? (clientUid ? await findByClientUid(clientUid) : null);
}

/**
 * Store the stretch of road this report closes (migration 011).
 *
 * Returns the rows written, which is also the answer to "how much road".
 * Never throws into the request: the incident itself is already recorded and
 * a dispatcher can still see the photograph, so a closure that could not be
 * computed degrades to the anchor edge alone -- the old behaviour -- rather
 * than losing the report.
 */
async function recordClosure(incidentId, lat, lng) {
  if (!incidentId) return [];
  try {
    const edges = await closureEdges(lat, lng, config.closureRadiusM);
    if (edges.length === 0) return [];
    await query(
      `INSERT INTO incident_blocked_edges (incident_id, edge_id, distance_m)
       SELECT $1, unnest($2::bigint[]), unnest($3::float8[])
       ON CONFLICT (incident_id, edge_id) DO NOTHING`,
      [incidentId, edges.map((e) => e.edgeId), edges.map((e) => e.distanceM)],
    );
    return edges;
  } catch (error) {
    console.error('[incidents] could not record the closure:', error.message);
    return [];
  }
}

async function closureSize(incidentId) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM incident_blocked_edges WHERE incident_id = $1`,
    [incidentId]);
  return rows[0]?.n ?? 0;
}

/// Which truck sent this report, so the approval can reach that driver even
/// when the closure does not sit on their own route.
async function reporterOf(incidentId) {
  const { rows } = await query(
    `SELECT reported_by FROM incidents WHERE id = $1`, [incidentId]);
  return rows[0]?.reported_by ?? null;
}

const truckRoom = (truckId) => (truckId ? `truck:${truckId}` : null);

function notifiedTruckIds(reroutes, reporter) {
  return [...new Set([
    ...(reroutes ?? []).map((r) => r.truck_id),
    reporter,
  ].filter(Boolean))];
}

/**
 * Announce a NEW report: to the board, and to the driver who sent it.
 *
 * This is the fix for a report that alarmed the whole fleet. `incident_
 * reported` used to be broadcast to every connected socket, so the moment any
 * driver uploaded a photograph, every other handset raised a full-screen ROAD
 * OBSTRUCTION AHEAD modal reading "Reported by dispatch on your route" -- for
 * a hazard no dispatcher had looked at yet, on trucks that were not on that
 * road, and in some cases in another state. Nothing had been verified and
 * nothing was blocking anything: routable_edges honours 'verified' alone, so
 * not one of those routes had changed.
 *
 * Two audiences, and only two:
 *
 *   dispatchers -- this is their review queue, and it must appear without a
 *   page reload. WEB-05 is the safety valve; a valve nobody is shown is not
 *   one.
 *
 *   the reporting driver -- so the report visibly lands. They stopped on a
 *   mountain road and photographed a landslide; silence afterwards is how a
 *   driver learns not to bother. `awaiting_approval` tells their client this
 *   is a receipt and not a hazard warning, so the app can say "sent to
 *   dispatch" rather than warning them about the slide they are looking at.
 *
 * Every other driver hears about it if and when a human approves it.
 */
function announceReport(incident, reporterTruckId, extra = {}, reroutes = []) {
  if (!incident) return;
  const verified = incident.status === 'verified';
  const payload = {
    ...incident,
    ...extra,
    // The state of the report, in the words the clients switch on. A client
    // that predates this key sees a payload it already understands, which is
    // why the two audiences are separated by ROOM and not by this flag alone
    // -- the room is the guarantee, the flag is what makes the card correct.
    scope: verified ? 'verified' : 'awaiting_approval',
    requires_approval: !verified,
    reported_by_truck: reporterTruckId ?? null,
  };
  emitTo('dispatchers', INCIDENT_EVENT, payload);
  emitToMany(
    verified
      ? notifiedTruckIds(reroutes, reporterTruckId).map(truckRoom)
      : [truckRoom(reporterTruckId)],
    INCIDENT_EVENT,
    payload,
  );
}

/**
 * Announce an APPROVED hazard: the board, the affected drivers, the reporter.
 *
 * The audience widens here and nowhere else, which is the property the whole
 * approval step exists to provide. `scope: 'verified'` is what tells a
 * handset this is a real warning about a road that is now shut, as opposed to
 * the receipt it may already have shown for its own report.
 */
function announceVerified(incident, reroutes, reporterTruckId) {
  const payload = {
    ...incident,
    approved: true,
    scope: 'verified',
    requires_approval: false,
    reported_by_truck: reporterTruckId ?? null,
  };
  emitTo('dispatchers', INCIDENT_EVENT, payload);
  emitToMany(
    notifiedTruckIds(reroutes, reporterTruckId).map(truckRoom),
    INCIDENT_EVENT,
    payload,
  );
}

/// The already-stored incident for a replayed client_uid.
async function findByClientUid(clientUid) {
  const { rows } = await query(
    `SELECT id, kind, status, confidence, ai_class, blocked_edge, photo_path,
            ST_Y(geom) AS lat, ST_X(geom) AS lng, reported_at, client_uid
       FROM incidents WHERE client_uid = $1`,
    [clientUid],
  );
  return rows[0] ?? null;
}

/**
 * Recompute the route for every active trip that used the blocked edge (API-04)
 * and push the new geometry to that truck.
 */
export async function rerouteAffectedTrips(rawEdgeId, incidentId, incident = null) {
  if (!rawEdgeId) return [];
  // road_edges.id is a bigint, and node-postgres hands bigints back as STRINGS
  // to avoid silently truncating them past 2^53. Both callers reach here by
  // different routes -- snapToEdge() already casts to a number, the approval
  // path reads incidents.blocked_edge raw -- so the same edge arrived as
  // 150110 or as '150110' depending on which one fired, and a client doing a
  // strict comparison against it was right half the time. Normalised once,
  // here, rather than at each of the four places it is used below.
  const edgeId = Number(rawEdgeId);

  // TWO edge sets, asking two different questions. Swapping them is a bug
  // that has already been made once, so they are named apart here.
  //
  // WHO IS AFFECTED is a question about THIS hazard: a truck is on this
  // landslide's road or it is not. Answering it with the network-wide set
  // made the affected-trip scan grow with the platform's whole incident
  // history -- 203 seconds on a dispatcher's approve click, to return the
  // same one trip.
  const closure = await incidentClosureEdges(incidentId);
  if (closure.length === 0) closure.push(edgeId);

  // WHERE THE DETOUR MAY GO is a question about the whole network: a truck
  // routed around today's slide must not be sent down last week's. The union
  // with `closure` matters on the report path, where this can run inside the
  // request that created the incident and blockedEdgeIds() -- which reads
  // committed 'verified' rows -- would not yet see it.
  //
  // Passed to route_alternatives as a HARD EXCLUSION, which is the change
  // that makes a reroute a reroute. routable_edges prices a closed edge at
  // 999999, and a price is not a wall: A* took it anyway rather than pay for
  // a longer way round, leaving NH37 at the landslide and rejoining it 7 m
  // later over the parallel carriageway. Excluded outright, the answer is the
  // 11.4 km diversion that actually goes round.
  const forbidden = [...new Set([...await blockedEdgeIds(), ...closure])];

  const trips = await tripsUsingEdges(closure);
  const results = [];

  for (const trip of trips) {
    const from = await currentPosition(trip.truck_id, trip);
    const destination = { lat: trip.dest_lat, lng: trip.dest_lng };

    // The best route that does not touch a closed road anywhere.
    //
    // k=1, and that is not a weakening: the hard exclusion is what produces a
    // real detour, and the first candidate is by construction the cheapest
    // path that uses none of the closed edges. A second candidate would only
    // be another full A* -- half a second each -- run while a dispatcher
    // waits on a click, to offer something the driver is not asked to choose
    // between anyway.
    let route = null;
    try {
      const [best] = await routeAlternatives(from, destination,
        { k: 1, avoidEdges: forbidden });
      route = best ?? null;
    } catch (error) {
      // A disconnected pair raises rather than returning nothing. That is
      // real -- excluding the closure can genuinely cut the destination off --
      // and it must be reported as such, not retried into a route through the
      // landslide.
      if (!/not connected in this extract/.test(error.message)) throw error;
      console.warn(`[reroute] trip ${trip.trip_id}: ${error.message}`);
    }

    // Last resort, and it is a real one: with the road shut there may be no
    // way through at all. routeBetween can still answer, because the 999999
    // cost is a price rather than a wall -- so this is the "you will have to
    // drive it, there is nothing else" case. It is flagged, because a detour
    // that runs through the hazard must never be presented as one that avoids
    // it.
    let throughClosure = false;
    if (!route) {
      route = await routeBetween(from, destination);
      throughClosure = Boolean(route);
    }

    if (!route) {
      results.push({ trip_id: trip.trip_id, truck_id: trip.truck_id, rerouted: false,
        reason: 'no alternative route exists' });
      continue;
    }

    // The detour is offered against the route it replaces, so the driver is
    // answering "+38 km, +52 min" rather than a bare number they have nothing
    // to compare with. planned_duration_sec is null on a trip created before
    // migration 010; the distance still measures, so the card degrades to
    // distance-only rather than to nothing.
    // Two different questions, and conflating them is what put a saving on a
    // hazard detour. `previous` costs the WHOLE route being replaced -- it is
    // stored beside previous_route and is what a decline restores, so it must
    // keep measuring the same thing that geometry does. `ahead` costs only
    // what is left of it from the truck's current position, which is the
    // baseline the driver's card compares the detour against.
    const previous = await previousCosting(trip.trip_id);
    const ahead = await remainingCosting(trip.trip_id, from, previous);

    const rerouteId = await withTransaction(async (client) => {
      // previous_route is captured from the row being overwritten, in the
      // same statement pair and the same transaction. Reading it afterwards
      // would race the UPDATE and store the new path as its own predecessor.
      const { rows } = await client.query(
        `INSERT INTO reroutes (trip_id, incident_id, new_route, trigger_type, reason,
                               previous_route, distance_m, duration_sec,
                               previous_distance_m, previous_duration_sec)
         SELECT $1, $2, ST_GeomFromGeoJSON($3), 'incident', $4,
                t.planned_route, $5, $6, $7, $8
           FROM trips t WHERE t.id = $1
         RETURNING id`,
        [trip.trip_id, incidentId, JSON.stringify(route.geometry),
         `edge ${edgeId} blocked by incident ${incidentId}`,
         route.distanceM, route.durationSec,
         previous.distanceM, previous.durationSec]);

      await client.query(
        `UPDATE trips SET planned_route = ST_GeomFromGeoJSON($2),
                          planned_distance_m = $3, planned_duration_sec = $4
          WHERE id = $1`,
        [trip.trip_id, JSON.stringify(route.geometry),
         route.distanceM, route.durationSec]);

      return rows[0]?.id ?? null;
    });

    // `route_geom` carries the geometry ONCE. It was tempting to keep the old
    // `geometry` key alongside it for compatibility, but the two would
    // serialise as two full copies of a path that runs to several thousand
    // coordinates -- roughly 200 KB duplicated over the valley 3G link this
    // whole platform exists to survive. The scalar keys are free, so the old
    // `distance_m` does stay: the two mission scripts read it.
    const payload = {
      trip_id: trip.trip_id, truck_id: trip.truck_id, incident_id: incidentId,
      route_geom: route.geometry,
      new_distance_m: route.distanceM,
      estimated_time_sec: route.durationSec,
      distance_m: route.distanceM,

      // ---- what makes this an OFFER rather than an instruction ----
      // The handset draws the proposal, quotes both figures and waits for a
      // tap; POST /reroutes/:id/ack carries the answer back. A client that
      // predates this simply ignores the extra keys and applies the route as
      // before, which is why nothing here is a breaking change.
      reroute_id: rerouteId,
      requires_ack: true,
      // Measured from where the truck is, because new_distance_m is too.
      // These two and the deltas below are one arithmetic statement and they
      // all share an origin; see remainingCosting for what happens when they
      // do not.
      previous_distance_m: ahead.distanceM,
      previous_time_sec: ahead.durationSec,
      // The whole road being replaced, which is a different quantity: it is
      // what previous_route draws and what the dispatcher's board labels a
      // superseded route with.
      previous_route_total_m: previous.distanceM,
      // Pre-computed rather than left to the client: two clients doing this
      // subtraction themselves is two chances to disagree about what the
      // driver was told, and the dashboard and the handset must not.
      delta_distance_m: Number.isFinite(ahead.distanceM)
        ? route.distanceM - ahead.distanceM : null,
      delta_time_sec: Number.isFinite(ahead.durationSec)
        ? route.durationSec - ahead.durationSec : null,

      // Which of the alternatives this is, and whether it truly avoids the
      // hazard. `avoids_closure: false` is the honest report of the case
      // where the road is shut and there is no way round -- the driver is
      // being routed THROUGH it because there is nothing else, and a client
      // that shows that as "rerouted around a landslide" is lying to someone
      // about to drive into one.
      avoids_closure: !throughClosure,
      alternative_rank: route.rank ?? 1,
      // Why, in the words the driver's alert has to use.
      incident: incident ? {
        id: incident.id ?? incidentId,
        kind: incident.kind ?? null,
        lat: incident.lat ?? null,
        lng: incident.lng ?? null,
      } : { id: incidentId, kind: null, lat: null, lng: null },
      blocked_edge: edgeId,
    };
    emitTo(`truck:${trip.truck_id}`, ROUTE_EVENT, payload);
    emitTo('dispatchers', ROUTE_EVENT, payload);
    results.push({ trip_id: trip.trip_id, truck_id: trip.truck_id, rerouted: true,
      reroute_id: rerouteId,
      avoids_closure: !throughClosure,
      distance_m: route.distanceM, estimated_time_sec: route.durationSec });
  }
  return results;
}

/**
 * What the trip's current route costs, for the comparison the driver is shown.
 *
 * The stored figures win when they exist, because they were costed per edge by
 * travelTime.js. ST_Length is the fallback and it gives distance ONLY -- a
 * duration cannot be recovered from a bare LineString, since the ETA depends
 * on each edge's road class, surface and sinuosity. Returning null there is
 * the honest answer; guessing an average speed would put a fabricated "+40
 * min" in front of a driver deciding whether to take a mountain detour.
 */
async function previousCosting(tripId) {
  const { rows } = await query(
    `SELECT planned_distance_m, planned_duration_sec,
            ST_Length(planned_route::geography) AS measured_m
       FROM trips WHERE id = $1`,
    [tripId]);
  const row = rows[0];
  if (!row) return { distanceM: null, durationSec: null };
  const stored = Number(row.planned_distance_m);
  const measured = Number(row.measured_m);
  const duration = Number(row.planned_duration_sec);
  return {
    distanceM: Number.isFinite(stored) ? stored
      : (Number.isFinite(measured) ? measured : null),
    durationSec: Number.isFinite(duration) ? duration : null,
  };
}

/**
 * The costing the driver is actually deciding against: the part of the route
 * they have NOT driven yet.
 *
 * The detour is planned from where the truck IS (see currentPosition), so
 * comparing it with the trip's full planned distance quietly credits the
 * diversion with every metre already covered. On the handset, a truck 4,353 m
 * along the Guwahati corridor was offered a genuine +1,104 m hazard detour as
 * "−3.2 km · 9 min shorter" -- the reroute card sold a diversion round a
 * landslide as a saving. Both sides of the comparison have to start from the
 * same place.
 *
 * The distance is measured, not estimated: ST_LineLocatePoint finds where the
 * truck sits on its own route and ST_LineSubstring takes what is left of it.
 * The duration is the trip's stored costing scaled by the fraction remaining
 * -- the route's own average applied to the route's own tail. That is an
 * allocation of a figure the model did produce, not a guess at a speed it
 * never did, which is the line previousCosting draws and this keeps.
 *
 * Falls back to the whole-route costing whenever the remainder cannot be
 * measured (no fix for this truck, so currentPosition returned the trip
 * origin; a trip with no geometry), which is the pre-existing behaviour and
 * is correct there: a truck at its origin has driven nothing.
 */
async function remainingCosting(tripId, from, whole) {
  if (!from || !Number.isFinite(Number(from.lat)) || !Number.isFinite(Number(from.lng))) {
    return whole;
  }
  const { rows } = await query(
    `SELECT ST_Length(ST_LineSubstring(planned_route,
              ST_LineLocatePoint(planned_route,
                ST_SetSRID(ST_MakePoint($2, $3), 4326)), 1)::geography) AS remaining_m,
            ST_Length(planned_route::geography) AS full_m
       FROM trips
      WHERE id = $1 AND planned_route IS NOT NULL`,
    [tripId, Number(from.lng), Number(from.lat)]);
  const row = rows[0];
  if (!row) return whole;

  const remaining = Number(row.remaining_m);
  const full = Number(row.full_m);
  if (!Number.isFinite(remaining) || !Number.isFinite(full) || full <= 0) return whole;

  const fraction = Math.min(1, Math.max(0, remaining / full));
  return {
    distanceM: remaining,
    durationSec: Number.isFinite(whole.durationSec) ? whole.durationSec * fraction : null,
  };
}

/** Reroute from where the truck actually is, not from where it set off. */
async function currentPosition(truckId, trip) {
  const { rows } = await query(
    `SELECT ST_Y(geom) AS lat, ST_X(geom) AS lng FROM truck_last_seen WHERE truck_id = $1`,
    [truckId]);
  return rows[0] ?? { lat: trip.origin_lat, lng: trip.origin_lng };
}
