// Crowdsourced incident reporting and dispatcher approval (API-03, workflow §4).
import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { query, withTransaction } from '../db.js';
import { config } from '../config.js';
import { verifyIncident, AiServiceError } from '../services/aiClient.js';
import { snapToEdge, tripsUsingEdge, routeBetween } from '../services/routing.js';
import { broadcast, emitTo, INCIDENT_EVENT, ROUTE_EVENT } from '../sockets/telemetry.js';
import { randomUUID } from 'node:crypto';

// In memory first: the buffer is forwarded to the AI service, then written to
// disk so WEB-05 can show it. 8 MB covers a phone camera JPEG with room to
// spare.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

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
        const pending = await insertIncident({
          lat, lng, truckId: req.body?.truck_id ?? null, edgeId: snap.edgeId,
          kind: 'obstruction', status: 'pending', confidence: null,
          aiClass: null, aiReviewed: false, photoPath, clientUid,
        });
        return res.status(202).json({
          incident: pending,
          snapped_to_edge: snap.edgeId,
          distance_m: snap.distanceM,
          ai: { available: false, error: error.message },
          note: 'stored unclassified; the AI service was unreachable',
        });
      }
      throw error;
    }

    const blockable = verdict.verified && verdict.incident_kind;
    const needsHuman = verdict.requires_human_review !== false;

    // 'verified' is the only status routable_edges honours, so this single
    // choice decides whether a road closes.
    let status = 'rejected';
    if (blockable) {
      status = needsHuman && !config.autoBlockOnAiVerdict
        ? 'pending_dispatcher_approval'
        : 'verified';
    }

    const incident = await insertIncident({
      lat, lng, truckId: req.body?.truck_id ?? null, edgeId: snap.edgeId,
      kind: verdict.incident_kind ?? 'obstruction',
      status, confidence: verdict.confidence ?? null,
      aiClass: verdict.predicted_class ?? null, aiReviewed: true, photoPath, clientUid,
    });

    broadcast(INCIDENT_EVENT, { ...incident, ai: verdict, snapped_to_edge: snap.edgeId });

    const affected = status === 'verified' ? await rerouteAffectedTrips(snap.edgeId, incident.id) : [];

    res.status(201).json({
      incident,
      snapped_to_edge: snap.edgeId,
      distance_m: snap.distanceM,
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
      `SELECT id, kind, status, confidence, ai_class, blocked_edge,
              photo_path IS NOT NULL AS has_photo,
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
    const reroutes = await rerouteAffectedTrips(incident.blocked_edge, incident.id);
    broadcast(INCIDENT_EVENT, { ...incident, approved: true });
    res.json({ incident, blocks_routing: true, reroutes });
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
export async function rerouteAffectedTrips(edgeId, incidentId) {
  if (!edgeId) return [];
  const trips = await tripsUsingEdge(edgeId);
  const results = [];

  for (const trip of trips) {
    const from = await currentPosition(trip.truck_id, trip);
    const route = await routeBetween(from, { lat: trip.dest_lat, lng: trip.dest_lng });
    if (!route) {
      results.push({ trip_id: trip.trip_id, truck_id: trip.truck_id, rerouted: false,
        reason: 'no alternative route exists' });
      continue;
    }

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE trips SET planned_route = ST_GeomFromGeoJSON($2) WHERE id = $1`,
        [trip.trip_id, JSON.stringify(route.geometry)]);
      await client.query(
        `INSERT INTO reroutes (trip_id, incident_id, new_route, trigger_type, reason)
         VALUES ($1, $2, ST_GeomFromGeoJSON($3), 'incident', $4)`,
        [trip.trip_id, incidentId, JSON.stringify(route.geometry),
         `edge ${edgeId} blocked by incident ${incidentId}`]);
    });

    const payload = {
      trip_id: trip.trip_id, truck_id: trip.truck_id, incident_id: incidentId,
      distance_m: route.distanceM, geometry: route.geometry,
    };
    emitTo(`truck:${trip.truck_id}`, ROUTE_EVENT, payload);
    emitTo('dispatchers', ROUTE_EVENT, payload);
    results.push({ trip_id: trip.trip_id, truck_id: trip.truck_id, rerouted: true,
      distance_m: route.distanceM });
  }
  return results;
}

/** Reroute from where the truck actually is, not from where it set off. */
async function currentPosition(truckId, trip) {
  const { rows } = await query(
    `SELECT ST_Y(geom) AS lat, ST_X(geom) AS lng FROM truck_last_seen WHERE truck_id = $1`,
    [truckId]);
  return rows[0] ?? { lat: trip.origin_lat, lng: trip.origin_lng };
}
