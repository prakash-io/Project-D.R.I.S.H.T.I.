// Routing and edge-snapping. Every spatial decision lives in SQL, in the
// functions migration 001/003/005 defines, so the API and the smoke tests
// exercise exactly the same code path.
import { query } from '../db.js';
import { config } from '../config.js';
import { estimateDurationSec } from './travelTime.js';

/**
 * Shortest path between two coordinates, honouring blocked edges (API-04).
 *
 * `riskWeight` folds the XGBoost score into the cost so a dispatcher can
 * pre-emptively reroute before anything is physically blocked: 0 ignores
 * risk, 1 makes a 1.0-risk road cost double.
 */
export async function routeBetween(from, to, { riskWeight = 0 } = {}) {
  // length_m is ST_Length over geography -- true metres on the ellipsoid, and
  // NOT the same quantity as `cost`. cost carries the risk weighting, so with
  // riskWeight > 0 it is inflated above the physical distance: reporting it as
  // a distance would tell the driver a pre-emptive reroute is longer than the
  // road actually is. highway/surface come along for the speed model.
  const { rows } = await query(
    `SELECT r.seq, r.edge_id, r.cost,
            ST_Length(r.edge_geom::geography) AS length_m,
            ST_Distance(ST_StartPoint(r.edge_geom)::geography,
                        ST_EndPoint(r.edge_geom)::geography) AS straight_m,
            e.highway, e.surface,
            ST_AsGeoJSON(r.edge_geom) AS geojson
     FROM route_astar(
            ST_SetSRID(ST_MakePoint($1, $2), 4326),
            ST_SetSRID(ST_MakePoint($3, $4), 4326),
            $5) r
     LEFT JOIN road_edges e ON e.id = r.edge_id
     ORDER BY r.seq`,
    [from.lng, from.lat, to.lng, to.lat, riskWeight],
  );

  if (rows.length === 0) return null;

  const coordinates = [];
  for (const row of rows) {
    if (!row.geojson) continue;
    const line = JSON.parse(row.geojson).coordinates;
    // route_astar returns edges in traversal order but each edge's geometry
    // keeps its stored direction, so an edge entered from its end point comes
    // back reversed. Orient each one against the running path or the drawn
    // route zig-zags while the total cost stays correct.
    const tail = coordinates[coordinates.length - 1];
    const oriented =
      tail && line.length &&
      (Math.abs(line[line.length - 1][0] - tail[0]) + Math.abs(line[line.length - 1][1] - tail[1])) <
      (Math.abs(line[0][0] - tail[0]) + Math.abs(line[0][1] - tail[1]))
        ? [...line].reverse()
        : line;
    for (const point of oriented) {
      const last = coordinates[coordinates.length - 1];
      if (!last || last[0] !== point[0] || last[1] !== point[1]) coordinates.push(point);
    }
  }

  const edges = rows.map((r) => ({
    seq: r.seq,
    edgeId: r.edge_id,
    cost: Number(r.cost),
    lengthM: Number(r.length_m),
    straightM: Number(r.straight_m),
    highway: r.highway,
    surface: r.surface,
  }));

  return {
    edges,
    // Physical length. `costM` keeps the weighted figure separately so a
    // caller that wants to know what A* actually minimised still can.
    distanceM: edges.reduce((sum, e) => sum + (Number.isFinite(e.lengthM) ? e.lengthM : 0), 0),
    costM: rows.reduce((sum, r) => sum + Number(r.cost), 0),
    durationSec: estimateDurationSec(edges),
    geometry: { type: 'LineString', coordinates },
  };
}

/**
 * Nearest road edge to a reported incident, and how far away it was (API-03).
 *
 * Returns null when nothing is within `incidentSnapMaxM`. That is the correct
 * answer, not an error to swallow: a report hundreds of metres from any road
 * is bad GPS, and blocking the nearest edge anyway would close a road nobody
 * reported.
 */
export async function snapToEdge(lat, lng, maxDistanceM = config.incidentSnapMaxM) {
  const { rows } = await query(
    `SELECT edge_id, distance_m, ST_AsGeoJSON(snapped) AS snapped
     FROM nearest_road_edge(ST_SetSRID(ST_MakePoint($1, $2), 4326), $3)`,
    [lng, lat, maxDistanceM],
  );
  if (rows.length === 0) return null;
  return {
    edgeId: Number(rows[0].edge_id),
    distanceM: Number(rows[0].distance_m),
    snapped: JSON.parse(rows[0].snapped),
  };
}

/** Trips whose planned route uses a given edge -- the trucks a block affects. */
export async function tripsUsingEdge(edgeId) {
  const { rows } = await query(
    `SELECT t.id AS trip_id, t.truck_id,
            ST_X(t.destination) AS dest_lng, ST_Y(t.destination) AS dest_lat,
            ST_X(t.origin) AS origin_lng, ST_Y(t.origin) AS origin_lat
     FROM trips t
     JOIN road_edges e ON e.id = $1
     WHERE t.status = 'active'
       AND t.planned_route IS NOT NULL
       -- A 25 m tolerance, not ST_Intersects: the planned route is a copy of
       -- the edge geometry, so exact intersection is fragile against any
       -- simplification the route was stored with.
       AND ST_DWithin(t.planned_route::geography, e.geom::geography, 25)`,
    [edgeId],
  );
  return rows;
}
