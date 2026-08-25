# D.R.I.S.H.T.I. — Backend (Epic 1)

Node.js/Express + Socket.IO + BullMQ over PostGIS/pgRouting. Telemetry,
Burst Sync, incident reporting and dynamic rerouting.

## Run

```bash
scripts/db_migrate.sh                 # migrations 001-007, ledgered
ai-services/.venv/bin/python scripts/ingest_geo.py           # ~3 min
ai-services/.venv/bin/python scripts/build_mobile_extract.py # ~50 s

cd backend && npm install
npm start          # HTTP + Socket.IO on :4000
npm run worker     # the Burst Sync worker, in its own process

node test/e2e_verify.mjs   # full lifecycle check
```

The worker is a separate process deliberately. Draining a few thousand
dark-zone points is CPU-bound JSON and database work; running it inside the
API process would stall the live telemetry of every other truck, which is the
exact thing the queue exists to prevent.

## Endpoints

| | |
|---|---|
| `GET /health` | graph size, main component, AI service, auto-block flag |
| `POST /routes/plan` | `{from, to, risk_weight?}` → GeoJSON route |
| `POST /trips` | start a trip with a planned route |
| `GET /trucks` | last known position of every truck |
| `POST /sync/telemetry` | Burst Sync backlog → 202 Accepted + job id |
| `GET /sync/jobs/:id` | what happened to a batch |
| `POST /incidents/report` | multipart photo + lat/lng → classified, **not** blocking |
| `GET /incidents?status=` | the WEB-05 review queue |
| `POST /incidents/:id/approve` | the load-bearing step: blocks the edge and reroutes |
| `POST /incidents/:id/reject` / `/clear` | |

Socket.IO events: `truck_location_update` (in and out), `route_updated`,
`incident_reported`. Clients `subscribe` to `dispatchers` or `truck:<id>`.

## Four things that matter

**An AI verdict does not close a road.** `/incidents/report` writes
`pending_dispatcher_approval`, and `routable_edges` only honours `verified`.
The vision model has no "no incident" class and is out of distribution on
ground-level photos, so WEB-05 is the safety valve. `AUTO_BLOCK_ON_AI_VERDICT`
exists but must stay `0` until the training data is replaced.

**Blocking never writes to `road_edges`.** The 999999 cost lives in the
`routable_edges` view, so clearing an incident restores the original route
exactly, with zero cost writes. The e2e check asserts this.

**Burst Sync is idempotent.** Every point carries a client-generated
`client_uid` with a UNIQUE index, so a retried batch re-inserts nothing —
which is what makes BullMQ's automatic retries safe.

**`written` counts rows, not marker moves.** A burst-synced point is normally
older than the live fix that arrived when the truck regained signal, so it is
persisted while correctly *not* moving the truck on the map. Conflating the
two made the worker report `0/250` on a batch it had fully written.
