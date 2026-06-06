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
# Logging contract: every line is prefixed `[seed]` and timestamped so it
# reads cleanly through `kubectl logs`. On ANY failure the script prints a
# diagnostic snapshot (row counts for the tables the seed populates) before
# exiting — a failed seed is almost always a *partial* seed, and knowing how
# far it got (e.g. "1 class, 1 user, 0 everything-else" => died right after
# the first gotrue user) is the difference between a 2-minute diagnosis and
# re-running the whole stack to reproduce. See the 2026-06-06 preview-deploy
# incident: a transient auth/postgres startup race killed the seed partway,
# but the pod was gone before its logs could be read.
#
# Env (consumed; see Dockerfile for full list):
#   PGHOST, PGPORT, PGUSER, PGDATABASE, PGPASSWORD
#   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (used by createAdminClient)
#   TEST_PASSWORD                            (password for seeded users)
#   SEED_TEMPLATE (default: small)
#   FIXED_INSTRUCTOR_EMAIL, FIXED_GRADER_EMAIL, FIXED_STUDENT_EMAIL

set -euo pipefail

# Timestamped, prefixed logging. log -> stdout, warn/err -> stderr.
log()  { echo "[seed] $(date -u +%H:%M:%S) $*"; }
warn() { echo "[seed] $(date -u +%H:%M:%S) WARN  $*" >&2; }
err()  { echo "[seed] $(date -u +%H:%M:%S) ERROR $*" >&2; }

: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${SUPABASE_URL:?SUPABASE_URL is required (in-cluster Kong URL)}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY is required}"
export PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY

SEED_TEMPLATE="${SEED_TEMPLATE:-small}"

# -----------------------------------------------------------------------------
# Diagnostic snapshot — how far did the seed get?
# -----------------------------------------------------------------------------
# Printed on every failure (via the ERR trap) and after the idempotency skip.
# Every query is guarded so the snapshot itself can never fail the script /
# mask the original error. A missing table (early failure, pre-migrations)
# just prints "n/a".
snapshot() {
  local label="${1:-state}"
  err "── diagnostic snapshot (${label}) ──"
  local t
  for t in \
    "auth.users" \
    "public.classes" \
    "public.profiles" \
    "public.user_roles" \
    "public.assignments" \
    "public.submissions"; do
    local n
    n="$(psql -tAc "SELECT count(*) FROM ${t}" 2>/dev/null)" || n="n/a (no table / no connection)"
    err "    ${t}: ${n:-n/a}"
  done
  err "──────────────────────────────────"
}

# ERR trap: fires on any unhandled non-zero command (e.g. SeedDB.ts throwing,
# a psql error under `set -e`). Prints where it died + the snapshot, then lets
# the non-zero exit propagate.
on_err() {
  local rc=$?
  err "failed (exit ${rc}) at line ${BASH_LINENO[0]:-?}: ${BASH_COMMAND}"
  snapshot "on failure"
}
trap on_err ERR

# fail <msg> — for the expected guard failures below. Logs, snapshots, exits 1.
# Uses its own exit so the message is specific; the ERR trap won't double-fire
# because we exit straight away.
fail() { err "$*"; snapshot "on failure"; exit 1; }

log "target=${PGUSER}@${PGHOST}:${PGPORT:-5432}/${PGDATABASE}"
log "template=${SEED_TEMPLATE}"
if [ -n "${FIXED_INSTRUCTOR_EMAIL:-}${FIXED_GRADER_EMAIL:-}${FIXED_STUDENT_EMAIL:-}" ]; then
  log "fixed users: instructor=${FIXED_INSTRUCTOR_EMAIL:-(faker)} grader=${FIXED_GRADER_EMAIL:-(faker)} student=${FIXED_STUDENT_EMAIL:-(faker)}"
fi

# -----------------------------------------------------------------------------
# Phase 1 — wait for postgres
# -----------------------------------------------------------------------------
ready=0
for i in $(seq 1 60); do
  if pg_isready -q; then ready=1; break; fi
  log "waiting for postgres ($i/60)"
  sleep 2
done
if [ "$ready" -ne 1 ]; then
  # Surface the actual pg_isready diagnostic instead of a bare timeout.
  err "postgres did not become ready after 120s; last pg_isready:"
  pg_isready || true
  fail "postgres unavailable"
fi
log "postgres ready"

# -----------------------------------------------------------------------------
# Phase 2 — wait for supabase services to finish their own migrations
# -----------------------------------------------------------------------------
# Mirrors the wait-for-supabase-services init container in the migrations
# job. SeedDB.ts inserts rows into public.* and references auth.users by
# id; if auth hasn't bootstrapped yet, the FK to auth.users blows up.
check_ready() {
  psql -tAc "$1" 2>/dev/null | grep -q 1
}
# Human label for each guard so a timeout names the laggard rather than just
# reporting "not ready".
declare -a SVC_LABELS=(
  "auth schema (auth.identities)"
  "storage schema (storage.buckets.public)"
  "realtime publication (supabase_realtime)"
  "realtime schema (realtime.messages)"
)
declare -a SVC_CHECKS=(
  "SELECT 1 FROM information_schema.tables WHERE table_schema='auth' AND table_name='identities'"
  "SELECT 1 FROM information_schema.columns WHERE table_schema='storage' AND table_name='buckets' AND column_name='public'"
  "SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime'"
  "SELECT 1 FROM information_schema.tables WHERE table_schema='realtime' AND table_name='messages'"
)
ready=0
for i in $(seq 1 90); do
  ok=true
  pending=""
  for idx in "${!SVC_CHECKS[@]}"; do
    if ! check_ready "${SVC_CHECKS[$idx]}"; then
      ok=false
      pending="${pending:+$pending, }${SVC_LABELS[$idx]}"
    fi
  done
  if $ok; then ready=1; log "supabase services migrated"; break; fi
  log "waiting for supabase services ($i/90) — pending: ${pending}"
  sleep 4
done
if [ "$ready" -ne 1 ]; then
  fail "supabase services not ready after 6min — still pending: ${pending}"
fi

# Also wait for pawtograder migrations to apply public.classes etc. The
# migrations Job is a regular install resource (not a hook), so we may
# fire before it completes if --wait-for-jobs is misbehaving upstream.
if ! psql -tAc "SELECT to_regclass('public.classes') IS NOT NULL" | grep -q '^t$'; then
  fail "public.classes does not exist — pawtograder migrations have not completed"
fi

# -----------------------------------------------------------------------------
# Phase 2b — wait for the Auth HTTP API (gotrue, via Kong) to actually serve.
# -----------------------------------------------------------------------------
# Phase 2 only proves the auth SCHEMA exists in postgres. SeedDB.ts creates its
# users through the gotrue admin HTTP API ($SUPABASE_URL/auth/v1), which can
# still be cold when this post-install hook fires the instant the stack comes
# up — that race aborts seeding partway through. Poll gotrue's health endpoint
# until it answers 200 (node 22 ships a global fetch; the image has no curl).
auth_ready() {
  node -e '
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
    fetch(process.env.SUPABASE_URL + "/auth/v1/health", { headers: { apikey: key } })
      .then((r) => process.exit(r.ok ? 0 : 1))
      .catch(() => process.exit(1));
  ' 2>/dev/null
}
# Verbose probe used only when the wait times out: prints the HTTP status or
# the fetch error so we can tell "gotrue 503 / still migrating" apart from
# "DNS/connection refused" apart from "wrong URL".
auth_probe_verbose() {
  node -e '
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
    const url = process.env.SUPABASE_URL + "/auth/v1/health";
    fetch(url, { headers: { apikey: key } })
      .then(async (r) => { console.error("    GET " + url + " -> HTTP " + r.status + " " + (await r.text()).slice(0, 200)); process.exit(0); })
      .catch((e) => { console.error("    GET " + url + " -> " + (e && e.message ? e.message : e)); process.exit(0); });
  ' 2>&1 || true
}
ready=0
for i in $(seq 1 60); do
  if auth_ready; then ready=1; log "auth HTTP API ready"; break; fi
  log "waiting for auth HTTP API ($i/60)"
  sleep 3
done
if [ "$ready" -ne 1 ]; then
  err "auth HTTP API ($SUPABASE_URL/auth/v1) not serving after 180s; last probe:"
  auth_probe_verbose
  fail "auth HTTP API unavailable"
fi

# -----------------------------------------------------------------------------
# Phase 2c — wait for PostgREST to serve the freshly-migrated schema.
# -----------------------------------------------------------------------------
# SeedDB.ts does all its writes through PostgREST (the REST API behind
# $SUPABASE_URL/rest/v1), not raw SQL. On a fresh install the migrations Job
# creates public.* only moments before this hook fires, and PostgREST caches
# the schema — until it reloads, requests against the just-migrated tables hit
# a stale cache and the seeder fails partway with a confusing downstream error
# (observed 2026-06-06: "Failed to get profile: Cannot coerce the result to a
# single JSON object" — the user_roles read-back found 0 rows because the write
# never landed through the cold cache; deterministic on every fresh preview).
# Nudge a reload (NOTIFY pgrst) and poll until REST actually serves a migrated
# table before we start seeding.
rest_probe() {
  node -e '
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
    const url = process.env.SUPABASE_URL + "/rest/v1/classes?select=id&limit=1";
    fetch(url, { headers: { apikey: key, Authorization: "Bearer " + key } })
      .then(async (r) => {
        if (process.env.SEED_REST_VERBOSE) console.error("    GET /rest/v1/classes -> HTTP " + r.status + " " + (await r.text()).slice(0, 200));
        process.exit(r.ok ? 0 : 1);
      })
      .catch((e) => { if (process.env.SEED_REST_VERBOSE) console.error("    " + (e && e.message ? e.message : e)); process.exit(1); });
  ' 2>/dev/null
}
psql -tAc "NOTIFY pgrst, 'reload schema'" >/dev/null 2>&1 || true
ready=0
for i in $(seq 1 60); do
  if rest_probe; then ready=1; log "PostgREST serving migrated schema (public.classes)"; break; fi
  # Re-nudge each iteration: PostgREST coalesces reload NOTIFYs, so this is cheap.
  psql -tAc "NOTIFY pgrst, 'reload schema'" >/dev/null 2>&1 || true
  log "waiting for PostgREST schema cache ($i/60)"
  sleep 3
done
if [ "$ready" -ne 1 ]; then
  err "PostgREST ($SUPABASE_URL/rest/v1) not serving migrated schema after 180s; last probe:"
  SEED_REST_VERBOSE=1 rest_probe || true
  fail "PostgREST schema cache cold — writes would silently fail"
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
  log "${existing} non-archived class(es) already present — skipping seed"
  # A class with no roles/assignments is the fingerprint of a *previous*
  # failed seed: the skip below would then mask that broken state as a green
  # deploy. We don't change behaviour (still skip — flipping it could wipe a
  # real class), but we log loudly so the false-green is visible at a glance.
  roles="$(psql -tAc "SELECT count(*) FROM public.user_roles" 2>/dev/null || echo n/a)"
  asgn="$(psql -tAc "SELECT count(*) FROM public.assignments" 2>/dev/null || echo n/a)"
  log "existing data: user_roles=${roles} assignments=${asgn}"
  if [ "${roles:-0}" = "0" ] || [ "${asgn:-0}" = "0" ]; then
    warn "existing class looks PARTIAL (no roles or no assignments) — likely a"
    warn "prior failed seed. This preview may be incompletely seeded even though"
    warn "the deploy is green. Archive the class to force a clean re-seed."
  fi
  exit 0
fi

# -----------------------------------------------------------------------------
# Phase 4 — run the realistic seeder
# -----------------------------------------------------------------------------
log "running scripts/SeedDB.ts --template ${SEED_TEMPLATE}"
# No .env.local is created here: SeedDB.ts reads its config from the environment
# (exported above / fed by the K8s Secret), and its
# dotenv.config({ path: ".env.local", quiet: true }) call silently tolerates a
# missing file — so the seeder needs no dotenv file at all.
# A non-zero exit here trips the ERR trap, which prints the diagnostic snapshot.
npx tsx scripts/SeedDB.ts --template "${SEED_TEMPLATE}"

log "done"
