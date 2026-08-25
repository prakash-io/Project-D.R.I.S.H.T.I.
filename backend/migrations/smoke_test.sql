-- Smoke test for the routing layer. Runs entirely inside a transaction that
-- is rolled back, so it is safe against a populated database.
--
--   docker exec -i drishti-postgis psql -v ON_ERROR_STOP=1 -U drishti -d drishti \
--       < backend/migrations/smoke_test.sql
--
-- Proves four things that "CREATE FUNCTION" alone does not:
--   1. the x1..y2 generated columns actually populate from geom
--   2. pgr_aStar runs against routable_edges and returns a path
--   3. a verified incident reroutes traffic via the 999999 cost
--   4. clearing that incident restores the original path with no writes to cost

BEGIN;

-- A diamond: node 1 -> 4 via a cheap north leg (2) or a dear south leg (3).
--   2
--  / \
-- 1   4
--  \ /
--   3
INSERT INTO road_edges (source, target, cost, reverse_cost, geom, name) VALUES
 (1, 2, 100, 100, ST_GeomFromText('LINESTRING(93.60 27.10, 93.62 27.12)', 4326), 'north-a'),
 (2, 4, 100, 100, ST_GeomFromText('LINESTRING(93.62 27.12, 93.64 27.10)', 4326), 'north-b'),
 (1, 3, 200, 200, ST_GeomFromText('LINESTRING(93.60 27.10, 93.62 27.08)', 4326), 'south-a'),
 (3, 4, 200, 200, ST_GeomFromText('LINESTRING(93.62 27.08, 93.64 27.10)', 4326), 'south-b');

SELECT rebuild_road_nodes() AS nodes_built;

\echo '--- 1. generated columns populate from geom (expect 93.60,27.10 -> 93.62,27.12)'
SELECT name, x1, y1, x2, y2 FROM road_edges WHERE name = 'north-a';

\echo '--- 2. baseline route 1->4 (expect north-a, north-b; total 200)'
SELECT r.seq, e.name, r.cost
FROM route_astar(
        ST_SetSRID(ST_MakePoint(93.60, 27.10), 4326),
        ST_SetSRID(ST_MakePoint(93.64, 27.10), 4326)) r
JOIN road_edges e ON e.id = r.edge_id
ORDER BY r.seq;

\echo '--- 3. nearest_road_edge snaps a report to the closest road'
SELECT e.name, round(n.distance_m) AS metres_away
FROM nearest_road_edge(ST_SetSRID(ST_MakePoint(93.6101, 27.1101), 4326)) n
JOIN road_edges e ON e.id = n.edge_id;

\echo '--- 3b. a report far from any road returns no row (not a wrong edge)'
SELECT count(*) AS rows_returned
FROM nearest_road_edge(ST_SetSRID(ST_MakePoint(90.00, 20.00), 4326));

-- Block the north leg with a verified landslide.
INSERT INTO incidents (geom, kind, status, confidence, blocked_edge, verified_at)
SELECT ST_SetSRID(ST_MakePoint(93.61, 27.11), 4326),
       'landslide', 'verified', 0.93, id, now()
FROM road_edges WHERE name = 'north-a';

\echo '--- 4. blocked edge now costs 999999 in the view, cost column untouched'
SELECT e.name, e.cost AS base_cost, v.cost AS routing_cost, v.blocked
FROM road_edges e JOIN routable_edges v ON v.id = e.id
WHERE e.name IN ('north-a', 'south-a') ORDER BY e.name;

\echo '--- 5. route reroutes south (expect south-a, south-b; total 400)'
SELECT r.seq, e.name, r.cost
FROM route_astar(
        ST_SetSRID(ST_MakePoint(93.60, 27.10), 4326),
        ST_SetSRID(ST_MakePoint(93.64, 27.10), 4326)) r
JOIN road_edges e ON e.id = r.edge_id
ORDER BY r.seq;

-- Clear the incident. No UPDATE on road_edges.cost anywhere.
UPDATE incidents SET status = 'cleared' WHERE status = 'verified';

\echo '--- 6. cleared incident restores the north route with zero cost writes'
SELECT r.seq, e.name, r.cost
FROM route_astar(
        ST_SetSRID(ST_MakePoint(93.60, 27.10), 4326),
        ST_SetSRID(ST_MakePoint(93.64, 27.10), 4326)) r
JOIN road_edges e ON e.id = r.edge_id
ORDER BY r.seq;

\echo '--- 7. risk_weight biases routing without any incident'
UPDATE road_edges SET risk_score = 0.9 WHERE name IN ('north-a', 'north-b');
SELECT r.seq, e.name, e.risk_score
FROM route_astar(
        ST_SetSRID(ST_MakePoint(93.60, 27.10), 4326),
        ST_SetSRID(ST_MakePoint(93.64, 27.10), 4326),
        risk_weight => 3.0) r
JOIN road_edges e ON e.id = r.edge_id
ORDER BY r.seq;

ROLLBACK;
