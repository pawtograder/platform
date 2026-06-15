#!/usr/bin/env bash
# One-time setup of the local Supabase Postgres container for coverage runs.
# - Ensures `plpgsql_check` is preloaded (already is in current Supabase
#   images, but we still install the extension and set the profiler GUC).
# - Resets the profiler so coverage starts from a clean state.
# - Persists `plpgsql_check.profiler = on` globally so every session
#   Playwright opens contributes to coverage.
# - Writes a sentinel file (coverage/.pg-ready) consumed by collect.sh.
#
# Idempotent. Re-run after `supabase stop --no-backup` (which discards
# the container).

set -euo pipefail

CONTAINER="${SUPABASE_DB_CONTAINER:-supabase_db_pawtograder-platform}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "[setup-pg] $CONTAINER is not running — start Supabase first (\`npx supabase start\`)" >&2
  exit 1
fi

# --- Ensure plpgsql_check is preloaded -----------------------------------
existing=$(docker exec -i "$CONTAINER" psql -U postgres -d postgres -tA \
  -c "SHOW shared_preload_libraries;" 2>/dev/null || echo "")

if echo "$existing" | grep -q "plpgsql_check"; then
  echo "[setup-pg] plpgsql_check already in shared_preload_libraries"
  needs_restart=false
else
  new_value="${existing:+$existing,}plpgsql_check"
  echo "[setup-pg] setting shared_preload_libraries = '$new_value'"
  # Try ALTER SYSTEM first; some Supabase images run postgres as a
  # non-superuser, in which case we fall back to editing
  # postgresql.auto.conf directly via docker exec.
  if docker exec -i "$CONTAINER" psql -U postgres -d postgres \
    -c "ALTER SYSTEM SET shared_preload_libraries = '$new_value';" >/dev/null 2>&1; then
    needs_restart=true
  else
    echo "[setup-pg] ALTER SYSTEM denied — falling back to direct postgresql.auto.conf write"
    docker exec -i "$CONTAINER" bash -c \
      "echo \"shared_preload_libraries = '$new_value'\" >> /var/lib/postgresql/data/postgresql.auto.conf"
    needs_restart=true
  fi
fi

# --- Enable profiler GUC globally ----------------------------------------
# plpgsql_check.profiler is PGC_SUSET in some versions; ALTER SYSTEM fails
# for non-superusers. Detect that and write the auto.conf file directly.
echo "[setup-pg] setting plpgsql_check.profiler = on"
if docker exec -i "$CONTAINER" psql -U postgres -d postgres \
  -c "ALTER SYSTEM SET plpgsql_check.profiler = on;" >/dev/null 2>&1; then
  # ALTER SYSTEM only writes postgresql.auto.conf — the GUC does not take
  # effect for new sessions until the config is reloaded (or the server
  # restarts). plpgsql_check is already preloaded in current Supabase
  # images, so the shared_preload_libraries block above leaves
  # needs_restart=false; without an explicit reload here the profiler would
  # stay off and we'd silently collect zero Postgres coverage. SIGHUP is
  # enough for this GUC, so reload rather than force a full restart.
  # Whether this reload actually took effect is verified below (a failed
  # reload here would otherwise leave the profiler off and the run green).
  docker exec -i "$CONTAINER" psql -U postgres -d postgres \
    -c "SELECT pg_reload_conf();" >/dev/null 2>&1 || true
else
  echo "[setup-pg] ALTER SYSTEM denied — appending to postgresql.auto.conf directly"
  # Remove any pre-existing entry to keep idempotency clean, then append.
  docker exec -i "$CONTAINER" bash -c "
    sed -i '/^plpgsql_check\\.profiler/d' /var/lib/postgresql/data/postgresql.auto.conf 2>/dev/null || true
    echo \"plpgsql_check.profiler = 'on'\" >> /var/lib/postgresql/data/postgresql.auto.conf
  "
  needs_restart=true
fi

# --- Restart if any config changed ---------------------------------------
if [[ "${needs_restart:-false}" == "true" ]]; then
  echo "[setup-pg] restarting $CONTAINER"
  docker restart "$CONTAINER" >/dev/null
  ready=false
  for _ in $(seq 1 30); do
    if docker exec -i "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then
      ready=true
      break
    fi
    sleep 1
  done
  if [[ "$ready" != "true" ]]; then
    echo "[setup-pg] ERROR: $CONTAINER did not become ready within 30s after restart" >&2
    docker logs --tail 50 "$CONTAINER" >&2 || true
    exit 1
  fi

  # pg_isready only tells us Postgres is accepting connections. The
  # Supabase stack (auth, kong, realtime, storage) all depend on the
  # DB and need a few seconds to reconnect after a DB bounce. The next
  # workflow step (`npx supabase status -o env`) fails fast if any of
  # those still show as starting, so wait for the whole stack here.
  echo "[setup-pg] waiting for full Supabase stack to recover"
  cd "$ROOT"
  stack_ready=false
  for _ in $(seq 1 60); do
    if npx supabase status >/dev/null 2>&1; then
      stack_ready=true
      break
    fi
    sleep 2
  done
  if [[ "$stack_ready" != "true" ]]; then
    echo "[setup-pg] WARNING: supabase status still not healthy after 120s; continuing anyway" >&2
    npx supabase status 2>&1 | head -20 >&2 || true
  fi
fi

# --- Create extension + reset profiler -----------------------------------
# Functions are unqualified-callable because plpgsql_check installs into
# `public` (in Supabase images today) and `public` is in the default
# search_path.
docker exec -i "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION IF NOT EXISTS plpgsql_check;
SELECT plpgsql_profiler_reset_all();
SQL

# --- Verify the profiler is actually ON ----------------------------------
# Read the GUC in a fresh session (-tA = tuples-only, unaligned). Every path
# above is best-effort (the reload is `|| true`; the restart can race), so a
# silent failure would leave the profiler off, dump-pg emit an empty lcov,
# and the job stay green. Treat "not on" as a hard error instead.
profiler_state=$(docker exec -i "$CONTAINER" psql -U postgres -d postgres -tA \
  -c "SHOW plpgsql_check.profiler;" 2>/dev/null | tr -d '[:space:]' || echo "")
if [[ "$profiler_state" != "on" ]]; then
  echo "[setup-pg] ERROR: plpgsql_check.profiler is '${profiler_state:-<unset>}', expected 'on' — Postgres coverage would be empty" >&2
  exit 1
fi
echo "[setup-pg] verified plpgsql_check.profiler = on"

# --- Sentinel for collect.sh ---------------------------------------------
mkdir -p "$ROOT/coverage"
date -u +%Y-%m-%dT%H:%M:%SZ > "$ROOT/coverage/.pg-ready"

echo "[setup-pg] done — profiler is ON, plpgsql_check is preloaded"
