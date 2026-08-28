-- Reroute proposals: a detour the driver has to ACCEPT, not one imposed on them.
--
-- Until now a reroute was a fait accompli. The backend recomputed the path,
-- overwrote trips.planned_route and pushed the geometry; the driver client had
-- no say and no way to compare. That is not how a driver uses a navigator --
-- Google Maps offers "faster route available, +4 min" and waits for a tap,
-- because the person in the cab knows things the graph does not (the detour is
-- a single track, the load is over-height for the underpass, the blocked road
-- is passable in a 4x4).
--
-- So a reroute row is now a PROPOSAL with a lifecycle, and it carries what a
-- driver needs to judge it: the road it replaces, and both routes costed.
--
-- WHY previous_route is stored rather than recomputed: the old path may run
-- over an edge that is now blocked, so replanning it would not reproduce it.
-- The only place the superseded geometry survives is here, and it is what a
-- decline has to restore.
BEGIN;

ALTER TABLE reroutes
    -- The path this reroute replaced. NULL for a trip that had none.
    ADD COLUMN IF NOT EXISTS previous_route         GEOMETRY(LineString, 4326),
    -- Both routes costed at proposal time. Stored rather than derived because
    -- the ETA comes from per-edge road class and sinuosity (travelTime.js) --
    -- a bare LineString cannot be re-costed, only re-measured.
    ADD COLUMN IF NOT EXISTS distance_m             DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS duration_sec           DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS previous_distance_m    DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS previous_duration_sec  DOUBLE PRECISION,
    -- 'pending' until the handset answers. A proposal that is never answered
    -- stays pending forever and that is the honest record: the driver was in a
    -- dark zone, or the app was closed, and nobody knows whether they took it.
    ADD COLUMN IF NOT EXISTS driver_response        TEXT NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS responded_at           TIMESTAMPTZ;

-- Added separately and guarded: ADD CONSTRAINT has no IF NOT EXISTS, and this
-- migration has to stay re-runnable like every other one in the ledger.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reroutes_driver_response_chk') THEN
        ALTER TABLE reroutes ADD CONSTRAINT reroutes_driver_response_chk
            CHECK (driver_response IN ('pending', 'accepted', 'declined'));
    END IF;
END $$;

-- The dispatcher's "who has not answered yet" query.
CREATE INDEX IF NOT EXISTS reroutes_pending_idx
    ON reroutes (trip_id, created_at DESC)
    WHERE driver_response = 'pending';

-- The trip's own costing, so a reroute can quote the route it is replacing
-- without re-planning it. Nullable: trips created before this migration have
-- a planned_route and no figures, and the API falls back to measuring the
-- geometry rather than inventing a duration for them.
ALTER TABLE trips
    ADD COLUMN IF NOT EXISTS planned_distance_m   DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS planned_duration_sec DOUBLE PRECISION;

COMMIT;
