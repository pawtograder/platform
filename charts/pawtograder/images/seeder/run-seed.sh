#!/usr/bin/env bash
# Pawtograder seeder runtime.
#
# Orchestrates the realistic-class seed against a running preview
# cluster:
#   1. wait for postgres
#   2. wait for the supabase services (auth/storage/realtime) to
#      finish their own migrations — same guard as the migrations job
#   3. skip if the demo class already exists (idempotent across helm
#      upgrades; first install seeds, subsequent upgrades are no-ops)
#   4. invoke scripts/SeedDB.ts with the configured template and the
#      FIXED_*_EMAIL env vars so the deterministic instructor / grader
#      / student emails get woven into the simulation (not bolted on
#      after the fact — they ARE the first user of each role)
#
# Env (consumed; see Dockerfile for full list):
#   PGHOST, PGPORT, PGUSER, PGDATABASE, PGPASSWORD
#   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (used by createAdminClient)
#   TEST_PASSWORD                            (password for seeded users)
#   SEED_TEMPLATE (default: small)
#   FIXED_INSTRUCTOR_EMAIL, FIXED_GRADER_EMAIL, FIXED_STUDENT_EMAIL

set -euo pipefail

: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${SUPABASE_URL:?SUPABASE_URL is required (in-cluster Kong URL)}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY is required}"
export PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY

SEED_TEMPLATE="${SEED_TEMPLATE:-small}"

echo "[seed] target=${PGUSER}@${PGHOST}:${PGPORT:-5432}/${PGDATABASE}"
echo "[seed] template=${SEED_TEMPLATE}"
if [ -n "${FIXED_INSTRUCTOR_EMAIL:-}${FIXED_GRADER_EMAIL:-}${FIXED_STUDENT_EMAIL:-}" ]; then
  echo "[seed] fixed users: instructor=${FIXED_INSTRUCTOR_EMAIL:-(faker)} grader=${FIXED_GRADER_EMAIL:-(faker)} student=${FIXED_STUDENT_EMAIL:-(faker)}"
fi

# -----------------------------------------------------------------------------
# Phase 1 — wait for postgres
# -----------------------------------------------------------------------------
ready=0
for i in $(seq 1 60); do
  if pg_isready -q; then ready=1; break; fi
  echo "[seed] waiting for postgres ($i/60)"
  sleep 2
done
if [ "$ready" -ne 1 ]; then
  echo "[seed] postgres did not become ready after 120s" >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# Phase 2 — wait for supabase services to finish their own migrations
# -----------------------------------------------------------------------------
# Mirrors the wait-for-supabase-services init container in the migrations
# job. SeedDB.ts inserts rows into public.* and references auth.users by
# id; if auth hasn't bootstrapped yet, the FK to auth.users blows up.
check_ready() {
  psql -tAc "$1" 2>/dev/null | grep -q 1
}
ready=0
for i in $(seq 1 90); do
  ok=true
  check_ready "SELECT 1 FROM information_schema.tables WHERE table_schema='auth' AND table_name='identities'"                                                || ok=false
  check_ready "SELECT 1 FROM information_schema.columns WHERE table_schema='storage' AND table_name='buckets' AND column_name='public'"                       || ok=false
  check_ready "SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime'"                                                                                || ok=false
  check_ready "SELECT 1 FROM information_schema.tables WHERE table_schema='realtime' AND table_name='messages'"                                               || ok=false
  if $ok; then ready=1; echo "[seed] supabase services migrated"; break; fi
  echo "[seed] waiting for supabase services ($i/90)"
  sleep 4
done
if [ "$ready" -ne 1 ]; then
  echo "[seed] supabase services not ready after 6min" >&2
  exit 1
fi

# Also wait for pawtograder migrations to apply public.classes etc. The
# migrations Job is a regular install resource (not a hook), so we may
# fire before it completes if --wait-for-jobs is misbehaving upstream.
if ! psql -tAc "SELECT to_regclass('public.classes') IS NOT NULL" | grep -q '^t$'; then
  echo "[seed] public.classes does not exist — pawtograder migrations have not completed" >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# Phase 3 — idempotency check
# -----------------------------------------------------------------------------
# SeedDB.ts always creates a NEW class with the configured name. If we
# already seeded once we'd silently double up, producing two demo classes
# named identically. Skip when ANY non-archived class exists in the demo
# org so re-runs across helm upgrades are no-ops.
existing="$(psql -tAc "SELECT count(*) FROM public.classes WHERE archived=false")"
if [ "${existing:-0}" -gt 0 ]; then
  echo "[seed] ${existing} non-archived class(es) already present — skipping seed"
  exit 0
fi

# -----------------------------------------------------------------------------
# Phase 4 — run the realistic seeder
# -----------------------------------------------------------------------------
echo "[seed] running scripts/SeedDB.ts --template ${SEED_TEMPLATE}"
# SeedDB.ts loads config from the environment (fed by the K8s Secret), not from
# a file. Its dotenv.config({ path: ".env.local", quiet: true }) silently
# tolerates a missing .env.local — so DON'T create one here: the image runs as
# USER node but WORKDIR /app is root-owned, and writing into it fails with
# "Permission denied", which aborts the whole seed.
# DIAGNOSTIC (temporary — REMOVE after capture): the preview deploy tears down
# the namespace the instant the seed hook fails, so the pod's stderr is never
# readable. On failure, hold the pod alive so it can be read live.
if ! npx tsx scripts/SeedDB.ts --template "${SEED_TEMPLATE}"; then
  rc=$?
  echo "[seed] DIAGNOSTIC: SeedDB.ts exited ${rc}; holding pod 900s for log capture"
  sleep 900
  exit "${rc}"
fi

echo "[seed] done"
