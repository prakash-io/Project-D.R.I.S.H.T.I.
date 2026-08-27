// Routing and trip endpoints (API-04).
import { Router } from 'express';
import { query } from '../db.js';
import { routeBetween } from '../services/routing.js';

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
      edge_count: route.edges.length,
      geometry: route.geometry,
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

/** POST /trips  { truck_id, from, to } -- start a trip with a planned route. */
routingRouter.post('/trips', async (req, res, next) => {
  try {
    const { truck_id: truckId, from, to } = req.body ?? {};
    if (!truckId || !from || !to) {
      return res.status(400).json({ error: 'truck_id, from and to are required' });
    }
    const route = await routeBetween(from, to);
    if (!route) return res.status(404).json({ error: 'no route found' });

    const { rows } = await query(
      `INSERT INTO trips (truck_id, origin, destination, planned_route, status)
       VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326),
                   ST_SetSRID(ST_MakePoint($4, $5), 4326),
                   ST_GeomFromGeoJSON($6), 'active')
       RETURNING id, truck_id, status, started_at`,
      [truckId, from.lng, from.lat, to.lng, to.lat, JSON.stringify(route.geometry)],
    );
    res.status(201).json({ trip: rows[0], distance_m: route.distanceM,
      geometry: route.geometry });
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
