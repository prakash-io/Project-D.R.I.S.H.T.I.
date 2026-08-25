-- Drop the superseded 4-argument route_astar.
--
-- 003 added a `corridor_m` parameter to route_astar. `CREATE OR REPLACE
-- FUNCTION` only replaces a function with the SAME signature -- a new
-- parameter makes it an OVERLOAD instead, so both versions existed at once
-- and every existing 2-argument call became ambiguous:
--
--   ERROR: function route_astar(geometry, geometry) is not unique
--
-- Both overloads have defaults for every argument after the second, so
-- PostgreSQL cannot pick between them and refuses. This is a fix-forward
-- rather than an edit to 003, because 003 is already applied and its
-- checksum is recorded; scripts/db_migrate.sh refuses to skip a migration
-- whose contents have changed, which is the behaviour that makes the ledger
-- worth having.

BEGIN;

DROP FUNCTION IF EXISTS route_astar(GEOMETRY, GEOMETRY, DOUBLE PRECISION, DOUBLE PRECISION);

COMMIT;
