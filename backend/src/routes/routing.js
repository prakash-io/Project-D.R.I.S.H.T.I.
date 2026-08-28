// Routing and trip endpoints (API-04).
import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { routeBetween } from '../services/routing.js';
import { emitTo, ROUTE_ACK_EVENT } from '../sockets/telemetry.js';

export const routingRouter = Router();

/**
 * POST /routes/plan   { from: {lat,lng}, to: {lat,lng}, risk_weight? }
 *
 * `risk_weight` is what makes workflow section 5 possible: it folds the
 * XGBoost hazard score into the cost so a dispatcher can steer trucks away
 * from a high-risk corridor before anything is physically blocked.
 */
routingRouter.post('/routes/plan', async (req, res, next) => {
  try {
    const { from, to, risk_weight: riskWeight = 0 } = req.body ?? {};
    for (const [name, point] of [['from', from], ['to', to]]) {
      if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
        return res.status(400).json({ error: `${name} must be {lat, lng}` });
      }
    }

    let route;
    try {
      route = await routeBetween(from, to, { riskWeight: Number(riskWeight) || 0 });
    } catch (error) {
      // route_astar raises this rather than returning nothing, so the caller
      // can tell "unreachable" from "everything on the way is blocked".
      if (/not connected in this extract/.test(error.message)) {
        return res.status(422).json({ error: error.message, reachable: false });
      }
      throw error;
    }
    if (!route) return res.status(404).json({ error: 'no route found', reachable: false });

    res.json({
      distance_m: route.distanceM,
      estimated_time_sec: route.durationSec,
      edge_count: route.edges.length,
      geometry: route.geometry,
    });
  } catch (error) { next(error); }
});

/**
 * GET /routes/places -- the named endpoints a driver may type into the app.
 *
 * Every entry is an origin or destination of a seeded corridor, which is the
 * property that matters: each one has already been proven routable by
 * pgr_astar over this extract. A free-text geocoder would happily hand back a
 * pin in a village the 486,784-edge extract does not reach, and the driver
 * would get a 422 with no way to tell a bad address from a bad graph.
 *
 * Deliberately not a geocoder, and deliberately not the corridor list either:
 * the driver picks two ENDS and the server plans between them, so any pair is
 * available -- Shillong to Dibrugarh is offered even though no seeded corridor
 * runs it.
 */
routingRouter.get('/routes/places', async (_req, res, next) => {
  try {
    // UNION (not UNION ALL) over both columns: a city that is the origin of
    // one corridor and the destination of another must appear once.
    const { rows } = await query(
      `SELECT name,
              round(avg(lat)::numeric, 6)::float8 AS lat,
              round(avg(lng)::numeric, 6)::float8 AS lng
         FROM (
           SELECT origin_name AS name,
                  ST_Y(origin::geometry) AS lat, ST_X(origin::geometry) AS lng
             FROM corridors
           UNION
           SELECT destination_name,
                  ST_Y(destination::geometry), ST_X(destination::geometry)
             FROM corridors
         ) p
        GROUP BY name
        ORDER BY name`);

    res.json({
      places: rows.map((row) => ({
        // Stable, derived from the name rather than a serial, so the handset
        // can cache a selection across restarts and across a reseed.
        id: row.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        name: row.name,
        lat: Number(row.lat),
        lng: Number(row.lng),
      })),
    });
  } catch (error) { next(error); }
});

/**
 * GET /routes/corridors -- the named demonstration corridors (migration 009).
 *
 * Geometry is opt-in because it is big: the ten corridors together carry
 * ~44,000 coordinates, and a driver client that only needs to populate a
 * picker should not pull a megabyte to do it.
 *
 *   ?geometry=1        include planned_route
 *   ?simplify_m=25     Douglas-Peucker tolerance in METRES before sending
 *
 * simplify_m is for overview rendering only. Simplifying to 25 m drops the
 * point count by roughly an order of magnitude while staying well inside the
 * width of the road as drawn; it must NOT be used to feed the simulated drive,
 * which follows the geometry vertex by vertex and would visibly corner-cut.
 */
routingRouter.get('/routes/corridors', async (req, res, next) => {
  try {
    const withGeometry = req.query.geometry === '1' || req.query.geometry === 'true';
    // Clamped rather than trusted: an unbounded tolerance would collapse a
    // corridor to a straight line between its endpoints, which is exactly the
    // fiction the corridors table exists to avoid.
    const simplifyM = Math.max(0, Math.min(Number(req.query.simplify_m ?? 0) || 0, 500));

    // ST_Simplify works in the units of its input, so the geography is cast to
    // 3857 (metres) for the tolerance to mean metres, then back to 4326.
    const geomSql = !withGeometry ? 'NULL::json' : (simplifyM > 0
      ? `ST_AsGeoJSON(ST_Transform(ST_Simplify(
           ST_Transform(planned_route::geometry, 3857), ${simplifyM}), 4326))::json`
      : 'ST_AsGeoJSON(planned_route::geometry)::json');

    const { rows } = await query(
      `SELECT id, name, origin_name, destination_name,
              ST_Y(origin::geometry)      AS origin_lat,
              ST_X(origin::geometry)      AS origin_lng,
              ST_Y(destination::geometry) AS destination_lat,
              ST_X(destination::geometry) AS destination_lng,
              distance_m, edge_count, planned_at,
              ST_NPoints(planned_route::geometry) AS point_count,
              ${geomSql} AS geometry
         FROM corridors
        ORDER BY sort_order, id`);

    res.json({ corridors: rows });
  } catch (error) { next(error); }
});

/** GET /routes/corridors/:id -- one corridor, always with full geometry. */
routingRouter.get('/routes/corridors/:id', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, origin_name, destination_name,
              ST_Y(origin::geometry)      AS origin_lat,
              ST_X(origin::geometry)      AS origin_lng,
              ST_Y(destination::geometry) AS destination_lat,
              ST_X(destination::geometry) AS destination_lng,
              distance_m, edge_count, planned_at,
              ST_NPoints(planned_route::geometry) AS point_count,
              ST_AsGeoJSON(planned_route::geometry)::json AS geometry
         FROM corridors WHERE id = $1`,
      [req.params.id]);

    if (rows.length === 0) return res.status(404).json({ error: 'no such corridor' });
    res.json({ corridor: rows[0] });
  } catch (error) { next(error); }
});

/**
 * POST /trips  { truck_id, from, to } -- start a trip with a planned route.
 *
 * A truck has exactly ONE active trip when this returns. Any trip that was
 * still open is aborted first, and that is a correctness fix rather than
 * housekeeping: tripsUsingEdge() reroutes every active trip whose path uses a
 * blocked edge, so a driver who had planned three routes during a shift would
 * receive three separate reroute proposals for one landslide, on three
 * different journeys, two of which they had already abandoned.
 */
routingRouter.post('/trips', async (req, res, next) => {
  try {
    const { truck_id: truckId, from, to } = req.body ?? {};
    if (!truckId || !from || !to) {
      return res.status(400).json({ error: 'truck_id, from and to are required' });
    }
    for (const [name, point] of [['from', from], ['to', to]]) {
      if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lng)) {
        return res.status(400).json({ error: `${name} must be {lat, lng}` });
      }
    }

    let route;
    try {
      route = await routeBetween(from, to);
    } catch (error) {
      // Same discrimination /routes/plan makes: an unreachable pair is the
      // driver's input being outside the extract, not a server fault.
      if (/not connected in this extract/.test(error.message)) {
        return res.status(422).json({ error: error.message, reachable: false });
      }
      throw error;
    }
    if (!route) return res.status(404).json({ error: 'no route found', reachable: false });

    // One transaction: the window between "closed the old trip" and "opened
    // the new one" is a window in which recordTelemetry finds no active trip
    // and silently drops every fix that arrives in it (see telemetry.js).
    const trip = await withTransaction(async (client) => {
      const superseded = await client.query(
        `UPDATE trips SET status = 'aborted', ended_at = now()
          WHERE truck_id = $1 AND status = 'active'
        RETURNING id`,
        [truckId]);

      const { rows } = await client.query(
        `INSERT INTO trips (truck_id, origin, destination, planned_route, status,
                            planned_distance_m, planned_duration_sec)
         VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326),
                     ST_SetSRID(ST_MakePoint($4, $5), 4326),
                     ST_GeomFromGeoJSON($6), 'active', $7, $8)
         RETURNING id, truck_id, status, started_at`,
        [truckId, from.lng, from.lat, to.lng, to.lat, JSON.stringify(route.geometry),
         route.distanceM, route.durationSec],
      );
      return { ...rows[0], superseded: superseded.rowCount };
    });

    res.status(201).json({
      trip,
      distance_m: route.distanceM,
      // The figure the driver's route card reads. It was absent before, so
      // the handset could only show an ETA once something had gone wrong --
      // which taught the driver that the ETA card means bad news.
      estimated_time_sec: route.durationSec,
      edge_count: route.edges.length,
      geometry: route.geometry,
    });
  } catch (error) { next(error); }
});

/**
 * POST /reroutes/:id/ack   { accepted: bool, responded_by? }
 *
 * The driver's answer to a proposal. This is the half of the Google-Maps
 * contract the platform was missing: a detour is OFFERED, and the offer can
 * be turned down.
 *
 * ACCEPTED is a no-op on the geometry -- rerouteAffectedTrips already wrote
 * the new path to the trip, because the dispatcher's board has to show what
 * the truck was told the moment it was told, not after a round trip through a
 * handset that may be in a valley. Accepting only records that the driver
 * saw it and agreed.
 *
 * DECLINED restores the superseded path. The driver is knowingly continuing
 * towards a road the graph believes is blocked, and the record has to say so:
 * a trip left showing a detour the driver refused would put the dashboard's
 * truck on a road nobody is driving.
 */
routingRouter.post('/reroutes/:id/ack', async (req, res, next) => {
  try {
    const accepted = req.body?.accepted;
    if (typeof accepted !== 'boolean') {
      return res.status(400).json({ error: 'accepted must be true or false' });
    }
    const response = accepted ? 'accepted' : 'declined';

    const result = await withTransaction(async (client) => {
      // Locked for the row's lifetime in this transaction: a proposal that is
      // answered twice (a flaky link, the driver double-tapping) must not
      // restore the previous route on top of an already-applied acceptance.
      const { rows } = await client.query(
        `SELECT id, trip_id, driver_response,
                previous_route IS NOT NULL AS has_previous,
                previous_distance_m, previous_duration_sec
           FROM reroutes WHERE id = $1 FOR UPDATE`,
        [req.params.id]);
      if (rows.length === 0) return { status: 404, body: { error: 'no such reroute' } };

      const reroute = rows[0];
      if (reroute.driver_response !== 'pending') {
        // Idempotent on a repeat of the SAME answer, a conflict on a
        // different one: re-sending "accepted" after a dropped response is
        // routine, changing your mind after the fact is not something this
        // endpoint can honour.
        return reroute.driver_response === response
          ? { status: 200, body: { reroute_id: reroute.id, driver_response: response,
              duplicate: true } }
          : { status: 409, body: { error: `already ${reroute.driver_response}` } };
      }

      await client.query(
        `UPDATE reroutes SET driver_response = $2, responded_at = now() WHERE id = $1`,
        [reroute.id, response]);

      let restored = false;
      if (!accepted && reroute.has_previous) {
        await client.query(
          `UPDATE trips t
              SET planned_route = r.previous_route,
                  planned_distance_m = r.previous_distance_m,
                  planned_duration_sec = r.previous_duration_sec
             FROM reroutes r
            WHERE r.id = $1 AND t.id = r.trip_id AND t.status = 'active'`,
          [reroute.id]);
        restored = true;
      }
      return { status: 200,
        body: { reroute_id: reroute.id, trip_id: reroute.trip_id,
          driver_response: response, route_restored: restored } };
    });

    if (result.status === 200) {
      // The dispatcher needs to know a detour was refused far more urgently
      // than that one was taken: that truck is still heading at the hazard.
      emitTo('dispatchers', ROUTE_ACK_EVENT, {
        ...result.body,
        responded_by: req.body?.responded_by ?? 'driver',
      });
    }
    res.status(result.status).json(result.body);
  } catch (error) { next(error); }
});

/** GET /trucks -- last known position of every truck, for the first paint. */
routingRouter.get('/trucks', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT t.id, t.plate, t.driver_name, t.alert_lang,
              ST_Y(l.geom) AS lat, ST_X(l.geom) AS lng,
              l.speed_mps, l.source, l.captured_at
       FROM trucks t LEFT JOIN truck_last_seen l ON l.truck_id = t.id
       ORDER BY t.plate`);
    res.json({ trucks: rows });
  } catch (error) { next(error); }
});

/**
 * GET /trucks/:id -- one truck, its driver, and its active trip.
 *
 * The dispatcher's deep-dive (analytics/:truckId) reads this. It is a
 * separate endpoint from GET /trucks rather than a fatter version of it
 * because the list is polled by every open console for the first paint and
 * this joins two more tables and runs a linear-referencing call per row --
 * cheap for one truck, wasteful across the fleet.
 *
 * PROGRESS is measured, not assumed. ST_LineLocatePoint gives the fraction
 * along the planned route that is nearest the last known position, so the
 * remaining distance and the ETA come from where the truck actually IS. The
 * alternative -- started_at plus the planned duration -- is a schedule, not an
 * estimate, and it keeps reporting an on-time arrival for a truck that has
 * been stopped at a landslide for an hour.
 *
 * When there is no fix or no planned geometry to locate one against, progress
 * is null and the planned figures are returned unchanged. The response says
 * which of the two it is (`progress_source`) rather than letting the page
 * present a schedule as though it were a measurement.
 */
routingRouter.get('/trucks/:id', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT t.id, t.plate, t.driver_name, t.phone, t.alert_lang, t.created_at,
              ST_Y(l.geom) AS last_lat, ST_X(l.geom) AS last_lng,
              l.source, l.speed_mps, l.captured_at,
              tp.id AS trip_id, tp.status AS trip_status, tp.started_at,
              ST_Y(tp.origin)      AS origin_lat,
              ST_X(tp.origin)      AS origin_lng,
              ST_Y(tp.destination) AS destination_lat,
              ST_X(tp.destination) AS destination_lng,
              tp.planned_distance_m, tp.planned_duration_sec,
              -- Only meaningful with both a route and a fix; SQL returns NULL
              -- for the whole CASE otherwise, which is what the page reads as
              -- "not measurable" rather than as zero progress.
              CASE WHEN tp.planned_route IS NOT NULL AND l.geom IS NOT NULL
                   THEN ST_LineLocatePoint(tp.planned_route, l.geom)
              END AS progress,
              -- Simplified for transport. 60 m is well under the width this
              -- line is drawn at on the analytics map and cuts a 4,411-point
              -- corridor by about an order of magnitude. NOT used for
              -- anything that follows the geometry vertex by vertex.
              CASE WHEN tp.planned_route IS NOT NULL
                   THEN ST_AsGeoJSON(ST_Transform(ST_Simplify(
                          ST_Transform(tp.planned_route, 3857), 60), 4326))::json
              END AS geometry
         FROM trucks t
         LEFT JOIN truck_last_seen l ON l.truck_id = t.id
         -- LATERAL rather than a plain join: a truck can carry several
         -- historical trips and exactly one active, and without the LIMIT a
         -- data state with two actives would silently return two rows.
         LEFT JOIN LATERAL (
           SELECT * FROM trips
            WHERE truck_id = t.id AND status = 'active'
            ORDER BY started_at DESC LIMIT 1
         ) tp ON true
        WHERE t.id = $1`,
      [req.params.id]);

    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'no such truck' });

    const [originName, destinationName] = await Promise.all([
      nearestPlaceName(row.origin_lat, row.origin_lng),
      nearestPlaceName(row.destination_lat, row.destination_lng),
    ]);

    const distanceM = numberOrNull(row.planned_distance_m);
    const durationSec = numberOrNull(row.planned_duration_sec);
    const progress = numberOrNull(row.progress);
    const measured = progress !== null;
    const remainingFraction = measured ? Math.max(0, 1 - progress) : 1;

    const remainingDistanceM = distanceM === null
      ? null : distanceM * remainingFraction;
    const remainingDurationSec = durationSec === null
      ? null : durationSec * remainingFraction;

    res.json({
      truck: {
        id: row.id,
        plate: row.plate,
        driver_name: row.driver_name,
        alert_lang: row.alert_lang,
        ...driverPhone(row.phone, row.id),
      },
      last_seen: row.last_lat === null ? null : {
        lat: row.last_lat,
        lng: row.last_lng,
        source: row.source,
        speed_mps: numberOrNull(row.speed_mps),
        captured_at: row.captured_at,
      },
      trip: !row.trip_id ? null : {
        id: row.trip_id,
        status: row.trip_status,
        started_at: row.started_at,
        origin: { lat: row.origin_lat, lng: row.origin_lng, name: originName },
        destination: {
          lat: row.destination_lat, lng: row.destination_lng, name: destinationName,
        },
        distance_m: distanceM,
        duration_sec: durationSec,
        progress,
        // Named so the page can never present the fallback as a measurement.
        progress_source: measured ? 'route_position' : null,
        remaining_distance_m: remainingDistanceM,
        remaining_duration_sec: remainingDurationSec,
        // Computed from NOW plus what is left, so a page left open does not
        // keep showing an arrival time that has already passed.
        eta_utc: remainingDurationSec === null
          ? null
          : new Date(Date.now() + remainingDurationSec * 1000).toISOString(),
        geometry: row.geometry,
      },
    });
  } catch (error) { next(error); }
});

/**
 * The nearest seeded place to a point, or null past the cutoff.
 *
 * trips stores its two ends as bare geometry -- there is no name column -- so
 * the name has to be recovered by proximity to the corridor endpoints, which
 * are the only named points in this schema. 25 km is generous enough to match
 * a trip that was planned to a routable node several hundred metres off the
 * town centre, and tight enough that a trip into open country returns null
 * instead of claiming to end in a city an hour away. The page shows the
 * coordinates when this is null; it never invents a name.
 */
const PLACE_MATCH_METRES = 25000;

async function nearestPlaceName(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const { rows } = await query(
    `SELECT name,
            ST_Distance(pt::geography,
                        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS metres
       FROM (
         SELECT origin_name AS name, origin::geometry AS pt FROM corridors
         UNION
         SELECT destination_name, destination::geometry FROM corridors
       ) p
      ORDER BY metres
      LIMIT 1`,
    [lng, lat]);
  const row = rows[0];
  if (!row || Number(row.metres) > PLACE_MATCH_METRES) return null;
  return row.name;
}

/**
 * The driver's contact number.
 *
 * `trucks.phone` is real and has been in the schema since migration 001 -- it
 * is simply not populated on the demonstration fleet (0 of 9 rows). Rather
 * than show a blank where a dispatcher expects a number, a stable placeholder
 * is derived from the truck's own id and FLAGGED as one. The flag is the
 * important half: an unmarked fake number in an incident console is something
 * somebody eventually dials.
 *
 * Deterministic so it does not change between page loads, and drawn from the
 * +91 6-9 mobile range so it is obviously a mobile without colliding with a
 * real allocation any more than any invented number does.
 */
function driverPhone(stored, truckId) {
  if (stored) return { phone: stored, phone_is_placeholder: false };
  const hex = String(truckId).replace(/[^0-9a-f]/gi, '');
  let digits = '';
  for (let i = 0; i < hex.length && digits.length < 9; i += 1) {
    digits += (parseInt(hex[i], 16) % 10).toString();
  }
  digits = digits.padEnd(9, '0');
  return {
    phone: `+91 9${digits.slice(0, 4)} ${digits.slice(4, 9)}`,
    phone_is_placeholder: true,
  };
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
