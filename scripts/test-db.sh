#!/usr/bin/env bash
# Starts a throwaway PostgreSQL 16 for integration tests and prints the admin URL to export.
# Prefers docker compose; falls back to a local cluster when no docker daemon is available.
set -euo pipefail

if docker info >/dev/null 2>&1; then
  docker run -d --rm --name roadtrip-test-db -p 5433:5432 \
    -e POSTGRES_USER=roadtrip -e POSTGRES_PASSWORD=roadtrip -e POSTGRES_DB=postgres \
    postgres:16-alpine >/dev/null
  echo "Waiting for postgres..." >&2
  until docker exec roadtrip-test-db pg_isready -U roadtrip >/dev/null 2>&1; do sleep 0.5; done
  echo "export TEST_DATABASE_ADMIN_URL=postgres://roadtrip:roadtrip@127.0.0.1:5433/postgres"
else
  PGBIN=$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)
  PGDIR="${TMPDIR:-/tmp}/roadtrip-pgdata"
  if [ ! -d "$PGDIR" ]; then
    "$PGBIN/initdb" -D "$PGDIR" -U roadtrip --auth=trust -E UTF8 >/dev/null
  fi
  "$PGBIN/pg_ctl" -D "$PGDIR" -o "-p 5433 -k /tmp -c listen_addresses=127.0.0.1 -c fsync=off" \
    -l "$PGDIR/log" start >/dev/null
  echo "export TEST_DATABASE_ADMIN_URL=postgres://roadtrip@127.0.0.1:5433/postgres"
fi
