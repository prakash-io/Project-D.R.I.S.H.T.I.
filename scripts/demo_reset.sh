#!/usr/bin/env bash
# Fast demo reset. Puts the platform back to the pristine pre-demo state
# WITHOUT touching the road graph, the corridors or the migrations.
#
#     scripts/demo_reset.sh            # reset
#     scripts/demo_reset.sh --check    # report state only, change nothing
#
# What it does, and why each step is safe:
#   1. clears every incident that is verified or awaiting a dispatcher, so
#      `routable_edges` prices no edge at 999999 and the review queue is empty.
#      Status only -- road_edges.cost is never written (CLAUDE.md decision 6),
#      so routing returns to exactly the graph it shipped with.
#   2. deletes the throwaway trucks the demo and verification scripts create
#      (AS01-DEMO-*, AS01-MSN-*, AS01-E2E-*). ON DELETE CASCADE takes their
#      trips, telemetry and truck_last_seen rows with them; incidents survive
#      with reported_by set NULL.
#   3. aborts any trip still marked active, so nothing is rerouted on the next
#      approval by a truck nobody is watching.
#   4. drains the BullMQ burst-sync queue in Redis.
#
# What it deliberately does NOT do: drop the volume, re-run migrations, or
# re-import the 486,784-edge graph. Those take minutes; this takes a second.
set -euo pipefail

PG=${PG_CONTAINER:-drishti-postgis}
RD=${REDIS_CONTAINER:-drishti-redis}
API=${API_URL:-http://localhost:4000}
psql() { docker exec "$PG" psql -U "${PGUSER:-drishti}" -d "${PGDATABASE:-drishti}" "$@"; }

state() {
  psql -t -A -F'|' -c "
    SELECT 'blocked_edges  ' || count(*) FROM incident_blocked_edges ibe
      JOIN incidents i ON i.id = ibe.incident_id WHERE i.status = 'verified'
    UNION ALL SELECT 'review_queue   ' || count(*) FROM incidents
      WHERE status = 'pending_dispatcher_approval'
    UNION ALL SELECT 'active_trips   ' || count(*) FROM trips WHERE status = 'active'
    UNION ALL SELECT 'demo_trucks    ' || count(*) FROM trucks
      WHERE plate LIKE 'AS01-DEMO-%' OR plate LIKE 'AS01-MSN-%' OR plate LIKE 'AS01-E2E-%'
    UNION ALL SELECT 'fixtures       ' || count(*) || ' of 3 (handset + 2 e2e)' FROM trucks
      WHERE id IN ('651692e8-374b-401f-9b9f-e3ed86342ab5',
                   '92763b27-6af4-43fc-9c0f-b546b4def9cb',
                   '907d7901-de08-448e-842e-00285c291977')
    UNION ALL SELECT 'telemetry_rows ' || count(*) FROM telemetry;"
}

# Free disk, checked FIRST because a full disk does not fail loudly here -- it
# wedges Postgres, and the symptoms are an empty-message HTTP 500 from
# /risk/segments and "telemetry rejected:" with no reason in the API log. Both
# read as application bugs and neither points at the disk. Observed on this
# machine at 98% full, after an Android release build.
avail_kb=$(df -k / | awk 'NR==2 {print $4}')
avail_gb=$(( avail_kb / 1048576 ))
if (( avail_gb < 5 )); then
  echo "WARNING: only ${avail_gb} GiB free. Below ~5 GiB Postgres starts failing"
  echo "         with blank error messages. Reclaim space before demonstrating:"
  echo "           rm -rf .claude/worktrees/*/mobile-app/android/app/build/intermediates"
  echo
fi

if [[ "${1:-}" == "--check" ]]; then
  echo "== free disk: ${avail_gb} GiB"
  echo "== current state"; state; exit 0
fi

echo "== before"; state

psql -q -c "UPDATE incidents SET status = 'cleared'
            WHERE status IN ('verified', 'pending_dispatcher_approval', 'pending');"
# Throwaway trucks go; PINNED FIXTURES STAY.
#
# Three ids are referenced by uuid from outside this script and deleting them
# breaks things that then look broken for unrelated reasons:
#
#   651692e8…  OD02-HANDSET   the truck the APK is BUILT for (mobile-app/.env).
#                             Delete it and the phone's telemetry is rejected
#                             with a foreign-key error the driver never sees.
#   92763b27…  AS01-E2E-425   \
#   907d7901…  AS01-E2E-69822 / hardcoded fixtures in
#                             backend/test/route_alternatives_verify.mjs. That
#                             script POSTs /trips with these ids; with the rows
#                             gone the response has no `alternatives` key and it
#                             dies on `Cannot read properties of undefined`,
#                             which reads as "route alternatives are broken"
#                             rather than "the reset ate the fixture".
psql -q -c "DELETE FROM trucks
            WHERE (plate LIKE 'AS01-DEMO-%' OR plate LIKE 'AS01-MSN-%'
                   OR plate LIKE 'AS01-E2E-%')
              AND id NOT IN ('651692e8-374b-401f-9b9f-e3ed86342ab5',
                             '92763b27-6af4-43fc-9c0f-b546b4def9cb',
                             '907d7901-de08-448e-842e-00285c291977');"

# ...and re-seeded if a previous run (or an older version of this script) took
# them. Idempotent, so a reset always ends with a database the demo and the
# whole verification suite can both run against.
psql -q -c "INSERT INTO trucks (id, plate, driver_name, alert_lang) VALUES
              ('651692e8-374b-401f-9b9f-e3ed86342ab5','OD02-HANDSET','Handset Bring-up','as'),
              ('92763b27-6af4-43fc-9c0f-b546b4def9cb','AS01-E2E-425','E2E Driver','as'),
              ('907d7901-de08-448e-842e-00285c291977','AS01-E2E-69822','E2E Driver','as')
            ON CONFLICT (id) DO NOTHING;"
psql -q -c "UPDATE trips SET status = 'aborted', ended_at = now() WHERE status = 'active';"

# BullMQ keys only. FLUSHALL would take out anything else sharing this Redis.
docker exec "$RD" redis-cli --scan --pattern 'bull:burst-sync:*' \
  | xargs -r -n 200 docker exec -i "$RD" redis-cli DEL >/dev/null 2>&1 || true

echo "== after"; state

# The proof: the reference corridor is back to its pristine length.
if curl -sf -m 60 "$API/health" >/dev/null 2>&1; then
  D=$(curl -s -m 120 -X POST "$API/routes/plan" -H 'content-type: application/json' \
        -d '{"from":{"lat":26.1445,"lng":91.7362},"to":{"lat":25.5788,"lng":91.8933}}' \
      | python3 -c 'import json,sys; print(round(json.load(sys.stdin)["distance_m"]))')
  echo "== Guwahati -> Shillong: ${D} m  (pristine = 95164 m)"
  [[ "$D" == "95164" ]] && echo "== RESET OK" || echo "== WARNING: not the pristine baseline"
else
  echo "== backend not running; skipped the route check"
fi
