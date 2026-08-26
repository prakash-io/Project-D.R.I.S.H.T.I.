-- Idempotent hazard reports from the edge (Workflow 4, MOB-03).
--
-- The driver client queues a hazard report in WatermelonDB the moment the
-- photo is taken and retries the multipart upload until the backend
-- acknowledges it. That retry is not optional: reports come from exactly the
-- places with no signal, and a lost RESPONSE is indistinguishable from a lost
-- REQUEST to the phone.
--
-- Without a client-supplied key, every replay creates a second incident. Two
-- rows for one landslide means the dispatcher approves it twice and the same
-- edge is blocked twice, so clearing one leaves the road shut.
--
-- Deliberately a partial index: rows predating this migration, and any future
-- server-side report with no originating device, keep client_uid NULL and are
-- exempt rather than colliding with each other on NULL.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS client_uid uuid;

CREATE UNIQUE INDEX IF NOT EXISTS incidents_client_uid_key
    ON incidents (client_uid)
    WHERE client_uid IS NOT NULL;
