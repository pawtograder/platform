#!/usr/bin/env bash
# One-time setup of the local Supabase Postgres container for coverage runs.
# Adds `plpgsql_check` to shared_preload_libraries so the profiler stores
# coverage in shared memory (works across all sessions, not just the one
# that enables it). Restarts the DB container afterwards.
#
# Run this once after `npx supabase start`, then re-run only if you re-run
# `npx supabase stop --no-backup` (which discards the container).
#
# Idempotent.

set -euo pipefail

CONTAINER="${SUPABASE_DB_CONTAINER:-supabase_db_pawtograder-platform}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "[setup-pg] $CONTAINER is not running — start Supabase first (\`npx supabase start\`)" >&2
  exit 1
fi

# Check whether plpgsql_check is already in shared_preload_libraries.
existing=$(docker exec -i "$CONTAINER" psql -U postgres -d postgres -tA \
  -c "SHOW shared_preload_libraries;" 2>/dev/null || echo "")

if echo "$existing" | grep -q "plpgsql_check"; then
  echo "[setup-pg] plpgsql_check already in shared_preload_libraries (\"$existing\")"
else
  # Append (don't replace) — Supabase already preloads pgsodium, supabase_vault, etc.
  new_value="${existing:+$existing,}plpgsql_check"
  echo "[setup-pg] setting shared_preload_libraries = '$new_value'"
  docker exec -i "$CONTAINER" psql -U postgres -d postgres \
    -c "ALTER SYSTEM SET shared_preload_libraries = '$new_value';" >/dev/null

  # ALTER SYSTEM requires restart to apply shared_preload_libraries changes.
  echo "[setup-pg] restarting $CONTAINER to apply shared_preload_libraries"
  docker restart "$CONTAINER" >/dev/null

  # Wait for it to come back.
  for _ in $(seq 1 30); do
    if docker exec -i "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

# Now safe to create the extension and reset the profiler.
docker exec -i "$CONTAINER" psql -U postgres -d postgres \
  -f - < "$(dirname "$0")/init-pg.sql"

# Persist the profiler ON across all sessions. Without this, callers would
# need to `SET plpgsql_check.profiler = on` in every connection — error-prone
# across the dozens of pool clients Supabase opens.
docker exec -i "$CONTAINER" psql -U postgres -d postgres \
  -c "ALTER SYSTEM SET plpgsql_check.profiler = on;" >/dev/null
docker exec -i "$CONTAINER" psql -U postgres -d postgres \
  -c "SELECT pg_reload_conf();" >/dev/null

echo "[setup-pg] done — profiler is ON, plpgsql_check is preloaded"
