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
#   MIGRATIONS_RESET_ON_DRIFT=true   reset the application data and replay
#                                    everything from scratch. NOT the default,
#                                    must be set explicitly, AND only honored
#                                    when MIGRATIONS_ENVIRONMENT is an ephemeral
#                                    tier (dev | preview) — otherwise refused so
#                                    a durable env can never be wiped here, even
#                                    if the flag leaks onto it.
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
# Deployment tier. The destructive drift reset is permitted ONLY on ephemeral
# tiers (dev / preview); migrate.sh re-checks this at runtime so a stray
# RESET_ON_DRIFT=true on a durable env (set directly on the Job, bypassing the
# Helm render guard in templates/validations.yaml) still can't wipe it.
MIGRATIONS_ENVIRONMENT="${MIGRATIONS_ENVIRONMENT:-}"
RESET_ALLOWED_TIERS="dev preview"

echo "[migrate] target=${PGUSER}@${PGHOST}:${PGPORT:-5432}/${PGDATABASE}"
echo "[migrate] source=${MIGRATIONS_DIR}"
echo "[migrate] environment=${MIGRATIONS_ENVIRONMENT:-<unset>}"
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
# mapfile -t handles filenames containing whitespace correctly; word-splitting
# on IFS=$'\n' breaks on names with literal newlines (rare here, but cheap to
# avoid).
mapfile -t sorted < <(printf '%s\n' "${files[@]}" | sort)

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

  # Distinguish "no row" from "row with NULL file_hash" by mapping NULL
  # to a sentinel value that can't collide with a real sha-256 digest.
  # COALESCE-to-empty here would merge those two cases and skip the
  # legacy back-fill branch forever.
  stored="$(psql -tA -v ver="${version}" <<'SQL'
SELECT CASE
         WHEN file_hash IS NULL THEN '__legacy__'
         ELSE file_hash
       END
  FROM supabase_migrations.schema_migrations WHERE version=:'ver';
SQL
)"

  case "$stored" in
    "")
      # Row doesn't exist yet — this migration will be applied in phase 3.
      continue
      ;;
    "__legacy__")
      # Row exists but pre-dates hash tracking. Back-fill silently and
      # treat as healthy from now on.
      psql -v ON_ERROR_STOP=1 -v ver="${version}" -v hash="${current}" <<'SQL'
UPDATE supabase_migrations.schema_migrations SET file_hash=:'hash' WHERE version=:'ver';
SQL
      backfilled=$((backfilled+1))
      continue
      ;;
    "$current")
      # Healthy: stored hash matches on-disk file.
      continue
      ;;
    *)
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
    echo "[migrate]          (b) on an ephemeral dev/preview env, set" >&2
    echo "[migrate]              MIGRATIONS_RESET_ON_DRIFT=true to wipe + replay" >&2
    echo "[migrate]              (DEV / PREVIEW ONLY — destroys all application data)," >&2
    echo "[migrate]          (c) accept the drift manually:" >&2
    echo "[migrate]              UPDATE supabase_migrations.schema_migrations" >&2
    echo "[migrate]              SET file_hash='<new-sha>' WHERE version='<version>';" >&2
    exit 1
  fi

  # Defense in depth: the reset below wipes schema public AND auth.users +
  # vault.secrets. Permit it ONLY on an ephemeral tier, even with the flag set,
  # so a misconfigured durable env (staging/production) can never be wiped here.
  case " ${RESET_ALLOWED_TIERS} " in
    *" ${MIGRATIONS_ENVIRONMENT} "*) ;;
    *)
      echo "[migrate] ERROR: MIGRATIONS_RESET_ON_DRIFT=true but MIGRATIONS_ENVIRONMENT=${MIGRATIONS_ENVIRONMENT:-<unset>}." >&2
      echo "[migrate]        The drift reset DESTROYS ALL DATA (schema public, auth.users," >&2
      echo "[migrate]        vault.secrets) and is permitted only on an ephemeral tier" >&2
      echo "[migrate]        (MIGRATIONS_ENVIRONMENT one of: ${RESET_ALLOWED_TIERS}). Refusing." >&2
      exit 1
      ;;
  esac

  echo "[migrate] MIGRATIONS_RESET_ON_DRIFT=true (tier=${MIGRATIONS_ENVIRONMENT}) — wiping application data and replaying."
  echo "[migrate] This drops schema public + truncates schema_migrations, and clears"
  echo "[migrate] the RLS policies our migrations create on storage.objects/buckets."
  echo "[migrate] Pawtograder tables live in public; the storage/auth/realtime service"
  echo "[migrate] base tables (schemas) stay intact, but auth.users DATA and vault.secrets"
  echo "[migrate] ARE cleared below so the re-seed rebuilds a consistent auth+public set —"
  echo "[migrate] every user must re-launch/re-invite or be re-seeded after this reset."

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

-- The storage schema is owned by the storage service, so we don't drop it —
-- but our migrations create RLS policies (and buckets) in it. Those survive the
-- public reset and then collide on replay ("policy ... already exists" on
-- storage.objects). Drop every storage policy so phase 3 can recreate them
-- idempotently; the storage service's own base tables/migrations are untouched.
DO $reset_storage$
DECLARE r record;
BEGIN
  IF to_regnamespace('storage') IS NOT NULL THEN
    FOR r IN
      SELECT policyname, tablename FROM pg_policies WHERE schemaname = 'storage'
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON storage.%I', r.policyname, r.tablename);
    END LOOP;
  END IF;
END
$reset_storage$;

-- pg_cron is created `WITH SCHEMA pg_catalog` (and the migration that does so is
-- NOT `IF NOT EXISTS`), so it survives the public reset and replay then errors
-- "extension pg_cron already exists". Drop it (CASCADE removes its cron.job
-- rows) so the migration can recreate it. Any other extension our migrations
-- create uses `IF NOT EXISTS` and is safe to leave in place.
DROP EXTENSION IF EXISTS pg_cron CASCADE;

-- Our migrations seed vault.secrets (e.g. supabase_project_url,
-- edge-function-secret, vercel_host, cache_invalidation_secret) via
-- vault.create_secret, which is unique on name and errors on replay. A fresh
-- database has an empty vault, so clear it; the migrations + phase 4 below
-- recreate the secrets they need.
DELETE FROM vault.secrets;

-- Our migrations create triggers on auth.users / auth.identities (e.g.
-- create_user_ensure_profiles_and_demo). Those live in the auth schema and
-- survive the public reset, so replay errors "trigger ... already exists". A
-- fresh database has no custom triggers there; drop the non-internal ones so
-- the migrations recreate them.
DO $reset_auth_triggers$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT t.tgname, c.oid::regclass AS tbl
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'auth' AND c.relname IN ('users', 'identities') AND NOT t.tgisinternal
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', r.tgname, r.tbl);
  END LOOP;
END
$reset_auth_triggers$;

-- Auth user *data* also lives in the auth schema and survives the public reset.
-- That orphans every previously-seeded auth.users row (its public.users profile
-- is gone with the public drop, and create_user_ensure_profiles_and_demo only
-- fires on new auth inserts so it never backfills). The re-seed then can't
-- recreate those users (createUser → "email already registered"), and LTI
-- launches hit the same wall. Clear auth user data so the seed rebuilds a
-- consistent auth+public set; FKs cascade to identities/sessions/refresh tokens.
DELETE FROM auth.users;

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

# ---------------------------------------------------------------------------
# Phase 3.5 — restore the API-role grants Supabase normally auto-applies
# ---------------------------------------------------------------------------
# Supabase's CLI runs migrations as `postgres`, whose ALTER DEFAULT PRIVILEGES
# auto-grant every new object to anon/authenticated/service_role. This runner
# connects as `supabase_admin`, so objects created here that aren't explicitly
# granted (and runtime-created ones like audit partitions) end up with NO grants
# — the server (service_role) hits "permission denied" creating a class, and the
# app (authenticated) hits it reading e.g. user_privileges. Re-assert the grants:
#
#   * service_role on EVERYTHING: trusted, server-only, already bypasses RLS, so
#     this exposes nothing new.
#   * anon/authenticated only on RLS-ENABLED tables: RLS gates the rows, matching
#     Supabase's default model. The few intentionally RLS-disabled internal
#     tables (e.g. class_metrics_totals) are left to their explicit migration
#     grants so we never expose them wholesale.
echo "[migrate] re-asserting service_role + API-role grants on public"
psql -v ON_ERROR_STOP=1 <<'SQL'
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;

-- anon/authenticated DML on RLS-enabled tables only (RLS enforces row access).
--
-- EXCEPTION: tables with deliberate COLUMN-level grants (e.g. lti_context_links
-- grants instructors UPDATE only on the sync-toggle/section columns, NOT
-- nrps_url/ags_lineitems_url — repointing those is SSRF + service-token
-- exfiltration). A blanket table-level GRANT UPDATE would silently widen those
-- to every column. For such tables restore only RLS-gated SELECT and leave their
-- migration-defined column grants intact; everything else gets full DML.
-- A column-level grant is detectable via a non-null pg_attribute.attacl.
DO $grant_api$
DECLARE r record; has_col_grant boolean;
BEGIN
  FOR r IN
    SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
      -- Service-internal LTI tables: writes are reserved to service_role by their
      -- own migrations (lti_nonces grants `authenticated` NOTHING; the grade-sync
      -- and identity tables grant only SELECT). A blanket anon+authenticated DML
      -- grant here would silently WIDEN those — handing `anon` write access to the
      -- OIDC replay-nonce table, where any later RLS gap becomes directly
      -- exploitable. Skip them so their explicit migration grants remain the ceiling.
      AND c.relname <> ALL (ARRAY[
        'lti_nonces', 'lti_users', 'lti_grade_sync_state', 'lti_grade_sync_queue'
      ])
  LOOP
    SELECT EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
    ) INTO has_col_grant;
    IF has_col_grant THEN
      EXECUTE format('GRANT SELECT ON public.%I TO anon, authenticated', r.relname);
    ELSE
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO anon, authenticated', r.relname);
    END IF;
  END LOOP;
END
$grant_api$;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
SQL

# ---------------------------------------------------------------------------
# Phase 4 — environment-specific vault secrets for DB→edge callbacks
# ---------------------------------------------------------------------------
# The gradebook migration seeds vault `supabase_project_url` and
# `edge-function-secret` with LOCAL DEV defaults
# (http://host.docker.internal:54321 / some-secret-value). Database triggers
# and pg_cron jobs call edge functions through pg_net via
# public.call_edge_function_internal, which reads those vault values. In a
# deployed cluster host.docker.internal is unreachable AND the e2e overlay
# overrides the edge runtime's EDGE_FUNCTION_SECRET, so without this step
# every DB-driven edge call (gradebook recalculation, email batch, discord,
# cache invalidation) silently fails — gradebook cells never refresh.
#
# When the operator provides SUPABASE_PROJECT_URL / EDGE_FUNCTION_SECRET
# (wired from the chart in templates/migrations-job.yaml), point the vault at
# the in-cluster gateway and the real shared secret. Idempotent: re-running
# the migrator re-asserts the values.
upsert_vault_secret() {
  local secret_name="$1" secret_value="$2"
  # BEGIN/COMMIT around DELETE+create so a failed create_secret rolls
  # the DELETE back. Without this, a transient failure here would wipe
  # the existing secret and leave every DB→edge callback broken until
  # the next successful migrator run.
  psql -v ON_ERROR_STOP=1 -v sname="${secret_name}" -v sval="${secret_value}" <<'SQL'
BEGIN;
DELETE FROM vault.secrets WHERE name = :'sname';
SELECT vault.create_secret(:'sval', :'sname', 'set by migrate.sh for in-cluster DB->edge callbacks');
COMMIT;
SQL
}

if [ -n "${SUPABASE_PROJECT_URL:-}" ]; then
  echo "[migrate] vault: setting supabase_project_url=${SUPABASE_PROJECT_URL}"
  upsert_vault_secret "supabase_project_url" "${SUPABASE_PROJECT_URL}"
fi
if [ -n "${EDGE_FUNCTION_SECRET:-}" ]; then
  echo "[migrate] vault: setting edge-function-secret (redacted)"
  upsert_vault_secret "edge-function-secret" "${EDGE_FUNCTION_SECRET}"
fi
