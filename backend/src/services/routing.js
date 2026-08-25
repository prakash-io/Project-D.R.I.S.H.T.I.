// Routing and edge-snapping. Every spatial decision lives in SQL, in the
// functions migration 001/003/005 defines, so the API and the smoke tests
// exercise exactly the same code path.
import { query } from '../db.js';
import { config } from '../config.js';

/**
 * Shortest path between two coordinates, honouring blocked edges (API-04).
 *
 * `riskWeight` folds the XGBoost score into the cost so a dispatcher can
 * pre-emptively reroute before anything is physically blocked: 0 ignores
 * risk, 1 makes a 1.0-risk road cost double.
 */
export async function routeBetween(from, to, { riskWeight = 0 } = {}) {
  const { rows } = await query(
    `SELECT seq, edge_id, cost,
            ST_AsGeoJSON(edge_geom) AS geojson
     FROM route_astar(
            ST_SetSRID(ST_MakePoint($1, $2), 4326),
            ST_SetSRID(ST_MakePoint($3, $4), 4326),
            $5)
     ORDER BY seq`,
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

  return {
    edges: rows.map((r) => ({ seq: r.seq, edgeId: r.edge_id, cost: Number(r.cost) })),
    distanceM: rows.reduce((sum, r) => sum + Number(r.cost), 0),
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
