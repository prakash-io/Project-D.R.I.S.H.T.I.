-- Make routable_edges cheap enough to route on.
--
-- The view is what pgr_aStar reads on every call, and scanning it cost
-- 1,866 ms against 140 ms for road_edges itself -- a 13x penalty paid on
-- every reroute, with ZERO incidents in the table.
--
-- The cause is the shape, not the data. 001 wrote:
--
--     LEFT JOIN LATERAL (
--         SELECT TRUE FROM incidents i
--         WHERE i.blocked_edge = e.id AND i.status = 'verified' LIMIT 1
--     ) b ON TRUE
--
-- A LATERAL subquery is correlated, so it is evaluated once per edge --
-- 486,784 index probes to discover that almost nothing is blocked. The set of
-- blocking incidents is tiny and does not depend on the edge, so it can be
-- gathered ONCE and hash-joined instead.
--
-- Semantics are unchanged, deliberately including the NULL: `blocked` is TRUE
-- for a blocked edge and NULL otherwise, exactly as before, so smoke_test.sql
-- and any caller reading it keep working.

BEGIN;

CREATE OR REPLACE VIEW routable_edges AS
SELECT
    e.id,
    e.source,
    e.target,
    CASE WHEN b.edge_id IS NOT NULL THEN 999999 ELSE e.cost END         AS cost,
    CASE WHEN b.edge_id IS NOT NULL THEN 999999 ELSE e.reverse_cost END AS reverse_cost,
    e.x1, e.y1, e.x2, e.y2,
    e.geom,
    e.name,
    e.risk_score,
    -- TRUE or NULL, never FALSE -- unchanged from 001.
    CASE WHEN b.edge_id IS NOT NULL THEN TRUE END AS blocked
FROM road_edges e
LEFT JOIN (
    -- Gathered once. Only 'verified' blocks: an incident sitting in
    -- 'pending_dispatcher_approval' has been seen by the model but not yet
    -- confirmed by a human, and must not change a single route.
    SELECT DISTINCT blocked_edge AS edge_id
    FROM incidents
    WHERE status = 'verified' AND blocked_edge IS NOT NULL
) b ON b.edge_id = e.id;

COMMENT ON VIEW routable_edges IS
    'Edge set for pgr_aStar. Applies the 999999 blocked-edge cost without '
    'mutating road_edges.cost, so clearing an incident restores routing. '
    'Hash-joined against the blocking set rather than a per-edge LATERAL, '
    'which cost 1.7 s per routing call on 486k edges.';

COMMIT;
