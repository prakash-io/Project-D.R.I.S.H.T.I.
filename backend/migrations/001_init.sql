-- D.R.I.S.H.T.I. core schema
-- Requires PostgreSQL 12+ (generated columns) and the pgrouting/pgrouting
-- image, which bundles PostGIS *and* pgRouting. The plain postgis/postgis
-- image does not ship pgRouting and will fail on the extension below.
--
-- Conventions:
--   * All geometry is EPSG:4326. Reproject on ingest, never at query time.
--   * Cast to ::geography when you need metres.

BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgrouting;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================ fleet

-- Named `trucks` to match the Socket.IO payload contract
-- `{ truck_id, lat, lng, speed, timestamp }`.
CREATE TABLE trucks (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    plate         TEXT NOT NULL UNIQUE,
    driver_name   TEXT,
    phone         TEXT,
    -- Bhashini TTS language for reroute alerts (ISO 639-1).
    -- as = Assamese, hi = Hindi, en = English.
    alert_lang    TEXT NOT NULL DEFAULT 'hi'
                  CHECK (alert_lang IN ('as', 'hi', 'en')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE trips (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    truck_id      UUID NOT NULL REFERENCES trucks(id) ON DELETE CASCADE,
    origin        GEOMETRY(Point, 4326) NOT NULL,
    destination   GEOMETRY(Point, 4326) NOT NULL,
    planned_route GEOMETRY(LineString, 4326),
    status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'completed', 'aborted')),
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at      TIMESTAMPTZ
);

CREATE INDEX trips_truck_status_idx ON trips (truck_id, status)
    WHERE status = 'active';

-- ============================================================ telemetry

-- One row per fix.
--
-- `source` is the crux of the system. Note that the Kalman filter runs in
-- BOTH modes (workflow §1 and §2) -- the distinction is what it is filtering:
--   'gps' -> online: KF-smoothed GNSS. Trusted, covariance_m2 is NULL.
--   'ekf' -> dark zone: dead reckoning from TFLite velocity + gyro heading.
--            Drifts over time, so covariance_m2 is always populated and the
--            dashboard renders an uncertainty halo from it.
CREATE TABLE telemetry (
    id            BIGSERIAL PRIMARY KEY,
    trip_id       UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    truck_id      UUID NOT NULL REFERENCES trucks(id) ON DELETE CASCADE,
    geom          GEOMETRY(Point, 4326) NOT NULL,
    source        TEXT NOT NULL CHECK (source IN ('gps', 'ekf')),
    speed_mps     REAL,
    heading_deg   REAL,
    -- EKF position variance (m^2). NULL for GPS fixes.
    covariance_m2 REAL,
    -- TRUE once the on-device map-matcher has snapped the point to the
    -- cached road graph. Unsnapped 'ekf' points are raw dead reckoning.
    map_matched   BOOLEAN NOT NULL DEFAULT FALSE,
    -- Device clock at capture. Deliberately distinct from ingested_at:
    -- burst-synced dark-zone points arrive minutes to hours late, so
    -- ordering a track by ingest time scrambles it. Always order by captured_at.
    captured_at   TIMESTAMPTZ NOT NULL,
    ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Client-generated UUID. Makes burst sync idempotent: the worker retries
    -- a failed job by replaying the whole batch, and ON CONFLICT DO NOTHING
    -- against this index drops the already-written rows.
    client_uid    UUID NOT NULL,

    CONSTRAINT telemetry_ekf_has_covariance
        CHECK (source <> 'ekf' OR covariance_m2 IS NOT NULL)
);

CREATE UNIQUE INDEX telemetry_client_uid_idx ON telemetry (client_uid);
CREATE INDEX telemetry_trip_time_idx ON telemetry (trip_id, captured_at DESC);
CREATE INDEX telemetry_geom_idx ON telemetry USING GIST (geom);

-- Hot table for the dashboard's first paint, so it never scans telemetry.
CREATE TABLE truck_last_seen (
    truck_id      UUID PRIMARY KEY REFERENCES trucks(id) ON DELETE CASCADE,
    trip_id       UUID REFERENCES trips(id) ON DELETE SET NULL,
    geom          GEOMETRY(Point, 4326) NOT NULL,
    source        TEXT NOT NULL,
    speed_mps     REAL,
    captured_at   TIMESTAMPTZ NOT NULL
);

-- ============================================== routable road network

-- Populated by scripts/ingest_geo.py (GeoPandas -> PostGIS, task DB-02).
--
-- x1/y1/x2/y2 are NOT optional bookkeeping: pgr_aStar's heuristic needs the
-- endpoint coordinates of every edge, and unlike pgr_dijkstra it will not
-- run without them. They are generated from geom so they cannot drift out
-- of sync with the geometry.
CREATE TABLE road_edges (
    id            BIGSERIAL PRIMARY KEY,
    source        BIGINT NOT NULL,
    target        BIGINT NOT NULL,
    -- Base traversal cost from the source network. Never overwritten by an
    -- incident -- see routable_edges below for why.
    cost          DOUBLE PRECISION NOT NULL,
    reverse_cost  DOUBLE PRECISION NOT NULL,
    geom          GEOMETRY(LineString, 4326) NOT NULL,
    name          TEXT,
    osm_id        BIGINT,

    x1 DOUBLE PRECISION GENERATED ALWAYS AS (ST_X(ST_StartPoint(geom))) STORED,
    y1 DOUBLE PRECISION GENERATED ALWAYS AS (ST_Y(ST_StartPoint(geom))) STORED,
    x2 DOUBLE PRECISION GENERATED ALWAYS AS (ST_X(ST_EndPoint(geom)))   STORED,
    y2 DOUBLE PRECISION GENERATED ALWAYS AS (ST_Y(ST_EndPoint(geom)))   STORED,

    -- Rolling output of the XGBoost job (ML-04). 0..1.
    risk_score    REAL NOT NULL DEFAULT 0 CHECK (risk_score BETWEEN 0 AND 1),
    risk_updated  TIMESTAMPTZ
);

CREATE INDEX road_edges_source_idx ON road_edges (source);
CREATE INDEX road_edges_target_idx ON road_edges (target);
CREATE INDEX road_edges_geom_idx   ON road_edges USING GIST (geom);
-- Partial index backing the dashboard's red-segment overlay (WEB-04).
CREATE INDEX road_edges_high_risk_idx ON road_edges (risk_score DESC)
    WHERE risk_score >= 0.85;

-- Graph vertices. Derived from edge endpoints rather than relying on
-- pgr_createTopology, so the node ids match whatever the parquet import
-- assigned to source/target instead of being renumbered underneath it.
CREATE TABLE road_nodes (
    id            BIGINT PRIMARY KEY,
    geom          GEOMETRY(Point, 4326) NOT NULL
);

CREATE INDEX road_nodes_geom_idx ON road_nodes USING GIST (geom);

-- ============================================================ incidents

-- Classes match the YOLOv8 model's output (ML-05). The class *order* in the
-- dataset's data.yaml is load-bearing -- the backend maps class index to
-- this enum, so reordering it relabels historical incidents.
CREATE TABLE incidents (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    reported_by   UUID REFERENCES trucks(id) ON DELETE SET NULL,
    geom          GEOMETRY(Point, 4326) NOT NULL,
    kind          TEXT NOT NULL
                  CHECK (kind IN ('landslide', 'flood', 'obstruction')),
    photo_path    TEXT,
    -- Set by the FastAPI/YOLOv8 verifier, never by the driver.
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'verified', 'rejected', 'cleared')),
    confidence    REAL CHECK (confidence BETWEEN 0 AND 1),
    -- Edge this incident blocks, found via ST_ClosestPoint (API-03).
    blocked_edge  BIGINT REFERENCES road_edges(id) ON DELETE SET NULL,
    reported_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    verified_at   TIMESTAMPTZ
);

CREATE INDEX incidents_geom_idx ON incidents USING GIST (geom);
-- Only verified incidents affect routing; this index is what routable_edges hits.
CREATE INDEX incidents_blocking_idx ON incidents (blocked_edge)
    WHERE status = 'verified' AND blocked_edge IS NOT NULL;

-- ============================================== the routing view

-- pgRouting reads THIS, never road_edges directly.
--
-- The spec calls for setting a blocked edge's cost to 999999. Doing that with
-- an UPDATE on road_edges destroys the real cost, so clearing the landslide
-- later leaves no way to restore it. Computing it here keeps 999999 as the
-- effective routing cost while road_edges.cost stays the ground truth, and a
-- cleared incident restores routing with no writes at all.
--
-- 999999 rather than 'infinity': pgRouting treats a negative cost as
-- "impassable" and would silently drop the edge from the graph, which loses
-- the ability to route through it as a last resort when every path is blocked.
CREATE OR REPLACE VIEW routable_edges AS
SELECT
    e.id,
    e.source,
    e.target,
    CASE WHEN b.blocked THEN 999999 ELSE e.cost END         AS cost,
    CASE WHEN b.blocked THEN 999999 ELSE e.reverse_cost END AS reverse_cost,
    e.x1, e.y1, e.x2, e.y2,
    e.geom,
    e.name,
    e.risk_score,
    b.blocked
FROM road_edges e
LEFT JOIN LATERAL (
    SELECT TRUE AS blocked
    FROM incidents i
    WHERE i.blocked_edge = e.id
      AND i.status = 'verified'
    LIMIT 1
) b ON TRUE;

COMMENT ON VIEW routable_edges IS
    'Edge set for pgr_aStar. Applies the 999999 blocked-edge cost without '
    'mutating road_edges.cost, so clearing an incident restores routing.';

-- ============================================== routing helpers

-- Nearest graph vertex to an arbitrary point. Uses the GIST KNN operator
-- (<->), so this stays an index scan rather than sorting the whole table.
CREATE OR REPLACE FUNCTION nearest_road_node(pt GEOMETRY)
RETURNS BIGINT
LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT id FROM road_nodes ORDER BY geom <-> pt LIMIT 1;
$$;

-- Nearest edge to a reported incident, plus the snapped-to-road point.
-- ST_ClosestPoint gives the snap location; the <-> ordering picks the edge.
CREATE OR REPLACE FUNCTION nearest_road_edge(
    pt GEOMETRY,
    max_distance_m DOUBLE PRECISION DEFAULT 200
)
RETURNS TABLE (edge_id BIGINT, snapped GEOMETRY, distance_m DOUBLE PRECISION)
LANGUAGE sql STABLE AS $$
    -- The KNN scan must be its own subquery: putting the distance filter in
    -- the same SELECT as ORDER BY <-> LIMIT 1 would filter *after* the limit
    -- only by accident of plan shape. Nested, the inner query picks the
    -- nearest edge and the outer decides whether it is near enough.
    SELECT c.id, c.snapped, c.dist
    FROM (
        SELECT e.id,
               ST_ClosestPoint(e.geom, pt)                  AS snapped,
               ST_Distance(e.geom::geography, pt::geography) AS dist
        FROM road_edges e
        ORDER BY e.geom <-> pt
        LIMIT 1
    ) c
    -- A report further than this from any road is bad GPS. Returning no row
    -- is correct: blocking the "nearest" edge would take out an unrelated road.
    WHERE c.dist <= max_distance_m;
$$;

-- A* shortest path between two coordinates, honouring blocked edges.
--
-- `risk_weight` folds the XGBoost score into the cost so dispatchers can
-- pre-emptively reroute (workflow §5) without waiting for a hard block:
-- 0 ignores risk, 1 makes a 1.0-risk road cost double.
CREATE OR REPLACE FUNCTION route_astar(
    start_pt    GEOMETRY,
    end_pt      GEOMETRY,
    risk_weight DOUBLE PRECISION DEFAULT 0,
    -- Converts the heuristic's units into the cost's units. x1..y2 are
    -- degrees (EPSG:4326) while cost is metres, so without this the
    -- heuristic underestimates by ~5 orders of magnitude: still admissible,
    -- so the path stays correct, but A* degrades into plain Dijkstra and
    -- explores the whole graph. ~111320 m per degree at the equator.
    heuristic_factor DOUBLE PRECISION DEFAULT 111320
)
RETURNS TABLE (
    seq       INTEGER,
    edge_id   BIGINT,
    cost      DOUBLE PRECISION,
    edge_geom GEOMETRY
)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_start BIGINT := nearest_road_node(start_pt);
    v_end   BIGINT := nearest_road_node(end_pt);
BEGIN
    IF v_start IS NULL OR v_end IS NULL THEN
        RAISE EXCEPTION 'road graph is empty -- run scripts/ingest_geo.py (DB-02)';
    END IF;

    RETURN QUERY
    SELECT r.seq, r.edge, r.cost, e.geom
    FROM pgr_aStar(
            format(
                -- pgr_aStar requires x1,y1,x2,y2 for its heuristic; the
                -- column list below is its expected contract, not free choice.
                'SELECT id, source, target,
                        cost * (1 + %1$s * risk_score) AS cost,
                        reverse_cost * (1 + %1$s * risk_score) AS reverse_cost,
                        x1, y1, x2, y2
                 FROM routable_edges',
                risk_weight
            ),
            v_start, v_end,
            directed => TRUE,
            heuristic => 2,  -- Euclidean; matches the 4326 lon/lat in x1..y2
            factor => heuristic_factor
         ) AS r
    LEFT JOIN road_edges e ON e.id = r.edge
    WHERE r.edge <> -1;      -- pgr_aStar emits edge = -1 on the final node
END;
$$;

-- Rebuild road_nodes from edge endpoints. Run after every geo ingest.
CREATE OR REPLACE FUNCTION rebuild_road_nodes()
RETURNS BIGINT
LANGUAGE plpgsql AS $$
DECLARE
    n BIGINT;
BEGIN
    TRUNCATE road_nodes;
    INSERT INTO road_nodes (id, geom)
    SELECT source, ST_SetSRID(ST_MakePoint(x1, y1), 4326) FROM road_edges
    UNION
    SELECT target, ST_SetSRID(ST_MakePoint(x2, y2), 4326) FROM road_edges
    ON CONFLICT (id) DO NOTHING;

    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END;
$$;

-- ============================================================ reroutes

CREATE TABLE reroutes (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trip_id       UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    incident_id   UUID REFERENCES incidents(id) ON DELETE SET NULL,
    new_route     GEOMETRY(LineString, 4326) NOT NULL,
    -- 'incident' = reactive (workflow §4);
    -- 'risk'     = dispatcher pre-emptive reroute (workflow §5).
    -- Named trigger_type, not trigger: the latter is a PostgreSQL keyword and
    -- reads as a DDL object everywhere it appears in a query.
    trigger_type  TEXT NOT NULL
                  CHECK (trigger_type IN ('incident', 'risk', 'manual')),
    reason        TEXT NOT NULL,
    -- Cached Bhashini TTS audio, so replay costs no API call.
    tts_audio_url TEXT,
    tts_lang      TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX reroutes_trip_idx ON reroutes (trip_id, created_at DESC);

COMMIT;
