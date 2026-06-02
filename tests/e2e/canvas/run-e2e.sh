#!/usr/bin/env bash
# =============================================================================
# Canvas LTI 1.3 end-to-end orchestrator (shared by local runs and CI).
#
# Brings up the whole stack, wires Canvas <-> Pawtograder, then runs the
# dedicated Playwright suite (playwright.canvas.config.ts):
#
#   1. Canvas stack (web/jobs/pg/redis) via docker compose + bootstrap.
#   2. Local Supabase (with the LTI migration) for the Pawtograder tool.
#   3. The Pawtograder tool (Next.js) with LTI env, reachable at :3000 and,
#      from Canvas containers, at host.docker.internal:3000.
#   4. Seed a Canvas course/users/assignment + an LTI 1.3 developer key.
#   5. Register the Canvas platform in Pawtograder's DB.
#   6. Write tests/e2e/lti/.canvas-e2e.json and run Playwright.
#
# Idempotent-ish; honors SKIP_* flags so you can re-run fast while iterating:
#   SKIP_CANVAS_UP, SKIP_SUPABASE, SKIP_TOOL, SKIP_SEED   (set =1 to skip)
#   KEEP_UP=1   leave the stack running after the tests
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
COMPOSE="docker compose -f $HERE/docker-compose.yml"
cd "$REPO"

# --- Addressing -------------------------------------------------------------
# Canvas runs on host port 80 with domain "localhost" (no port). A non-default
# port leaks into Canvas's NRPS/AGS URL building and trips URI#host= in newer
# Canvas, so the domain must have no port — i.e. port 80.
CANVAS_HOST_PORT="${CANVAS_HOST_PORT:-80}"
if [ "$CANVAS_HOST_PORT" = "80" ]; then CANVAS_BASE_URL="http://localhost"; else CANVAS_BASE_URL="http://localhost:${CANVAS_HOST_PORT}"; fi  # browser + tool -> Canvas
TOOL_PORT="${TOOL_PORT:-3000}"
TOOL_BASE_URL="http://localhost:${TOOL_PORT}"            # browser -> tool
TOOL_FROM_CANVAS="http://host.docker.internal:${TOOL_PORT}" # Canvas server -> tool (JWKS)
export CANVAS_IMAGE="${CANVAS_IMAGE:-ghcr.io/pawtograder/canvas-lms-e2e:2026-05-20.143}"

OUT_JSON="$REPO/tests/e2e/lti/.canvas-e2e.json"

log() { echo -e "\n\033[1;36m==> $*\033[0m"; }

# --- 0. LTI secrets for the tool --------------------------------------------
# STABLE dev-only defaults (not for production). The tool's signing key is
# persisted encrypted under LTI_KEY_ENCRYPTION_SECRET; using a stable secret lets
# repeated local runs decrypt the same key. Override via env for real configs.
export LTI_KEY_ENCRYPTION_SECRET="${LTI_KEY_ENCRYPTION_SECRET:-cGF3dG9ncmFkZXItZTJlLWx0aS1rZXllbmMtMzJieXQ=}"
export LTI_STATE_SECRET="${LTI_STATE_SECRET:-pawtograder-e2e-lti-state-secret-dev-only}"
export LTI_CRON_SHARED_SECRET="${LTI_CRON_SHARED_SECRET:-pawtograder-e2e-cron-secret-dev}"
export LTI_TOOL_ISSUER="$TOOL_BASE_URL"

# --- 1. Canvas up + bootstrap ----------------------------------------------
if [ "${SKIP_CANVAS_UP:-}" != "1" ]; then
  log "Booting Canvas stack ($CANVAS_IMAGE)"
  docker image inspect "$CANVAS_IMAGE" >/dev/null 2>&1 || {
    echo "Canvas image $CANVAS_IMAGE not found locally."
    echo "Build it first:  tests/e2e/canvas/build.sh   (or pull from GHCR)"; exit 1; }
  # Only bring up the datastores here. web/jobs must NOT start before the DB is
  # created+migrated, or web's /health_check never passes on a fresh DB (and
  # `up` blocks on it via jobs' depends_on). bootstrap.sh sets up the DB and
  # then brings up web+jobs.
  $COMPOSE up -d postgres redis
  log "Bootstrapping Canvas (DB + admin + token)"
  CANVAS_ADMIN_TOKEN="$("$HERE/bootstrap.sh" | grep -E '^CANVAS_ADMIN_TOKEN=' | cut -d= -f2-)"
else
  log "SKIP_CANVAS_UP=1 (minting a fresh admin token)"
  CANVAS_ADMIN_TOKEN="$($COMPOSE run --rm --no-deps -T web bundle exec rails runner "$(cat "$HERE/scripts/mint_admin_token.rb")" | grep -E '^TOKEN=' | cut -d= -f2-)"
fi
[ -n "${CANVAS_ADMIN_TOKEN:-}" ] || { echo "ERROR: no Canvas admin token"; exit 1; }

# --- 2. Supabase (local) ----------------------------------------------------
if [ "${SKIP_SUPABASE:-}" != "1" ]; then
  if ! docker ps --format '{{.Names}}' | grep -q "supabase_db_"; then
    log "Starting local Supabase"
    npx supabase start
  else
    log "Supabase already running"
  fi
fi
# Capture connection details for the tool + platform registration.
eval "$(npx supabase status -o env | sed 's/^/SB_/')"
# Names consumed by the tool, by tests/e2e/TestingUtils (createAdminClient), and
# by register-platform.ts.
export SUPABASE_URL="${SB_API_URL:-http://127.0.0.1:54321}"
export SUPABASE_SERVICE_ROLE_KEY="${SB_SERVICE_ROLE_KEY:?supabase service role key not found}"
export SUPABASE_ANON_KEY="${SB_ANON_KEY:-}"
export NEXT_PUBLIC_SUPABASE_URL="$SUPABASE_URL"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY"

# Reset the tool's signing key so a fresh one is created under the CURRENT
# LTI_KEY_ENCRYPTION_SECRET (a key persisted under a different secret can't be
# decrypted). Safe: it's a throwaway e2e key, and create_dev_key.rb re-syncs the
# new public JWK into Canvas. No-op on a fresh DB.
if [ "${SKIP_SUPABASE:-}" != "1" ]; then
  SB_DB="$(docker ps --format '{{.Names}}' | grep supabase_db | head -1)"
  [ -n "$SB_DB" ] && docker exec -i "$SB_DB" psql -U postgres -d postgres \
    -c "DELETE FROM lti_tool_keys;" >/dev/null 2>&1 || true
fi

# --- 3. Pawtograder tool ----------------------------------------------------
TOOL_PID=""
if [ "${SKIP_TOOL:-}" != "1" ]; then
  log "Starting Pawtograder tool on 0.0.0.0:${TOOL_PORT}"
  # Free the port if a stale tool holds it — otherwise the new tool fails to bind
  # and the readiness check passes against the wrong process (wrong secrets).
  fuser -k "${TOOL_PORT}/tcp" 2>/dev/null && sleep 2 || true
  ( npx next dev -H 0.0.0.0 -p "$TOOL_PORT" >/tmp/pawtograder-tool.log 2>&1 & echo $! > /tmp/pawtograder-tool.pid )
  TOOL_PID="$(cat /tmp/pawtograder-tool.pid)"
  log "Waiting for tool /api/lti/jwks (also creates the signing key)"
  for i in $(seq 1 60); do
    if curl -fsS "$TOOL_BASE_URL/api/lti/jwks" >/dev/null 2>&1; then echo "  tool up"; break; fi
    sleep 2; [ "$i" = 60 ] && { echo "ERROR: tool did not start"; tail -40 /tmp/pawtograder-tool.log; exit 1; }
  done
fi
cleanup() { [ -n "$TOOL_PID" ] && kill "$TOOL_PID" 2>/dev/null || true
            [ "${KEEP_UP:-}" = "1" ] || $COMPOSE down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

# --- 4. Seed Canvas course + LTI dev key ------------------------------------
log "Seeding Canvas course/users/assignment"
SEED="$($COMPOSE run --rm --no-deps -T web bundle exec rails runner "$(cat "$HERE/scripts/seed_course.rb")")"
echo "$SEED"
getv() { echo "$SEED" | grep -E "^$1=" | head -1 | cut -d= -f2-; }
COURSE_ID="$(getv COURSE_ID)"; ASSIGNMENT_ID="$(getv ASSIGNMENT_ID)"
TEACHER_EMAIL="$(getv TEACHER_EMAIL)"; TEACHER_PASSWORD="$(getv TEACHER_PASSWORD)"
mapfile -t STUDENT_EMAILS < <(echo "$SEED" | grep -E '^STUDENT_EMAIL=' | cut -d= -f2-)

log "Creating/Enabling LTI 1.3 developer key in Canvas"
# Embed the tool's live public JWK inline in the dev key (Canvas won't fetch an
# http JWKS URL). Take the first published key.
TOOL_JWK="$(curl -s "$TOOL_BASE_URL/api/lti/jwks" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s).keys[0])))')"
DK="$($COMPOSE run --rm --no-deps -T \
  -e PG_OIDC_LOGIN_URL="$TOOL_BASE_URL/api/lti/login" \
  -e PG_LAUNCH_URL="$TOOL_BASE_URL/api/lti/launch" \
  -e PG_JWKS_URL="$TOOL_FROM_CANVAS/api/lti/jwks" \
  -e PG_PUBLIC_JWK="$TOOL_JWK" \
  -e PG_COURSE_CODE="PAW-E2E" \
  web bundle exec rails runner "$(cat "$HERE/scripts/create_dev_key.rb")")"
echo "$DK"
CLIENT_ID="$(echo "$DK" | grep -E '^CLIENT_ID=' | cut -d= -f2-)"
DEPLOYMENT_ID="$(echo "$DK" | grep -E '^DEPLOYMENT_ID=' | cut -d= -f2-)"
TOOL_ID="$(echo "$DK" | grep -E '^TOOL_ID=' | cut -d= -f2-)"
ISSUER="$(echo "$DK" | grep -E '^ISSUER=' | cut -d= -f2-)"
[ -n "$CLIENT_ID" ] || { echo "ERROR: no CLIENT_ID from dev key"; exit 1; }

# --- 5. Register the Canvas platform in Pawtograder -------------------------
log "Registering Canvas as an LTI platform in Pawtograder"
CANVAS_ISSUER="$ISSUER" CANVAS_CLIENT_ID="$CLIENT_ID" CANVAS_BASE_URL="$CANVAS_BASE_URL" \
  npx tsx tests/e2e/lti/register-platform.ts

# --- 6. Capture context for the spec + run Playwright -----------------------
export CANVAS_BASE_URL TOOL_BASE_URL ISSUER CLIENT_ID DEPLOYMENT_ID TOOL_ID COURSE_ID ASSIGNMENT_ID TEACHER_EMAIL TEACHER_PASSWORD CANVAS_ADMIN_TOKEN OUT_JSON
export STUDENT_EMAILS_CSV="$(IFS=,; echo "${STUDENT_EMAILS[*]}")"

log "Writing $OUT_JSON"
node -e '
const fs=require("fs");
const out={
  canvasBaseUrl: process.env.CANVAS_BASE_URL,
  toolBaseUrl: process.env.TOOL_BASE_URL,
  issuer: process.env.ISSUER,
  clientId: process.env.CLIENT_ID,
  deploymentId: process.env.DEPLOYMENT_ID,
  canvasCourseId: process.env.COURSE_ID,
  canvasToolId: process.env.TOOL_ID,
  canvasAssignmentId: process.env.ASSIGNMENT_ID,
  teacher: { email: process.env.TEACHER_EMAIL, password: process.env.TEACHER_PASSWORD },
  students: (process.env.STUDENT_EMAILS_CSV||"").split(",").filter(Boolean).map(email=>({ email, password: process.env.TEACHER_PASSWORD })),
  canvasAdminToken: process.env.CANVAS_ADMIN_TOKEN,
  ltiCronSecret: process.env.LTI_CRON_SHARED_SECRET
};
fs.writeFileSync(process.env.OUT_JSON, JSON.stringify(out,null,2));
console.log(out);
'

log "Running Canvas LTI Playwright suite"
npx playwright test --config playwright.canvas.config.ts
