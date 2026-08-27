-- Named demonstration corridors over the real road graph.
--
-- Every route this platform draws has to come out of the dataset -- pgr_astar
-- over routable_edges -- rather than being a hand-drawn line between two
-- pins. A straight line between Guwahati and Shillong is 62 km; the road is
-- 95 km, and the difference is the whole point of having a topology.
--
-- planned_route is CACHED, not authoritative. Planning ten corridors takes
-- long enough that doing it per request would make the corridor list feel
-- broken, but the geometry is reproducible at any time by replanning from
-- origin/destination. That is also why a NULL planned_route is legal: the row
-- is a definition, and seed_corridors.mjs fills in the geometry.
--
-- Deliberately NOT a view over trips. A corridor is a fixed piece of NER
-- geography that outlives any particular truck; a trip is one vehicle's
-- journey along one. Collapsing them would mean a corridor disappears the
-- moment its last trip completes.
CREATE TABLE IF NOT EXISTS corridors (
  id                text PRIMARY KEY,
  name              text NOT NULL,
  origin_name       text NOT NULL,
  destination_name  text NOT NULL,
  origin            geography(Point, 4326) NOT NULL,
  destination       geography(Point, 4326) NOT NULL,
  planned_route     geography(LineString, 4326),
  distance_m        double precision,
  edge_count        integer,
  planned_at        timestamptz,
  -- Display order for the corridor selector, so the list is stable rather
  -- than whatever order the seeder happened to finish in.
  sort_order        integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS corridors_route_gix
  ON corridors USING GIST (planned_route);
