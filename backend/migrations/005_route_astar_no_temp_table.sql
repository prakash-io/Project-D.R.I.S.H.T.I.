-- Rewrite route_astar without a temp table.
--
-- 003 collected the A* result into `CREATE TEMP TABLE ... ON COMMIT DROP` so
-- it could test whether the bounded search found anything before falling back
-- to the whole graph. That fails at run time on every call:
--
--   ERROR: CREATE TABLE is not allowed in a non-volatile function
--
-- The function is STABLE, which is correct -- it only reads -- and a STABLE
-- function may not create tables. Marking it VOLATILE to make the temp table
-- legal would be fixing the wrong end: it would also stop the planner from
-- treating repeated calls as stable within a statement.
--
-- The result is collected into an array of a composite type instead. Same
-- two-phase behaviour, no DDL, still STABLE.

BEGIN;

DO $$
BEGIN
    CREATE TYPE route_step AS (seq INTEGER, edge BIGINT, cost DOUBLE PRECISION);
EXCEPTION
    WHEN duplicate_object THEN NULL;
END;
$$;

COMMENT ON TYPE route_step IS
    'One hop of an A* result, used to hold a route in memory inside '
    'route_astar without a temp table.';

CREATE OR REPLACE FUNCTION route_astar(
    start_pt    GEOMETRY,
    end_pt      GEOMETRY,
    risk_weight DOUBLE PRECISION DEFAULT 0,
    heuristic_factor DOUBLE PRECISION DEFAULT 111320,
    corridor_m  DOUBLE PRECISION DEFAULT 25000
)
RETURNS TABLE (
    seq       INTEGER,
    edge_id   BIGINT,
    cost      DOUBLE PRECISION,
    edge_geom GEOMETRY
)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_start  BIGINT := nearest_road_node(start_pt);
    v_end    BIGINT := nearest_road_node(end_pt);
    c_start  BIGINT;
    c_end    BIGINT;
    margin   DOUBLE PRECISION := corridor_m / 111320.0;   -- metres -> degrees
    box      GEOMETRY;
    edge_sql TEXT;
    steps    route_step[];
BEGIN
    IF v_start IS NULL OR v_end IS NULL THEN
        RAISE EXCEPTION 'road graph is empty -- run scripts/ingest_geo.py (DB-02)';
    END IF;

    -- Different components means no path exists at any cost. Saying so beats
    -- returning zero rows, which reads as "everything is blocked".
    SELECT component INTO c_start FROM road_nodes WHERE id = v_start;
    SELECT component INTO c_end   FROM road_nodes WHERE id = v_end;
    IF c_start IS NOT NULL AND c_end IS NOT NULL AND c_start <> c_end THEN
        RAISE EXCEPTION
            'no route: origin is in road component % and destination in %, '
            'which are not connected in this extract', c_start, c_end;
    END IF;

    box := ST_Expand(ST_Envelope(ST_Collect(start_pt, end_pt)), margin);

    edge_sql := format(
        'SELECT id, source, target,
                cost * (1 + %1$s * risk_score) AS cost,
                reverse_cost * (1 + %1$s * risk_score) AS reverse_cost,
                x1, y1, x2, y2
         FROM routable_edges
         WHERE geom && ST_SetSRID(ST_MakeEnvelope(%2$s, %3$s, %4$s, %5$s), 4326)',
        risk_weight,
        ST_XMin(box), ST_YMin(box), ST_XMax(box), ST_YMax(box));

    EXECUTE format(
        'SELECT array_agg(ROW(r.seq, r.edge, r.cost)::route_step ORDER BY r.seq)
         FROM pgr_aStar(%L, %s, %s, directed => TRUE, heuristic => 2,
                        factor => %s) AS r
         WHERE r.edge <> -1',
        edge_sql, v_start, v_end, heuristic_factor)
    INTO steps;

    -- The corridor is an optimisation, not a constraint. If nothing was found
    -- inside it the answer may still exist outside, so retry on the whole
    -- graph rather than reporting a blocked road that is merely far away.
    IF steps IS NULL THEN
        EXECUTE format(
            'SELECT array_agg(ROW(r.seq, r.edge, r.cost)::route_step ORDER BY r.seq)
             FROM pgr_aStar(%L, %s, %s, directed => TRUE, heuristic => 2,
                            factor => %s) AS r
             WHERE r.edge <> -1',
            format('SELECT id, source, target,
                           cost * (1 + %1$s * risk_score) AS cost,
                           reverse_cost * (1 + %1$s * risk_score) AS reverse_cost,
                           x1, y1, x2, y2
                    FROM routable_edges', risk_weight),
            v_start, v_end, heuristic_factor)
        INTO steps;
    END IF;

    IF steps IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT s.seq, s.edge, s.cost, e.geom
    FROM unnest(steps) AS s
    LEFT JOIN road_edges e ON e.id = s.edge
    ORDER BY s.seq;
END;
$$;

COMMIT;
