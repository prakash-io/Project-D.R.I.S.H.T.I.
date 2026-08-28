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

  return assemble(rows);
}

/**
 * Turn one path's worth of edge rows into a drawable, costed route.
 *
 * Shared by routeBetween and routeAlternatives so the two cannot disagree
 * about a distance: the alternatives are offered to the driver AGAINST the
 * route they would replace, and two different summation paths would put a
 * "+11.4 km" on the card that neither figure supports.
 */
function assemble(rows) {
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
 * Every genuinely distinct route between two points, best first (migration 011).
 *
 * This is what the platform was missing. `routeBetween` answers "what is THE
 * road", and when a hazard closed part of it the only honest answer to "now
 * what" was another call to the same function -- which returned the same road
 * with a 7 m jog around the blocked edge, 99.6% identical, presented to the
 * driver as a reroute.
 *
 * `avoidEdges` is a hard exclusion, not the view's 999999 cost. The two are
 * different statements and the difference matters: 999999 means "this road is
 * extremely expensive", and A* will still send a truck down it rather than
 * take a longer detour, which is right for a risk weighting and wrong for a
 * landslide. Excluded edges are not in the graph at all.
 *
 * Returns [] rather than throwing when nothing is reachable, EXCEPT for the
 * disconnected-components case, which propagates for the same reason it does
 * in routeBetween: "those two places are not joined in this extract" is a
 * different answer from "everything between them is shut", and the API says
 * different things about them.
 */
export async function routeAlternatives(from, to, {
  k = 3, riskWeight = 0, avoidEdges = [], maxOverlap = 0.6,
} = {}) {
  const { rows } = await query(
    `SELECT r.alt, r.seq, r.edge_id, r.cost,
            ST_Length(r.edge_geom::geography) AS length_m,
            ST_Distance(ST_StartPoint(r.edge_geom)::geography,
                        ST_EndPoint(r.edge_geom)::geography) AS straight_m,
            e.highway, e.surface,
            ST_AsGeoJSON(r.edge_geom) AS geojson
     FROM route_alternatives(
            ST_SetSRID(ST_MakePoint($1, $2), 4326),
            ST_SetSRID(ST_MakePoint($3, $4), 4326),
            $5, $6, $7::bigint[], $8) r
     LEFT JOIN road_edges e ON e.id = r.edge_id
     ORDER BY r.alt, r.seq`,
    [from.lng, from.lat, to.lng, to.lat,
     k, riskWeight,
     // Coerced, not trusted. node-postgres returns a bigint column as a
     // STRING to avoid truncating past 2^53, so blocked_edge reaches callers
     // as '150110' while snapToEdge hands back 150110 -- and an array mixing
     // the two is quoted into the generated SQL with quotes around half its
     // elements, which fails the ::bigint[] cast rather than silently
     // excluding nothing. Deduplicated too, so the array a caller assembled
     // by unioning several sources does not carry the same edge twice.
     [...new Set(avoidEdges.map(Number).filter(Number.isFinite))],
     maxOverlap],
  );

  const byAlt = new Map();
  for (const row of rows) {
    const alt = Number(row.alt);
    if (!byAlt.has(alt)) byAlt.set(alt, []);
    byAlt.get(alt).push(row);
  }

  return [...byAlt.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rank, altRows]) => ({ rank, ...assemble(altRows) }));
}

/**
 * The edges a hazard at this point closes (migration 011).
 *
 * Not the same question as snapToEdge, which answers "which edge did the
 * driver report from". A landslide does not close 104 m of one carriageway.
 * Measured on the Guwahati-Shillong corridor: closing the snapped edge alone
 * produced a 7 m detour over the parallel carriageway; closing the road
 * produced an 11.4 km one.
 */
export async function closureEdges(lat, lng, radiusM = config.closureRadiusM) {
  const { rows } = await query(
    `SELECT edge_id, distance_m
       FROM road_closure_edges(ST_SetSRID(ST_MakePoint($1, $2), 4326), $3)`,
    [lng, lat, radiusM],
  );
  return rows.map((row) => ({
    edgeId: Number(row.edge_id),
    distanceM: Number(row.distance_m),
  }));
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

/**
 * Trips whose planned route runs through a closure -- the trucks it affects.
 *
 * Takes the whole edge SET rather than one id. A closure is a stretch of road
 * (see closureEdges), and a truck approaching from the far side may cross the
 * closure on an edge that is not the one the report snapped to; asking only
 * about the anchor would leave that driver unwarned on a road that is shut.
 */
export async function tripsUsingEdges(edgeIds) {
  const ids = [...new Set((Array.isArray(edgeIds) ? edgeIds : [edgeIds])
    .map(Number).filter(Number.isFinite))];
  if (ids.length === 0) return [];

  const { rows } = await query(
    // The closure is buffered ONCE into a single zone, and the routes are then
    // tested against that zone in plain geometry.
    //
    // The obvious phrasing -- join the trips to the edges and
    // ST_DWithin(t.planned_route::geography, e.geom::geography, 25) -- is what
    // was here, and it is quadratic in the worst way. That cast converts a
    // 4,400-point LineString to geography ONCE PER EDGE PER TRIP, and a
    // closure is now several edges rather than one. Measured on this graph
    // with a 7-edge closure and eleven active trips: 70,409 ms. As written
    // below: 27 ms warm, 646 ms cold. Same answer -- one trip either way.
    //
    // The 25 m tolerance is unchanged and still deliberate: the planned route
    // is a copy of the edge geometry, so exact ST_Intersects is fragile
    // against any simplification the route was stored with. It is applied by
    // buffering the closure in GEOGRAPHY, so 25 m is still 25 real metres,
    // and only the cheap containment test runs per trip.
    `WITH closure AS (
       SELECT ST_Buffer(ST_Collect(e.geom)::geography, 25)::geometry AS zone
         FROM road_edges e WHERE e.id = ANY($1::bigint[])
     )
     SELECT t.id AS trip_id, t.truck_id,
            ST_X(t.destination) AS dest_lng, ST_Y(t.destination) AS dest_lat,
            ST_X(t.origin) AS origin_lng, ST_Y(t.origin) AS origin_lat
       FROM trips t, closure c
      WHERE t.status = 'active'
        AND t.planned_route IS NOT NULL
        AND c.zone IS NOT NULL
        AND ST_Intersects(t.planned_route, c.zone)`,
    [ids],
  );
  return rows;
}

/**
 * The edges ONE incident closes: its anchor plus the road around it.
 *
 * Distinct from blockedEdgeIds(), and conflating the two was a 203-second
 * dispatcher click. "Which trucks does this landslide affect" is a question
 * about THIS closure; "which roads must the detour avoid" is a question about
 * every closure on the network. Asking the first question with the second
 * question's edge set made the affected-trip scan grow with every incident
 * the platform had ever verified, for no gain -- a truck is not affected by
 * this incident because it is driving through some other one.
 */
export async function incidentClosureEdges(incidentId) {
  const { rows } = await query(
    `SELECT blocked_edge AS edge_id FROM incidents
      WHERE id = $1 AND blocked_edge IS NOT NULL
      UNION
     SELECT edge_id FROM incident_blocked_edges WHERE incident_id = $1`,
    [incidentId]);
  return rows.map((row) => Number(row.edge_id)).filter(Number.isFinite);
}

/**
 * Every edge currently closed by a verified incident.
 *
 * The reroute needs this as a SET, not just the edge that triggered it: a
 * truck detouring around today's landslide must not be routed onto a road
 * that was closed last week. routable_edges already prices those at 999999,
 * which is a strong hint and not a prohibition -- A* will still use one when
 * the alternative costs more. Passed as `avoidEdges`, they are removed from
 * the graph outright.
 */
export async function blockedEdgeIds() {
  const { rows } = await query(
    `SELECT DISTINCT blocked_edge AS edge_id
       FROM incidents WHERE status = 'verified' AND blocked_edge IS NOT NULL
      UNION
     SELECT DISTINCT be.edge_id
       FROM incident_blocked_edges be
       JOIN incidents i ON i.id = be.incident_id
      WHERE i.status = 'verified'`);
  return rows.map((row) => Number(row.edge_id));
}
