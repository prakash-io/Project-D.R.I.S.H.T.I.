#!/usr/bin/env bash
# Apply backend/migrations/*.sql to the PostGIS container, in order.
#
# Exists because `docker compose up -d` returns as soon as the container is
# *started*, which is a second or two before Postgres accepts connections.
# Piping a migration in immediately fails with "the database system is
# starting up" -- so this waits on the healthcheck first.
#
#   scripts/db_migrate.sh          # apply all migrations
#   scripts/db_migrate.sh --reset  # destroy the volume and rebuild from scratch

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="$ROOT/infra/docker-compose.yml"
CONTAINER="drishti-postgis"
DB_USER="${PGUSER:-drishti}"
DB_NAME="${PGDATABASE:-drishti}"

cd "$ROOT"

if ! docker info >/dev/null 2>&1; then
    echo "error: docker daemon not reachable. Start Docker Desktop and retry." >&2
    exit 1
fi

if [[ "${1:-}" == "--reset" ]]; then
    echo "==> destroying volume and rebuilding"
    docker compose -f "$COMPOSE" down -v
fi

echo "==> starting postgis"
docker compose -f "$COMPOSE" up -d postgis

echo -n "==> waiting for healthy "
for _ in $(seq 1 60); do
    status="$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo starting)"
    [[ "$status" == "healthy" ]] && { echo " ok"; break; }
    if [[ "$status" == "unhealthy" ]]; then
        echo " FAILED"
        docker compose -f "$COMPOSE" logs --tail 40 postgis
        exit 1
    fi
    echo -n "."
    sleep 1
done

if [[ "$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER")" != "healthy" ]]; then
    echo " timed out after 60s" >&2
    docker compose -f "$COMPOSE" logs --tail 40 postgis
    exit 1
fi

shopt -s nullglob
migrations=("$ROOT"/backend/migrations/[0-9]*.sql)
if (( ${#migrations[@]} == 0 )); then
    echo "no migrations found in backend/migrations/" >&2
    exit 1
fi

# A ledger, because this script applies every migration on every run and none
# of them are idempotent: re-running 001 fails on `CREATE TABLE trucks`, so
# before this existed the script only worked against a fresh volume. Only
# numbered files are migrations -- smoke_test.sql is a test, not a step.
psql_run() {
    docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -qtA -U "$DB_USER" -d "$DB_NAME" "$@"
}

psql_run -c "
CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    TEXT PRIMARY KEY,
    sha256      TEXT NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);" >/dev/null

for f in "${migrations[@]}"; do
    name="$(basename "$f")"
    sum="$(shasum -a 256 "$f" | cut -d" " -f1)"
    recorded="$(psql_run -c "SELECT sha256 FROM schema_migrations WHERE filename = '$name';")"

    if [[ -n "$recorded" ]]; then
        if [[ "$recorded" != "$sum" ]]; then
            # An applied migration that has since been edited. Silently
            # skipping it would leave the database and the file disagreeing,
            # which is worse than stopping.
            echo "==> ERROR: $name was already applied but its contents have changed." >&2
            echo "    applied sha256 $recorded" >&2
            echo "    current sha256 $sum" >&2
            echo "    Add a new migration instead of editing an applied one," >&2
            echo "    or rebuild from scratch with: scripts/db_migrate.sh --reset" >&2
            exit 1
        fi
        echo "==> skipping $name (already applied)"
        continue
    fi

    echo "==> applying $name"
    # ON_ERROR_STOP makes psql exit non-zero on the first failing statement;
    # without it psql reports the error and still exits 0, so a broken
    # migration looks like a success.
    if ! docker exec -i "$CONTAINER" \
            psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < "$f"; then
        echo "==> FAILED on $name" >&2
        exit 1
    fi
    psql_run -c "INSERT INTO schema_migrations (filename, sha256)
                 VALUES ('$name', '$sum');" >/dev/null
done

echo "==> verifying"
docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c "
SELECT extname AS extension, extversion AS version
FROM pg_extension WHERE extname IN ('postgis','pgrouting')
ORDER BY extname;"

docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c "
SELECT
  (SELECT count(*) FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE') AS tables,
  (SELECT count(*) FROM information_schema.views
    WHERE table_schema='public')                             AS views,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN
      ('route_astar','nearest_road_node','nearest_road_edge','rebuild_road_nodes'))
                                                             AS drishti_functions;"

echo "==> done"
