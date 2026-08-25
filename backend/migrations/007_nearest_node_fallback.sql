-- nearest_road_node must not fail on nodes with no component assigned.
--
-- 003 made snapping prefer the main connected component, so a truck parked on
-- an unconnected service road routes from a node it can actually leave. It
-- handled the case where components have never been computed (main IS NULL),
-- but not the one in between: components computed for SOME nodes while the
-- candidates near this point have component IS NULL.
--
-- That is not hypothetical. It is the state of the graph:
--
--   * immediately after scripts/ingest_geo.py, before rebuild_road_components()
--   * for any node added since the last rebuild
--   * inside backend/migrations/smoke_test.sql, which inserts a 4-edge test
--     graph in a rolled-back transaction and never computes components
--
-- In all three the filtered lookup returned no row, route_astar saw a NULL
-- start node and raised "road graph is empty -- run scripts/ingest_geo.py",
-- which is both wrong and misleading: the graph is populated, the metadata
-- simply is not. Caught by the smoke test against the freshly loaded network.
--
-- The preference is now a preference: fall back to the literal nearest node.

BEGIN;

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
    IF main_component_only THEN
        main := main_road_component();
        IF main IS NOT NULL THEN
            SELECT id INTO node
            FROM road_nodes WHERE component = main
            ORDER BY geom <-> pt LIMIT 1;
        END IF;
    END IF;

    -- Fallback, reached when components were never computed, when they are
    -- stale, or when nothing in the main component is near enough to have
    -- been indexed yet. Returning the nearest node beats returning NULL,
    -- which callers cannot distinguish from an empty graph.
    IF node IS NULL THEN
        SELECT id INTO node FROM road_nodes ORDER BY geom <-> pt LIMIT 1;
    END IF;

    RETURN node;
END;
$$;

COMMENT ON FUNCTION nearest_road_node(GEOMETRY, BOOLEAN) IS
    'Nearest graph vertex, preferring the main connected component so the '
    'result is somewhere a route can actually start. Falls back to the '
    'literal nearest node when component data is missing or stale.';

COMMIT;
