#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
COMPOSE="docker compose -f $HERE/docker-compose.yml"
cd "$REPO"

export SB_PORT_OFFSET="${SB_PORT_OFFSET:-2000}"
export SB_API_PORT=$((54321 + SB_PORT_OFFSET))
export PAW_PORT="${PAW_PORT:-3300}"
export FORGEJO_PORT="${FORGEJO_PORT:-3100}"
export CODER_PORT="${CODER_PORT:-7080}"
PAW_BASE_URL="http://127.0.0.1:${PAW_PORT}"
FORGEJO_BASE_URL="http://127.0.0.1:${FORGEJO_PORT}"
CODER_BASE_URL="http://127.0.0.1:${CODER_PORT}"
export FORGEJO_AUTH_SOURCE_NAME=pawtograder
[ "${ONLY:-}" = "1" ] && { KEEP_UP=1; SKIP_SUPABASE=1; }

# Outside the repo, or test runners pick up the copied supabase/functions *.test.ts.
WORK="${SSO_E2E_WORKDIR:-${TMPDIR:-/tmp}/pawtograder-sso-e2e}"
LOGS="$HERE/.logs"
SB="npx supabase --workdir $WORK"
OUT_JSON="$REPO/tests/e2e/sso/.forgejo-coder-e2e.json"

FORGEJO_ADMIN_USER=forgejo-admin
FORGEJO_ADMIN_PASSWORD=forgejo-e2e-admin-pw
CODER_ADMIN_EMAIL=admin@coder.e2e.test
CODER_ADMIN_PASSWORD=coder-e2e-Admin-pw-1

log() { echo -e "\n\033[1;36m==> $*\033[0m"; }
port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
wait_for() {
  for i in $(seq 1 "$2"); do
    if curl -fsS -o /dev/null "$1" 2>/dev/null; then echo "  $3 up"; return 0; fi
    sleep 2
  done
  echo "ERROR: $3 did not come up at $1"; return 1
}
mkdir -p "$LOGS" "$WORK"

TOOL_PID=""
cleanup() {
  if [ "${KEEP_UP:-}" != "1" ]; then
    [ -n "$TOOL_PID" ] && kill -- "-$TOOL_PID" 2>/dev/null || true
    for s in forgejo coder; do $COMPOSE logs --no-color "$s" >"$LOGS/$s.log" 2>&1 || true; done
    $COMPOSE down -v >/dev/null 2>&1 || true
    [ "${SKIP_SUPABASE:-}" = "1" ] || $SB stop --no-backup >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [ "${SKIP_SUPABASE:-}" != "1" ]; then
  log "Starting isolated Supabase (project pawtograder-sso-e2e, API :$SB_API_PORT)"
  rm -rf "$WORK/supabase"
  cp -R "$REPO/supabase" "$WORK/supabase"
  rm -rf "$WORK/supabase/.temp" "$WORK/supabase/.branches"
  node "$HERE/patch-supabase-config.mjs" "$WORK/supabase/config.toml" "$SB_PORT_OFFSET" "$PAW_BASE_URL"
  # A KEEP_UP or cancelled run leaves the project's volumes, and start would restore that stale schema.
  $SB stop --no-backup >/dev/null 2>&1 || true
  for v in $(docker volume ls -q --filter label=com.supabase.cli.project=pawtograder-sso-e2e); do docker volume rm "$v" >/dev/null; done
  # logflare/vector fail their health check on the e2e runner.
  $SB start -x logflare,vector,studio,imgproxy,edge-runtime
fi
eval "$($SB status -o env | sed 's/^/SB_/')"
export SUPABASE_URL="${SB_API_URL:?supabase API URL not found}"
export SUPABASE_SERVICE_ROLE_KEY="${SB_SERVICE_ROLE_KEY:?supabase service role key not found}"
export SUPABASE_ANON_KEY="${SB_ANON_KEY:?}"
export NEXT_PUBLIC_SUPABASE_URL="$SUPABASE_URL"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY"
export NEXT_PUBLIC_PAWTOGRADER_WEB_URL="$PAW_BASE_URL"
export SB_ISSUER="$SUPABASE_URL/auth/v1"
wait_for "$SB_ISSUER/.well-known/openid-configuration" 30 "OIDC discovery"
# TestingUtils falls back to .env.local, which would seed the developer's own database.
[ "${ONLY:-}" = "1" ] && exec npx playwright test --config playwright.forgejo-coder.config.ts "$@"

log "Registering Forgejo and Coder as OAuth clients"
CLIENTS="$(FORGEJO_BASE_URL="$FORGEJO_BASE_URL" CODER_BASE_URL="$CODER_BASE_URL" npx tsx tests/e2e/sso/register-oauth-clients.ts)"
getc() { echo "$CLIENTS" | grep -E "^$1=" | head -1 | cut -d= -f2-; }
FORGEJO_OIDC_CLIENT_ID="$(getc FORGEJO_OIDC_CLIENT_ID)"
FORGEJO_OIDC_CLIENT_SECRET="$(getc FORGEJO_OIDC_CLIENT_SECRET)"
export CODER_OIDC_CLIENT_ID="$(getc CODER_OIDC_CLIENT_ID)"
export CODER_OIDC_CLIENT_SECRET="$(getc CODER_OIDC_CLIENT_SECRET)"
[ -n "$FORGEJO_OIDC_CLIENT_ID" ] && [ -n "$CODER_OIDC_CLIENT_ID" ] || { echo "ERROR: client registration failed"; echo "$CLIENTS"; exit 1; }

# Recreate so Coder picks up the re-minted OIDC client, even when SKIP_APPS keeps Forgejo.
if [ "${SKIP_APPS:-}" != "1" ]; then
  log "Starting Forgejo and Coder"
  $COMPOSE up -d --force-recreate
else
  log "Restarting Coder with the re-minted OIDC client"
  $COMPOSE up -d
  $COMPOSE up -d --force-recreate --no-deps coder
fi
wait_for "$FORGEJO_BASE_URL/api/v1/version" 60 "Forgejo"
wait_for "$CODER_BASE_URL/healthz" 60 "Coder"

log "Bootstrapping Forgejo admin + Pawtograder login source"
FJ="$COMPOSE exec -T forgejo forgejo admin"
$FJ user create --username "$FORGEJO_ADMIN_USER" --password "$FORGEJO_ADMIN_PASSWORD" \
  --email admin@forgejo.e2e.test --admin --must-change-password=false >/dev/null 2>&1 || true
AUTH_ARGS=(--name "$FORGEJO_AUTH_SOURCE_NAME" --provider openidConnect
  --key "$FORGEJO_OIDC_CLIENT_ID" --secret "$FORGEJO_OIDC_CLIENT_SECRET"
  --auto-discover-url "$SB_ISSUER/.well-known/openid-configuration"
  --scopes email --scopes profile)
SOURCE_ID="$($FJ auth list | awk -v n="$FORGEJO_AUTH_SOURCE_NAME" '$2==n {print $1}')"
if [ -n "$SOURCE_ID" ]; then
  $FJ auth update-oauth --id "$SOURCE_ID" "${AUTH_ARGS[@]}"
else
  $FJ auth add-oauth "${AUTH_ARGS[@]}"
  SOURCE_ID="$($FJ auth list | awk -v n="$FORGEJO_AUTH_SOURCE_NAME" '$2==n {print $1}')"
fi
echo "  login source id=$SOURCE_ID"
# GoTrue requires PKCE, and Forgejo's first sign-in after a CLI-added source skips it; burn that request.
curl -fsS -o /dev/null "$FORGEJO_BASE_URL/user/oauth2/$FORGEJO_AUTH_SOURCE_NAME" || true

log "Bootstrapping Coder first owner"
curl -fsS -o /dev/null -X POST "$CODER_BASE_URL/api/v2/users/first" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$CODER_ADMIN_EMAIL\",\"username\":\"coder-admin\",\"name\":\"Coder Admin\",\"password\":\"$CODER_ADMIN_PASSWORD\",\"trial\":false}" \
  || echo "  (first owner already exists)"

if [ "${SKIP_TOOL:-}" != "1" ]; then
  if port_in_use "$PAW_PORT"; then
    echo "ERROR: port $PAW_PORT is in use. Stop whatever holds it or set PAW_PORT."; exit 1
  fi
  if [ "${SKIP_BUILD:-}" != "1" ]; then
    # NEXT_PUBLIC_* is inlined at build time, so build after exporting the lane's URLs.
    log "Building Pawtograder"
    npm run build >"$LOGS/build.log" 2>&1 || { tail -40 "$LOGS/build.log"; exit 1; }
  fi
  log "Starting Pawtograder on $PAW_BASE_URL"
  # Own process group, so cleanup also stops the next server npx spawns.
  set -m
  npx next start -H 127.0.0.1 -p "$PAW_PORT" >"$LOGS/next.log" 2>&1 &
  TOOL_PID=$!
  set +m
  wait_for "$PAW_BASE_URL/sign-in" 60 "Pawtograder" || { tail -40 "$LOGS/next.log"; exit 1; }
fi

log "Writing $OUT_JSON"
export PAW_BASE_URL FORGEJO_BASE_URL CODER_BASE_URL SB_ISSUER SOURCE_ID FORGEJO_OIDC_CLIENT_ID \
  FORGEJO_ADMIN_USER FORGEJO_ADMIN_PASSWORD CODER_ADMIN_EMAIL CODER_ADMIN_PASSWORD OUT_JSON
node -e '
const e = process.env;
const out = {
  pawtograderBaseUrl: e.PAW_BASE_URL,
  forgejoBaseUrl: e.FORGEJO_BASE_URL,
  coderBaseUrl: e.CODER_BASE_URL,
  issuer: e.SB_ISSUER,
  forgejo: { authSourceName: e.FORGEJO_AUTH_SOURCE_NAME, authSourceId: Number(e.SOURCE_ID),
             clientId: e.FORGEJO_OIDC_CLIENT_ID, admin: { username: e.FORGEJO_ADMIN_USER, password: e.FORGEJO_ADMIN_PASSWORD } },
  coder: { clientId: e.CODER_OIDC_CLIENT_ID, admin: { email: e.CODER_ADMIN_EMAIL, password: e.CODER_ADMIN_PASSWORD } }
};
require("fs").writeFileSync(e.OUT_JSON, JSON.stringify(out, null, 2));
'

if [ "${SKIP_TESTS:-}" != "1" ]; then
  log "Running Forgejo/Coder SSO Playwright suite"
  npx playwright test --config playwright.forgejo-coder.config.ts "$@"
fi
