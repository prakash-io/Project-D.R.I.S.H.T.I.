-- Real alternative routes, and closures that close a road rather than an edge.
--
-- Two measured defects, one cause between them: the platform only ever knew
-- ONE path between two places, so "rerouting" had nothing to reroute onto.
--
-- 1. A VERIFIED INCIDENT BLOCKED A SINGLE EDGE.
--
--    Guwahati -> Shillong is 296 edges / 95,164 m. Blocking edge 150110 --
--    104 m of NH37, the edge a driver standing at the slide snaps to -- and
--    replanning gave 295 edges / 95,171 m, sharing 94,828 m (99.6%) with the
--    route it replaced. The diff is three edges: A* left NH37 and rejoined it
--    7 m later over the parallel carriageway (150108) and two unnamed
--    trunk_links (150109, 150289). The driver was told "rerouted" and sent
--    down the same physical road, through the landslide.
--
--    That is A* behaving correctly. A landslide does not close 104 m of one
--    carriageway; it closes the road. So a closure is now a SET of edges --
--    every edge of the same road family within a radius of the report -- and
--    it lives in `incident_blocked_edges`. Same corridor, same report point,
--    120 m radius: 7 edges close, and the reroute becomes 354 edges /
--    106,540 m sharing 70% -- an 11.4 km detour that diverges around the
--    slide and rejoins. Measured at 230 ms.
--
-- 2. NOTHING COULD ENUMERATE THE ALTERNATIVES.
--
--    pgr_ksp is the obvious answer and it is the wrong one here. Yen's
--    algorithm minimises cost subject to being a different EDGE SEQUENCE,
--    which on a real road graph means four paths that differ by a metre:
--    K=4 on this corridor returned 95,164 / 95,165 / 95,165 / 95,166 m. Four
--    names for one road.
--
--    `route_alternatives` uses iterative penalisation instead: plan, multiply
--    the cost of every edge just used, plan again, and keep a candidate only
--    if it overlaps the accepted set by less than `max_overlap` of its own
--    length. On the same corridor that yields 95,164 m and 98,865 m sharing
--    4,082 m -- 4.1% -- in 549 ms. Two roads, which is what the driver is
--    actually choosing between.
--
-- 3. WHERE THE ALTERNATIVES LIVE.
--
--    `trip_routes` holds them per trip, ranked, with the edge id array. That
--    array is what makes a reroute cheap and honest: the set of closed edges
--    can be intersected against each stored alternative to find the next
--    optimal path that is genuinely clear, without replanning from scratch to
--    discover that it is not.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. A closure is a set of edges
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS incident_blocked_edges (
    incident_id UUID   NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    edge_id     BIGINT NOT NULL REFERENCES road_edges(id) ON DELETE CASCADE,
    -- How far this edge was from the report. Kept so a dispatcher reviewing a
    -- closure can see it reached 118 m up the road rather than guessing, and
    -- so a future radius change can be reasoned about against stored data.
    distance_m  DOUBLE PRECISION,
    PRIMARY KEY (incident_id, edge_id)
);

CREATE INDEX IF NOT EXISTS incident_blocked_edges_edge_idx
    ON incident_blocked_edges (edge_id);

COMMENT ON TABLE incident_blocked_edges IS
    'Every edge a verified incident closes. incidents.blocked_edge remains the '
    'ANCHOR -- the edge the report snapped to -- and is still what the '
    'dispatcher board and the reroute reason report. This table is the road '
    'around it, without which A* rejoins the same highway 7 m later.';

-- ---------------------------------------------------------------------------
-- 2. routable_edges honours the whole closure
-- ---------------------------------------------------------------------------
--
-- Unchanged in every other respect from 006, deliberately: still a hash join
-- against a gathered set rather than a per-edge LATERAL (that shape cost
-- 1.7 s per routing call), still 999999 rather than a negative cost or a
-- deletion, still TRUE-or-NULL on `blocked`, and still ONLY 'verified'. An
-- incident sitting in pending_dispatcher_approval must not move a single
-- truck -- that is decision 5 in CLAUDE.md and this view is where it is
-- enforced.
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
    CASE WHEN b.edge_id IS NOT NULL THEN TRUE END AS blocked
FROM road_edges e
LEFT JOIN (
    -- The anchor edge, exactly as before...
    SELECT DISTINCT blocked_edge AS edge_id
      FROM incidents
     WHERE status = 'verified' AND blocked_edge IS NOT NULL
    UNION
    -- ...and the rest of the road it closed.
    SELECT DISTINCT be.edge_id
      FROM incident_blocked_edges be
      JOIN incidents i ON i.id = be.incident_id
     WHERE i.status = 'verified'
) b ON b.edge_id = e.id;

COMMENT ON VIEW routable_edges IS
    'Edge set for pgr_aStar. Applies the 999999 blocked-edge cost without '
    'mutating road_edges.cost, so clearing an incident restores routing. '
    'Covers the incident anchor edge AND incident_blocked_edges, because a '
    'closure that is one 104 m edge wide is one A* hop wide.';

-- ---------------------------------------------------------------------------
-- 3. Which edges a closure at a point takes out
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION road_closure_edges(
    pt        GEOMETRY,
    radius_m  DOUBLE PRECISION DEFAULT 120,
    -- How far the report may be from any road before this gives up. Matches
    -- nearest_road_edge's own default; a report further out is bad GPS and
    -- snapToEdge has already rejected it before this is reached.
    snap_m    DOUBLE PRECISION DEFAULT 200
)
RETURNS TABLE (edge_id BIGINT, distance_m DOUBLE PRECISION)
LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE
    anchor_geom GEOMETRY;
    anchor_fam  TEXT;
    at_road     GEOMETRY;
    -- The radius as a bounding box in degrees, generous by design: it only
    -- has to be an over-estimate, because ST_DWithin on the geography below
    -- does the exact test. Latitude degrees are ~111.3 km everywhere and
    -- longitude degrees are SHORTER away from the equator, so dividing by the
    -- latitude figure over-covers in longitude, which is the safe direction.
    box_deg     DOUBLE PRECISION := radius_m / 111320.0;
BEGIN
    -- The road the driver is standing on.
    --
    -- `ORDER BY geom <-> pt LIMIT 1` alone, with the distance checked
    -- AFTERWARDS -- not `WHERE ST_DWithin(geom::geography, ...)` in front of
    -- it. That cast is what makes this slow: a geography predicate cannot use
    -- the GIST index on `geom`, so the filter degenerates to a sequential
    -- scan of 486,784 edges and the whole function measured 2.6 s. The bare
    -- KNN operator is an index scan.
    SELECT e.geom, regexp_replace(coalesce(e.highway, 'road'), '_link$', '')
      INTO anchor_geom, anchor_fam
      FROM road_edges e
     ORDER BY e.geom <-> pt
     LIMIT 1;

    IF anchor_geom IS NULL
       OR ST_Distance(anchor_geom::geography, pt::geography) > snap_m THEN
        RETURN;
    END IF;

    -- Measured from the point ON the road, not from the reported fix. A
    -- report 40 m off the carriageway would otherwise spend 40 m of the
    -- radius getting back to the road it is about.
    at_road := ST_ClosestPoint(anchor_geom, pt);

    -- Same FAMILY, not same name. The three edges that let A* slip around the
    -- landslide were an unnamed trunk_link, another unnamed trunk_link, and
    -- the parallel NH37 carriageway; matching on `name` would have closed one
    -- of the three. '_link$' is stripped so a slip road closes with the trunk
    -- it serves, while a residential street or a footpath crossing 30 m away
    -- keeps its own family and stays open -- which matters, because those are
    -- exactly the edges a detour needs.
    --
    -- `&&` first so the index does the work, THEN the exact geography
    -- distance on the handful of edges that survive.
    RETURN QUERY
    SELECT e.id, ST_Distance(e.geom::geography, at_road::geography)
      FROM road_edges e
     WHERE e.geom && ST_Expand(at_road, box_deg)
       AND regexp_replace(coalesce(e.highway, 'road'), '_link$', '') = anchor_fam
       AND ST_DWithin(e.geom::geography, at_road::geography, radius_m)
     ORDER BY 2;
END;
$$;

COMMENT ON FUNCTION road_closure_edges(GEOMETRY, DOUBLE PRECISION, DOUBLE PRECISION) IS
    'The edges a hazard at `pt` closes: everything of the same road family '
    'within `radius_m` of the point where the report meets the carriageway. '
    'Blocking only the snapped edge let A* rejoin the same highway 7 m later '
    'over the parallel carriageway and two slip roads.';

-- ---------------------------------------------------------------------------
-- 4. Genuinely distinct alternative routes
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    CREATE TYPE route_alt_step AS (
        alt INTEGER, seq INTEGER, edge BIGINT, cost DOUBLE PRECISION);
EXCEPTION
    WHEN duplicate_object THEN NULL;
END;
$$;

COMMENT ON TYPE route_alt_step IS
    'One hop of one alternative, held in an array inside route_alternatives. '
    'An array and not a temp table for the reason migration 005 documents: a '
    'STABLE function may not run DDL, and marking it VOLATILE to make a temp '
    'table legal would stop the planner treating repeated calls as stable.';

CREATE OR REPLACE FUNCTION route_alternatives(
    start_pt         GEOMETRY,
    end_pt           GEOMETRY,
    k                INTEGER DEFAULT 3,
    risk_weight      DOUBLE PRECISION DEFAULT 0,
    -- Edges the route may not use AT ALL. This is not the 999999 cost: that
    -- is a very expensive road and A* will still drive down it when the
    -- alternative costs more, which is the correct behaviour for a risk
    -- weighting and the wrong one for a landslide.
    avoid_edges      BIGINT[] DEFAULT '{}',
    -- A candidate is kept only if it shares less than this fraction of its
    -- own length with the routes already accepted. 0.6 was chosen against
    -- the measurement above: the real Guwahati-Shillong alternative shares
    -- 4%, the fake ones pgr_ksp produced share over 99%.
    max_overlap      DOUBLE PRECISION DEFAULT 0.6,
    -- What an edge already used costs on the next attempt. Enough to push
    -- the search onto another road, not so much that it takes an absurd
    -- detour to avoid one shared junction.
    penalty          DOUBLE PRECISION DEFAULT 4.0,
    heuristic_factor DOUBLE PRECISION DEFAULT 111320,
    corridor_m       DOUBLE PRECISION DEFAULT 25000
)
RETURNS TABLE (
    alt       INTEGER,
    seq       INTEGER,
    edge_id   BIGINT,
    cost      DOUBLE PRECISION,
    edge_geom GEOMETRY
)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_start    BIGINT := nearest_road_node(start_pt);
    v_end      BIGINT := nearest_road_node(end_pt);
    c_start    BIGINT;
    c_end      BIGINT;
    margin     DOUBLE PRECISION := corridor_m / 111320.0;
    box        GEOMETRY;
    steps      route_step[];
    results    route_alt_step[] := '{}';
    penalised  BIGINT[] := '{}';
    accepted   BIGINT[] := '{}';
    n_accepted INTEGER := 0;
    attempt    INTEGER := 0;
    max_tries  INTEGER;
    total_m    DOUBLE PRECISION;
    shared_m   DOUBLE PRECISION;
    step       route_step;
BEGIN
    IF k < 1 THEN
        RETURN;
    END IF;
    -- Two spare attempts, not k*4. Each attempt is a full A* over the
    -- corridor -- ~450 ms on this graph -- and a pair of endpoints with only
    -- one road between them will reject every candidate no matter how long it
    -- is given. Failing fast is what keeps a dispatcher's approval click
    -- inside a couple of seconds.
    max_tries := k + 2;

    IF v_start IS NULL OR v_end IS NULL THEN
        RAISE EXCEPTION 'road graph is empty -- run scripts/ingest_geo.py (DB-02)';
    END IF;

    -- Same discrimination route_astar makes, and for the same reason: an
    -- unreachable pair must not read as "everything is blocked".
    SELECT component INTO c_start FROM road_nodes WHERE id = v_start;
    SELECT component INTO c_end   FROM road_nodes WHERE id = v_end;
    IF c_start IS NOT NULL AND c_end IS NOT NULL AND c_start <> c_end THEN
        RAISE EXCEPTION
            'no route: origin is in road component % and destination in %, '
            'which are not connected in this extract', c_start, c_end;
    END IF;

    box := ST_Expand(ST_Envelope(ST_Collect(start_pt, end_pt)), margin);

    WHILE attempt < max_tries AND n_accepted < k LOOP
        attempt := attempt + 1;

        EXECUTE format(
            'SELECT array_agg(ROW(r.seq, r.edge, r.cost)::route_step ORDER BY r.seq)
               FROM pgr_aStar(%L, %s, %s, directed => TRUE, heuristic => 2,
                              factor => %s) AS r
              WHERE r.edge <> -1',
            format(
                'SELECT id, source, target,
                        cost * (1 + %1$s * risk_score)
                             * CASE WHEN id = ANY(%2$L::bigint[]) THEN %3$s ELSE 1 END
                          AS cost,
                        reverse_cost * (1 + %1$s * risk_score)
                             * CASE WHEN id = ANY(%2$L::bigint[]) THEN %3$s ELSE 1 END
                          AS reverse_cost,
                        x1, y1, x2, y2
                   FROM routable_edges
                  WHERE NOT (id = ANY(%4$L::bigint[]))
                    AND geom && ST_SetSRID(ST_MakeEnvelope(%5$s, %6$s, %7$s, %8$s), 4326)',
                risk_weight, penalised, penalty, avoid_edges,
                ST_XMin(box), ST_YMin(box), ST_XMax(box), ST_YMax(box)),
            v_start, v_end, heuristic_factor)
        INTO steps;

        -- The corridor is an optimisation, not a constraint (migration 005).
        -- Retried only on the FIRST attempt: once one route is in hand, a
        -- whole-graph search for a second one costs seconds and the answer is
        -- an alternative, not the route the truck needs.
        IF steps IS NULL AND attempt = 1 THEN
            EXECUTE format(
                'SELECT array_agg(ROW(r.seq, r.edge, r.cost)::route_step ORDER BY r.seq)
                   FROM pgr_aStar(%L, %s, %s, directed => TRUE, heuristic => 2,
                                  factor => %s) AS r
                  WHERE r.edge <> -1',
                format(
                    'SELECT id, source, target,
                            cost * (1 + %1$s * risk_score) AS cost,
                            reverse_cost * (1 + %1$s * risk_score) AS reverse_cost,
                            x1, y1, x2, y2
                       FROM routable_edges
                      WHERE NOT (id = ANY(%2$L::bigint[]))',
                    risk_weight, avoid_edges),
                v_start, v_end, heuristic_factor)
            INTO steps;
        END IF;

        -- No path at all under this penalty. Nothing further to diverge from.
        EXIT WHEN steps IS NULL;

        SELECT sum(ST_Length(e.geom::geography)),
               coalesce(sum(ST_Length(e.geom::geography))
                        FILTER (WHERE e.id = ANY(accepted)), 0)
          INTO total_m, shared_m
          FROM unnest(steps) s
          JOIN road_edges e ON e.id = s.edge;

        IF n_accepted = 0
           OR (total_m > 0 AND shared_m / total_m <= max_overlap) THEN
            n_accepted := n_accepted + 1;
            FOREACH step IN ARRAY steps LOOP
                results := results
                    || ROW(n_accepted, step.seq, step.edge, step.cost)::route_alt_step;
                accepted := accepted || step.edge;
            END LOOP;
        END IF;

        -- Penalised whether or not it was accepted. A rejected candidate is a
        -- road we have already looked at, and leaving it cheap makes the next
        -- attempt return it again -- which is how a loop that is bounded by
        -- attempts silently becomes a loop that returns one route.
        FOREACH step IN ARRAY steps LOOP
            penalised := penalised || step.edge;
        END LOOP;
    END LOOP;

    RETURN QUERY
    SELECT s.alt, s.seq, s.edge, s.cost, e.geom
      FROM unnest(results) AS s
      LEFT JOIN road_edges e ON e.id = s.edge
     ORDER BY s.alt, s.seq;
END;
$$;

COMMENT ON FUNCTION route_alternatives(GEOMETRY, GEOMETRY, INTEGER, DOUBLE PRECISION,
                                       BIGINT[], DOUBLE PRECISION, DOUBLE PRECISION,
                                       DOUBLE PRECISION, DOUBLE PRECISION) IS
    'Up to k genuinely distinct paths by iterative edge penalisation. Not '
    'pgr_ksp: Yen''s algorithm returned four paths differing by 1 m on the '
    'Guwahati-Shillong corridor, because "a different edge sequence" is not '
    '"a different road". Candidates sharing more than max_overlap of their '
    'own length with an accepted route are rejected and penalised.';

-- ---------------------------------------------------------------------------
-- 5. The alternatives a trip was planned with
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS trip_routes (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_id      UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    -- 1 is the optimal route, 2 the next best distinct one, and so on. Rank
    -- is by cost at planning time and does not change; whether a route is the
    -- one being driven is `is_active`, which does.
    rank         INTEGER NOT NULL,
    geom         GEOMETRY(LineString, 4326) NOT NULL,
    distance_m   DOUBLE PRECISION,
    duration_sec DOUBLE PRECISION,
    -- The edges this path uses. A closure is a set of edge ids, so "is this
    -- alternative still clear?" is an array intersection rather than a
    -- replan, which is what lets the next optimal route be offered in
    -- milliseconds at the moment a dispatcher approves a hazard.
    edge_ids     BIGINT[] NOT NULL DEFAULT '{}',
    is_active    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (trip_id, rank)
);

CREATE INDEX IF NOT EXISTS trip_routes_trip_idx ON trip_routes (trip_id, rank);
CREATE INDEX IF NOT EXISTS trip_routes_active_idx ON trip_routes (trip_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS trip_routes_edges_idx ON trip_routes USING GIN (edge_ids);

COMMENT ON TABLE trip_routes IS
    'Every distinct route found between a trip''s two ends, ranked by cost. '
    'trips.planned_route stays the single authoritative path the truck is on; '
    'this is the set it was chosen from, so a reroute has somewhere to go.';

COMMIT;
