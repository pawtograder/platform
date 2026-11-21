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
export FUNCTIONS_PORT="${FUNCTIONS_PORT:-3150}"
PAW_BASE_URL="http://127.0.0.1:${PAW_PORT}"
FORGEJO_BASE_URL="http://127.0.0.1:${FORGEJO_PORT}"
CODER_BASE_URL="http://127.0.0.1:${CODER_PORT}"
FUNCTIONS_BASE_URL="http://127.0.0.1:${FUNCTIONS_PORT}"
# The lane's GitHub: the same Forgejo under another origin (docker-compose.yml, CODER_EXTERNAL_AUTH_0_*).
GITHUB_STANDIN_URL="http://localhost:${FORGEJO_PORT}"
export FORGEJO_AUTH_SOURCE_NAME=pawtograder
# The suite's fake job token carries this as its kid (TestingUtils, the journey spec), and the functions container
# accepts only a token whose kid matches it (docker-compose.yml). Exported before Playwright runs, so a different
# value in .env.local can't split the two: dotenv doesn't override a set variable.
export END_TO_END_SECRET="${END_TO_END_SECRET:-not-a-secret}"
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
    for s in forgejo coder functions workspace; do $COMPOSE logs --no-color "$s" >"$LOGS/$s.log" 2>&1 || true; done
    rm -rf "$LOGS/agents"
    $COMPOSE cp workspace:/agents "$LOGS/agents" >/dev/null 2>&1 || true
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
# Migrations only create audit partitions for a fixed window; a retained stack can be past it.
docker exec supabase_db_pawtograder-sso-e2e psql -U postgres -d postgres -qc "SELECT public.audit_maintain_partitions();" >/dev/null
WANT_MIGRATIONS="$(ls "$REPO/supabase/migrations" | grep '\.sql$' | cut -d_ -f1 | sort)"
HAVE_MIGRATIONS="$(docker exec supabase_db_pawtograder-sso-e2e psql -U postgres -d postgres -tAc "SELECT version FROM supabase_migrations.schema_migrations ORDER BY 1")"
if [ "$HAVE_MIGRATIONS" != "$WANT_MIGRATIONS" ]; then
  echo "ERROR: the retained Supabase's migrations differ from the checkout's. Re-run without SKIP_SUPABASE/ONLY."; exit 1
fi
# TestingUtils falls back to .env.local, which would seed the developer's own database.
[ "${ONLY:-}" = "1" ] && exec npx playwright test --config playwright.forgejo-coder.config.ts "$@"

log "Registering Forgejo and Coder as OAuth clients"
export THIRD_PARTY_REDIRECT_URI="http://127.0.0.1:3399/callback"
CLIENTS="$(FORGEJO_BASE_URL="$FORGEJO_BASE_URL" CODER_BASE_URL="$CODER_BASE_URL" npx tsx tests/e2e/sso/register-oauth-clients.ts)"
getc() { echo "$CLIENTS" | grep -E "^$1=" | head -1 | cut -d= -f2-; }
FORGEJO_OIDC_CLIENT_ID="$(getc FORGEJO_OIDC_CLIENT_ID)"
FORGEJO_OIDC_CLIENT_SECRET="$(getc FORGEJO_OIDC_CLIENT_SECRET)"
export CODER_OIDC_CLIENT_ID="$(getc CODER_OIDC_CLIENT_ID)"
export CODER_OIDC_CLIENT_SECRET="$(getc CODER_OIDC_CLIENT_SECRET)"
export THIRD_OIDC_CLIENT_ID="$(getc THIRD_OIDC_CLIENT_ID)"
[ -n "$FORGEJO_OIDC_CLIENT_ID" ] && [ -n "$CODER_OIDC_CLIENT_ID" ] && [ -n "$THIRD_OIDC_CLIENT_ID" ] || { echo "ERROR: client registration failed"; echo "$CLIENTS"; exit 1; }
# With SKIP_TOOL=1, start Next with the same OAUTH_FIRST_PARTY_REDIRECT_URIS yourself.
export AUTO_APPROVE="${AUTO_APPROVE:-1}"
if [ "$AUTO_APPROVE" = "1" ]; then
  export OAUTH_FIRST_PARTY_REDIRECT_URIS="$FORGEJO_BASE_URL/user/oauth2/$FORGEJO_AUTH_SOURCE_NAME/callback,$CODER_BASE_URL/api/v2/users/oidc/callback"
else
  unset OAUTH_FIRST_PARTY_REDIRECT_URIS
fi

# Coder starts once Forgejo has the OAuth app that plays GitHub's (below). The workspace container always
# starts fresh: its agents share one home, which must not carry a previous run's git config.
if [ "${SKIP_APPS:-}" != "1" ]; then
  log "Starting Forgejo"
  $COMPOSE up -d --force-recreate loopback forgejo coder-db agents-init workspace
else
  $COMPOSE up -d loopback forgejo coder-db
  $COMPOSE up -d --force-recreate agents-init workspace
fi
wait_for "$FORGEJO_BASE_URL/api/v1/version" 60 "Forgejo"

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
  # A running Forgejo keeps the provider it loaded at start, with the deleted client ID.
  $COMPOSE restart forgejo >/dev/null
  wait_for "$FORGEJO_BASE_URL/api/v1/version" 60 "Forgejo"
else
  $FJ auth add-oauth "${AUTH_ARGS[@]}"
  SOURCE_ID="$($FJ auth list | awk -v n="$FORGEJO_AUTH_SOURCE_NAME" '$2==n {print $1}')"
fi
echo "  login source id=$SOURCE_ID"
# Forgejo reads templates at startup.
$COMPOSE exec -T forgejo sh -c 'mkdir -p "$GITEA_CUSTOM/templates/custom" && cp /pawtograder-templates/header.tmpl "$GITEA_CUSTOM/templates/custom/header.tmpl"'
$COMPOSE restart forgejo >/dev/null
wait_for "$FORGEJO_BASE_URL/api/v1/version" 60 "Forgejo"
# GoTrue requires PKCE, and Forgejo's first sign-in after a CLI-added source skips it; burn that request.
curl -fsS -o /dev/null "$FORGEJO_BASE_URL/user/oauth2/$FORGEJO_AUTH_SOURCE_NAME" || true

log "Creating the Forgejo OAuth app that plays GitHub's for Coder"
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(process.argv[1].split(".").reduce((o,k)=>o?.[k],v)??"")})' "$1"; }
STANDIN_APP="$(curl -fsS -X POST "$FORGEJO_BASE_URL/api/v1/user/applications/oauth2" \
  -u "$FORGEJO_ADMIN_USER:$FORGEJO_ADMIN_PASSWORD" -H 'Content-Type: application/json' \
  -d "{\"name\":\"coder-github-standin-$(date +%s)\",\"confidential_client\":true,\"redirect_uris\":[\"$CODER_BASE_URL/external-auth/github/callback\"]}")"
export GITHUB_STANDIN_CLIENT_ID="$(echo "$STANDIN_APP" | json client_id)"
export GITHUB_STANDIN_CLIENT_SECRET="$(echo "$STANDIN_APP" | json client_secret)"
[ -n "$GITHUB_STANDIN_CLIENT_ID" ] || { echo "ERROR: no OAuth app: $STANDIN_APP"; exit 1; }

log "Starting Coder"
$COMPOSE up -d --force-recreate --no-deps coder
wait_for "$CODER_BASE_URL/healthz" 60 "Coder"

log "Bootstrapping Coder first owner"
curl -fsS -o /dev/null -X POST "$CODER_BASE_URL/api/v2/users/first" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$CODER_ADMIN_EMAIL\",\"username\":\"coder-admin\",\"name\":\"Coder Admin\",\"password\":\"$CODER_ADMIN_PASSWORD\",\"trial\":false}" \
  || echo "  (first owner already exists)"

log "Pushing the lane's kubernetes template and minting workspace-open's Coder token"
CODER_SESSION="$(curl -fsS -X POST "$CODER_BASE_URL/api/v2/users/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$CODER_ADMIN_EMAIL\",\"password\":\"$CODER_ADMIN_PASSWORD\"}" | json session_token)"
[ -n "$CODER_SESSION" ] || { echo "ERROR: Coder admin login failed"; exit 1; }
$COMPOSE exec -T -e CODER_URL="$CODER_BASE_URL" -e CODER_SESSION_TOKEN="$CODER_SESSION" coder \
  /opt/coder templates push kubernetes --directory /pawtograder-template --yes \
  --variable "forgejo_url=$FORGEJO_BASE_URL" --variable "github_url=$GITHUB_STANDIN_URL" \
  --variable github_external_auth_id=github --variable "arch=${WORKSPACE_ARCH:-amd64}"
# 24h; CODER_API_TOKEN belongs to an owner, as in the chart.
export CODER_API_TOKEN="$(curl -fsS -X POST "$CODER_BASE_URL/api/v2/users/me/keys/tokens" \
  -H "Coder-Session-Token: $CODER_SESSION" -H 'Content-Type: application/json' \
  -d "{\"token_name\":\"pawtograder-e2e-$(date +%s)\",\"lifetime\":86400000000000}" | json key)"
[ -n "$CODER_API_TOKEN" ] || { echo "ERROR: couldn't mint a Coder API token"; exit 1; }

log "Starting the edge functions the cloud workspaces journey reaches"
export FORGEJO_ADMIN_USER FORGEJO_ADMIN_PASSWORD SOURCE_ID
export FORGEJO_WEBHOOK_SECRET="forgejo-e2e-webhook-secret"
E2E_KEY="$(openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null)"
export E2E_GITHUB_PRIVATE_KEY_STRING="$(printf '%s\n' "$E2E_KEY" | awk 'BEGIN{ORS=""} {printf "%s\\n", $0}')"
$COMPOSE up -d --force-recreate --no-deps functions
wait_for "$FUNCTIONS_BASE_URL/health" 90 "Edge functions" || { $COMPOSE logs --no-color --tail 60 functions; exit 1; }

if [ "${SKIP_TOOL:-}" != "1" ]; then
  if port_in_use "$PAW_PORT"; then
    echo "ERROR: port $PAW_PORT is in use. Stop whatever holds it or set PAW_PORT."; exit 1
  fi
  export NEXT_DIST_DIR=.next-sso-e2e
  BUILD_STAMP="$REPO/$NEXT_DIST_DIR/.sso-e2e-public-env"
  PUBLIC_ENV="$(NODE_ENV=production node -e '
    const { combinedEnv } = require("@next/env").loadEnvConfig(process.cwd(), false);
    const keys = Object.keys(combinedEnv).filter((k) => k.startsWith("NEXT_PUBLIC_")).sort();
    process.stdout.write(keys.map((k) => `${k}=${combinedEnv[k]}`).join("\n"));
  ')"
  if [ "${SKIP_BUILD:-}" != "1" ] || [ "$(cat "$BUILD_STAMP" 2>/dev/null)" != "$PUBLIC_ENV" ]; then
    log "Building Pawtograder"
    rm -rf "${REPO:?}/$NEXT_DIST_DIR"
    npm run build >"$LOGS/build.log" 2>&1 || { tail -40 "$LOGS/build.log"; exit 1; }
    echo "$PUBLIC_ENV" >"$BUILD_STAMP"
  fi
  log "Starting Pawtograder on $PAW_BASE_URL"
  # Opens /api/e2e/revalidate-course, which stands in for the classes cache webhook (TestingUtils.revalidateCourseCache).
  export E2E_ENABLE=true
  # Own process group, so cleanup also stops the next server npx spawns.
  set -m
  npx next start -H 127.0.0.1 -p "$PAW_PORT" >"$LOGS/next.log" 2>&1 &
  TOOL_PID=$!
  set +m
  wait_for "$PAW_BASE_URL/sign-in" 60 "Pawtograder" || { tail -40 "$LOGS/next.log"; exit 1; }
fi

log "Writing $OUT_JSON"
export PAW_BASE_URL FORGEJO_BASE_URL CODER_BASE_URL SB_ISSUER SOURCE_ID FORGEJO_OIDC_CLIENT_ID \
  FORGEJO_ADMIN_USER FORGEJO_ADMIN_PASSWORD CODER_ADMIN_EMAIL CODER_ADMIN_PASSWORD OUT_JSON \
  FUNCTIONS_BASE_URL GITHUB_STANDIN_URL
node -e '
const e = process.env;
const out = {
  pawtograderBaseUrl: e.PAW_BASE_URL,
  forgejoBaseUrl: e.FORGEJO_BASE_URL,
  coderBaseUrl: e.CODER_BASE_URL,
  issuer: e.SB_ISSUER,
  forgejo: { authSourceName: e.FORGEJO_AUTH_SOURCE_NAME, authSourceId: Number(e.SOURCE_ID),
             clientId: e.FORGEJO_OIDC_CLIENT_ID, admin: { username: e.FORGEJO_ADMIN_USER, password: e.FORGEJO_ADMIN_PASSWORD } },
  coder: { clientId: e.CODER_OIDC_CLIENT_ID, admin: { email: e.CODER_ADMIN_EMAIL, password: e.CODER_ADMIN_PASSWORD } },
  autoApproveForgejo: e.AUTO_APPROVE === "1",
  autoApproveCoder: e.AUTO_APPROVE === "1",
  forgejoLoginRedirect: true,
  thirdParty: { clientId: e.THIRD_OIDC_CLIENT_ID, redirectUri: e.THIRD_PARTY_REDIRECT_URI },
  // cloud-workspaces-journey.forgejo-coder.spec.ts; run-remote.sh writes none, and the journey skips.
  journey: {
    functionsBaseUrl: e.FUNCTIONS_BASE_URL,
    githubStandinUrl: e.GITHUB_STANDIN_URL,
    composeFile: require("path").join(process.cwd(), "tests/e2e/forgejo-coder/docker-compose.yml"),
    webhookSecret: e.FORGEJO_WEBHOOK_SECRET
  }
};
require("fs").writeFileSync(e.OUT_JSON, JSON.stringify(out, null, 2));
'

if [ "${SKIP_TESTS:-}" != "1" ]; then
  log "Running Forgejo/Coder SSO Playwright suite"
  npx playwright test --config playwright.forgejo-coder.config.ts "$@"
fi
