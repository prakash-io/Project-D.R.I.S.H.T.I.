-- Component awareness and a bounded A* search.
--
-- Two problems the first full ingest exposed, both invisible until there was
-- real data in the graph:
--
-- 1. The road network is not one connected piece. 486,784 edges over 412,914
--    nodes fall into 1,194 components: one holding 96.22% of nodes, a second
--    with 1.55%, and 1,030 islands of 2-9 nodes. Those islands are driveways,
--    service loops and roads clipped at the extract boundary.
--
--    `nearest_road_node` happily snaps a truck onto one. Routing from it then
--    returns zero rows -- indistinguishable, to a caller, from "no route
--    exists because everything is blocked". Snapping now prefers the main
--    component, so a truck parked on an unconnected service road routes from
--    the nearest node that can actually be left.
--
-- 2. pgr_aStar reads its ENTIRE edge set on every call. Measured on the full
--    graph: 2.9 s for Guwahati -> Shillong and 1.4 s for Guwahati -> Imphal,
--    almost all of it fetching 486,784 rows rather than searching them. Too
--    slow to sit in a dispatcher's reroute click.
--
--    route_astar now restricts the edge set to the envelope of the two
--    endpoints, expanded by a margin, and falls back to the unrestricted
--    graph if that finds nothing. The fallback is what keeps it correct: a
--    detour around a landslide can legitimately leave the corridor.

BEGIN;

-- ====================================================== node components

ALTER TABLE road_nodes ADD COLUMN IF NOT EXISTS component BIGINT;

CREATE INDEX IF NOT EXISTS road_nodes_component_idx ON road_nodes (component);
-- Backs the "nearest node I can actually route from" lookup below.
CREATE INDEX IF NOT EXISTS road_nodes_main_component_geom_idx
    ON road_nodes USING GIST (geom) INCLUDE (component);

COMMENT ON COLUMN road_nodes.component IS
    'Undirected connected component id from pgr_connectedComponents. Nodes in '
    'different components have no route between them at any cost.';

-- Recompute after every ingest, alongside rebuild_road_nodes().
CREATE OR REPLACE FUNCTION rebuild_road_components()
RETURNS TABLE (components BIGINT, largest_component BIGINT, largest_nodes BIGINT)
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE road_nodes n
    SET component = c.component
    FROM pgr_connectedComponents(
        'SELECT id, source, target, cost, reverse_cost FROM road_edges') c
    WHERE n.id = c.node;

    RETURN QUERY
    WITH sizes AS (
        SELECT component AS id, count(*) AS n
        FROM road_nodes WHERE component IS NOT NULL GROUP BY component
    )
    SELECT (SELECT count(*) FROM sizes),
           (SELECT id FROM sizes ORDER BY n DESC LIMIT 1),
           (SELECT n  FROM sizes ORDER BY n DESC LIMIT 1);
END;
$$;

-- The component holding most of the network. Cached in a one-row table
-- rather than recomputed: it is read on every routing call, and a GROUP BY
-- over 412,914 nodes per reroute is exactly the kind of cost that hides.
CREATE TABLE IF NOT EXISTS road_graph_meta (
    only_row      BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (only_row),
    main_component BIGINT,
    node_count    BIGINT,
    edge_count    BIGINT,
    refreshed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION refresh_road_graph_meta()
RETURNS BIGINT
LANGUAGE plpgsql AS $$
DECLARE
    main BIGINT;
BEGIN
    SELECT component INTO main
    FROM road_nodes WHERE component IS NOT NULL
    GROUP BY component ORDER BY count(*) DESC LIMIT 1;

    INSERT INTO road_graph_meta (only_row, main_component, node_count, edge_count, refreshed_at)
    VALUES (TRUE, main,
            (SELECT count(*) FROM road_nodes),
            (SELECT count(*) FROM road_edges), now())
    ON CONFLICT (only_row) DO UPDATE
        SET main_component = EXCLUDED.main_component,
            node_count     = EXCLUDED.node_count,
            edge_count     = EXCLUDED.edge_count,
            refreshed_at   = EXCLUDED.refreshed_at;
    RETURN main;
END;
$$;

CREATE OR REPLACE FUNCTION main_road_component()
RETURNS BIGINT
LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT main_component FROM road_graph_meta WHERE only_row;
$$;

-- ============================================== component-aware snapping

DROP FUNCTION IF EXISTS nearest_road_node(GEOMETRY);

CREATE OR REPLACE FUNCTION nearest_road_node(
    pt GEOMETRY,
    -- FALSE snaps to the literal nearest node, including one on an island.
    -- Useful for map-matching a position; wrong for choosing a route origin.
    main_component_only BOOLEAN DEFAULT TRUE
)
RETURNS BIGINT
LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE
    main BIGINT;
    node BIGINT;
BEGIN
    IF NOT main_component_only THEN
        SELECT id INTO node FROM road_nodes ORDER BY geom <-> pt LIMIT 1;
        RETURN node;
    END IF;

    main := main_road_component();
    IF main IS NULL THEN
        -- Components never computed. Degrade to the plain nearest node rather
        -- than returning NULL and looking like an empty graph.
        SELECT id INTO node FROM road_nodes ORDER BY geom <-> pt LIMIT 1;
        RETURN node;
    END IF;

    SELECT id INTO node
    FROM road_nodes WHERE component = main
    ORDER BY geom <-> pt LIMIT 1;
    RETURN node;
END;
$$;

-- ============================================== bounded A*

CREATE OR REPLACE FUNCTION route_astar(
    start_pt    GEOMETRY,
    end_pt      GEOMETRY,
    risk_weight DOUBLE PRECISION DEFAULT 0,
    heuristic_factor DOUBLE PRECISION DEFAULT 111320,
    -- How far outside the straight line between the endpoints the search may
    -- wander, in metres. 25 km comfortably covers a valley detour; anything
    -- larger is found by the unrestricted retry below.
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
    v_start   BIGINT := nearest_road_node(start_pt);
    v_end     BIGINT := nearest_road_node(end_pt);
    c_start   BIGINT;
    c_end     BIGINT;
    margin    DOUBLE PRECISION := corridor_m / 111320.0;   -- metres -> degrees
    box       GEOMETRY;
    edge_sql  TEXT;
    found     BIGINT := 0;
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

    CREATE TEMP TABLE IF NOT EXISTS _route_hit (seq INTEGER, edge BIGINT,
                                                cost DOUBLE PRECISION)
        ON COMMIT DROP;
    TRUNCATE _route_hit;

    INSERT INTO _route_hit
    SELECT r.seq, r.edge, r.cost
    FROM pgr_aStar(edge_sql, v_start, v_end,
                   directed => TRUE, heuristic => 2, factor => heuristic_factor) AS r
    WHERE r.edge <> -1;
    GET DIAGNOSTICS found = ROW_COUNT;

    -- The corridor is an optimisation, not a constraint. If nothing was found
    -- inside it the answer may still exist outside, so retry on the whole
    -- graph rather than reporting a blocked road that is merely far away.
    IF found = 0 THEN
        INSERT INTO _route_hit
        SELECT r.seq, r.edge, r.cost
        FROM pgr_aStar(
                format('SELECT id, source, target,
                               cost * (1 + %1$s * risk_score) AS cost,
                               reverse_cost * (1 + %1$s * risk_score) AS reverse_cost,
                               x1, y1, x2, y2
                        FROM routable_edges', risk_weight),
                v_start, v_end,
                directed => TRUE, heuristic => 2, factor => heuristic_factor) AS r
        WHERE r.edge <> -1;
    END IF;

    RETURN QUERY
    SELECT h.seq, h.edge, h.cost, e.geom
    FROM _route_hit h LEFT JOIN road_edges e ON e.id = h.edge
    ORDER BY h.seq;
END;
$$;

COMMIT;
