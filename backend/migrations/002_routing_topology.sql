-- Routing topology, districts, and the dispatcher-approval incident state.
--
-- Follows 001_init.sql. Applied by scripts/db_migrate.sh, which records it in
-- schema_migrations -- migrations are not idempotent and must run once each.

BEGIN;

-- ====================================================== road_edges columns
--
-- 001 defined the routing skeleton (source/target/cost/geom). These are the
-- attributes the ingest carries across from the OSM tags, kept separate from
-- the routing columns so a re-ingest never has to touch pgRouting's contract.

ALTER TABLE road_edges
    -- OSM highway class. Drives dashboard styling (WEB-02) and is the natural
    -- place to hang a vehicle-class restriction later; a 40-tonne truck has no
    -- business on a `track`.
    ADD COLUMN IF NOT EXISTS highway   TEXT,
    ADD COLUMN IF NOT EXISTS surface   TEXT,
    -- Bridges flood and wash out as a unit, so a flood incident anywhere on
    -- one blocks the whole edge rather than the nearest 20 m of it.
    ADD COLUMN IF NOT EXISTS is_bridge BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS is_tunnel BOOLEAN NOT NULL DEFAULT FALSE,
    -- Geodesic length. `cost` is free to become travel time later; this stays
    -- the physical length and is what the A* heuristic's metre units assume.
    ADD COLUMN IF NOT EXISTS length_m  DOUBLE PRECISION;

CREATE INDEX IF NOT EXISTS road_edges_highway_idx ON road_edges (highway);
CREATE INDEX IF NOT EXISTS road_edges_osm_id_idx  ON road_edges (osm_id);
CREATE INDEX IF NOT EXISTS road_edges_bridge_idx  ON road_edges (id) WHERE is_bridge;

COMMENT ON COLUMN road_edges.length_m IS
    'Geodesic length in metres (ST_Length(geom::geography)). cost defaults to '
    'this; the pgr_aStar heuristic factor in route_astar assumes metres.';

-- ============================================================== districts
--
-- 88 polygons. Not routable -- used to scope dashboard queries, label a
-- truck''s position, and give dispatchers a filter that is not a bounding box.

CREATE TABLE IF NOT EXISTS districts (
    id            SERIAL PRIMARY KEY,
    state_name    TEXT NOT NULL,
    district_name TEXT NOT NULL,
    censuscode    INTEGER,
    geom          GEOMETRY(MultiPolygon, 4326) NOT NULL
);

CREATE INDEX IF NOT EXISTS districts_geom_idx ON districts USING GIST (geom);
CREATE INDEX IF NOT EXISTS districts_name_idx ON districts (state_name, district_name);

-- ================================================ incidents: approval state
--
-- The AI verifier cannot be trusted to block a road on its own. It has no
-- "no incident" class -- the training labels for NORMAL_TERRAIN are filename
-- index arithmetic, not image content -- and it was trained on satellite and
-- aerial imagery while drivers send ground-level photographs. Every verified
-- incident therefore comes back with requires_human_review = true.
--
-- So the pipeline gains a state between "the model looked at it" and "routing
-- believes it": API-03 writes pending_dispatcher_approval, and only a human
-- action in WEB-05 promotes it to verified. routable_edges keys off
-- 'verified' alone, so an unapproved incident cannot change a single route.
ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incidents_status_check;
ALTER TABLE incidents ADD CONSTRAINT incidents_status_check
    CHECK (status IN ('pending',
                      'pending_dispatcher_approval',
                      'verified',
                      'rejected',
                      'cleared'));

-- What the model said, kept distinct from what the dispatcher decided.
ALTER TABLE incidents
    ADD COLUMN IF NOT EXISTS ai_class     TEXT,
    ADD COLUMN IF NOT EXISTS ai_reviewed  BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS approved_by  TEXT,
    ADD COLUMN IF NOT EXISTS approved_at  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS incidents_awaiting_approval_idx
    ON incidents (reported_at DESC)
    WHERE status = 'pending_dispatcher_approval';

COMMENT ON COLUMN incidents.status IS
    'pending -> submitted, not yet classified. '
    'pending_dispatcher_approval -> the model classified it but requires human '
    'confirmation (the normal path; see ai_reviewed). '
    'verified -> a dispatcher approved it; ONLY this state blocks an edge. '
    'rejected / cleared -> not blocking.';

COMMIT;
