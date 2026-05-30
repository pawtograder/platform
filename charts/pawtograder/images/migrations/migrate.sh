#!/usr/bin/env bash
# Pawtograder migration runner.
#
# Applies every supabase/migrations/*.sql file in lexicographic order against
# the database identified by libpq env vars (PGHOST, PGUSER, PGDATABASE,
# PGPASSWORD, etc.). Tracks applied versions in
# supabase_migrations.schema_migrations — the same table the supabase CLI
# uses, so a database bootstrapped with this runner is interchangeable with
# one bootstrapped via `supabase db push`.
#
# Drift detection
# ---------------
# We add a `file_hash` column to schema_migrations and record SHA-256 of
# each file's contents when it's applied. On every subsequent run we
# recompute the hash of the on-disk file and compare it to the stored
# value. Mismatch = someone edited an already-applied migration, which
# means the database state no longer corresponds to the migration source
# and downstream runs will keep skipping the (now-edited) file forever.
#
# Behaviour on drift:
#   MIGRATIONS_RESET_ON_DRIFT=true   reset the application data and
#                                    replay everything from scratch (only
#                                    safe for ephemeral previews / dev).
#   anything else                    fail loudly with the drifted versions
#                                    listed. Operator must intervene
#                                    (rename the migration to a fresh
#                                    timestamp, or accept the drift by
#                                    recording the new hash manually).

set -euo pipefail

: "${PGHOST:?PGHOST is required}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=postgres}"
: "${PGPASSWORD:?PGPASSWORD is required}"
export PGHOST PGUSER PGDATABASE PGPASSWORD

MIGRATIONS_DIR="${MIGRATIONS_DIR:-/migrations}"
RESET_ON_DRIFT="${MIGRATIONS_RESET_ON_DRIFT:-false}"

echo "[migrate] target=${PGUSER}@${PGHOST}:${PGPORT:-5432}/${PGDATABASE}"
echo "[migrate] source=${MIGRATIONS_DIR}"
echo "[migrate] reset_on_drift=${RESET_ON_DRIFT}"

# Bootstrap the schema_migrations table. file_hash is added as a nullable
# column so a freshly-upgraded migrator can adopt rows that pre-date hash
# tracking (NULL hash = "back-fill on next sight; don't treat as drift").
psql -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  version  TEXT PRIMARY KEY,
  statements TEXT[],
  name     TEXT
);
ALTER TABLE supabase_migrations.schema_migrations
  ADD COLUMN IF NOT EXISTS file_hash TEXT;
SQL

shopt -s nullglob
files=( "${MIGRATIONS_DIR}"/*.sql )
if [ "${#files[@]}" -eq 0 ]; then
  echo "[migrate] no migration files found in ${MIGRATIONS_DIR}" >&2
  exit 1
fi

# Lexicographic sort matches supabase's <timestamp>_<name>.sql convention.
IFS=$'\n' sorted=( $(printf '%s\n' "${files[@]}" | sort) )
unset IFS

# Helper: SHA-256 of a file, returning the hex digest only (no filename).
sha_of() {
  sha256sum "$1" | awk '{print $1}'
}

# ---------------------------------------------------------------------------
# Phase 1 — drift detection
# ---------------------------------------------------------------------------
# For each on-disk file whose version is already in schema_migrations,
# compare the current file's SHA to the stored hash. Three outcomes per
# row:
#   stored is NULL    legacy row; record the current hash and move on.
#   stored == current healthy; no action.
#   stored != current DRIFT; collect for the reset/fail decision below.

drifted=()
backfilled=0
for f in "${sorted[@]}"; do
  base="$(basename "$f" .sql)"
  version="${base%%_*}"
  current="$(sha_of "$f")"

  stored="$(psql -tA -v ver="${version}" <<'SQL'
SELECT COALESCE(file_hash, '') FROM supabase_migrations.schema_migrations WHERE version=:'ver';
SQL
)"

  case "$stored" in
    "")
      # Row doesn't exist yet — this migration will be applied in phase 3.
      continue
      ;;
    "$current")
      # Healthy: stored hash matches on-disk file.
      continue
      ;;
    *)
      # If stored looks like "" (empty COALESCE result) it's a legacy
      # row with NULL file_hash. Back-fill silently and treat as healthy.
      legacy="$(psql -tA -v ver="${version}" <<'SQL'
SELECT (file_hash IS NULL)::int FROM supabase_migrations.schema_migrations WHERE version=:'ver';
SQL
)"
      if [ "$legacy" = "1" ]; then
        psql -v ON_ERROR_STOP=1 -v ver="${version}" -v hash="${current}" <<'SQL'
UPDATE supabase_migrations.schema_migrations SET file_hash=:'hash' WHERE version=:'ver';
SQL
        backfilled=$((backfilled+1))
        continue
      fi
      drifted+=("${version}\t${stored}\t${current}")
      ;;
  esac
done

if [ "${backfilled}" -gt 0 ]; then
  echo "[migrate] back-filled file_hash for ${backfilled} legacy row(s)"
fi

# ---------------------------------------------------------------------------
# Phase 2 — drift resolution
# ---------------------------------------------------------------------------
if [ "${#drifted[@]}" -gt 0 ]; then
  echo "[migrate] DRIFT DETECTED in ${#drifted[@]} migration(s):"
  printf '  %s\n' "${drifted[@]}" | awk -F'\t' '{printf "    version=%s stored_sha=%s on_disk_sha=%s\n", $1, substr($2,1,12)"…", substr($3,1,12)"…"}'

  if [ "${RESET_ON_DRIFT}" != "true" ]; then
    echo "[migrate] ERROR: refusing to proceed. The on-disk content of the above" >&2
    echo "[migrate]        migration(s) no longer matches what was applied to the" >&2
    echo "[migrate]        database. Either:" >&2
    echo "[migrate]          (a) revert the edit and rename it to a fresh timestamp," >&2
    echo "[migrate]          (b) set MIGRATIONS_RESET_ON_DRIFT=true to wipe + replay" >&2
    echo "[migrate]              (PREVIEW / DEV ONLY — destroys all application data)," >&2
    echo "[migrate]          (c) accept the drift manually:" >&2
    echo "[migrate]              UPDATE supabase_migrations.schema_migrations" >&2
    echo "[migrate]              SET file_hash='<new-sha>' WHERE version='<version>';" >&2
    exit 1
  fi

  echo "[migrate] MIGRATIONS_RESET_ON_DRIFT=true — wiping application data and replaying."
  echo "[migrate] This drops schema public + truncates schema_migrations. Pawtograder"
  echo "[migrate] tables live in public; auth/storage/realtime stay intact (their"
  echo "[migrate] services own those schemas)."

  # We DROP & CREATE public via a single transaction; if a downstream
  # migration fails on replay the operator gets a clear error and the
  # cluster is in a known-empty state, easy to debug.
  psql -v ON_ERROR_STOP=1 <<'SQL'
-- Drop application schema. CASCADE removes all tables, functions, types,
-- and the dependent grants on them. Pawtograder migrations recreate
-- everything from scratch in phase 3.
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
-- Restore the standard supabase role grants on public so the role chain
-- (anon, authenticated, service_role, postgres) can still resolve names
-- as the migrations run. The migrations themselves will GRANT more
-- specifically as needed.
GRANT ALL ON SCHEMA public TO postgres;
GRANT USAGE, CREATE ON SCHEMA public TO anon, authenticated, service_role;
-- Wipe the migration history so phase 3 re-applies every file.
TRUNCATE supabase_migrations.schema_migrations;
SQL
  echo "[migrate] reset complete; replaying all migrations from scratch."
fi

# ---------------------------------------------------------------------------
# Phase 3 — apply pending migrations
# ---------------------------------------------------------------------------
applied=0
skipped=0
for f in "${sorted[@]}"; do
  base="$(basename "$f" .sql)"
  version="${base%%_*}"
  name="${base#*_}"
  hash="$(sha_of "$f")"

  exists="$(psql -tA -v ver="${version}" <<'SQL'
SELECT 1 FROM supabase_migrations.schema_migrations WHERE version=:'ver';
SQL
)"
  if [ "${exists}" = "1" ]; then
    skipped=$((skipped+1))
    continue
  fi
  echo "[migrate] applying ${base}"
  psql -v ON_ERROR_STOP=1 --single-transaction -f "$f"
  psql -v ON_ERROR_STOP=1 -v ver="${version}" -v mname="${name}" -v hash="${hash}" <<'SQL'
INSERT INTO supabase_migrations.schema_migrations (version, name, file_hash)
VALUES (:'ver', :'mname', :'hash')
ON CONFLICT (version) DO UPDATE SET file_hash = EXCLUDED.file_hash;
SQL
  applied=$((applied+1))
done

echo "[migrate] done — applied=${applied} skipped=${skipped}"
