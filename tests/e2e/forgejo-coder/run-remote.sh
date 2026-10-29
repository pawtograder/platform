#!/usr/bin/env bash
# usage: run-remote.sh --namespace <ns> --app-url <url> --api-url <url> --forgejo-url <url> --coder-url <url> [playwright args]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
cd "$REPO"
NS="" APP="" API="" FJ="" CODER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --namespace) NS="$2"; shift 2 ;;
    --app-url) APP="${2%/}"; shift 2 ;;
    --api-url) API="${2%/}"; shift 2 ;;
    --forgejo-url) FJ="${2%/}"; shift 2 ;;
    --coder-url) CODER="${2%/}"; shift 2 ;;
    *) break ;;
  esac
done
[ -n "$NS" ] && [ -n "$APP" ] && [ -n "$API" ] && [ -n "$FJ" ] && [ -n "$CODER" ] || {
  grep '^#' "$0" | sed 's/^# \?//'; exit 2; }

secret() { kubectl -n "$NS" get secret "$1" -o jsonpath="{.data.$2}" | base64 -d; }

export SUPABASE_URL="$API" NEXT_PUBLIC_SUPABASE_URL="$API" PAW_BASE_URL="$APP" NEXT_PUBLIC_PAWTOGRADER_WEB_URL="$APP"
export SUPABASE_SERVICE_ROLE_KEY="$(secret pawtograder-jwt SERVICE_ROLE_KEY)"
export SUPABASE_ANON_KEY="$(secret pawtograder-jwt ANON_KEY)" NEXT_PUBLIC_SUPABASE_ANON_KEY="$(secret pawtograder-jwt ANON_KEY)"

SOURCE_ID="$(kubectl -n "$NS" exec deploy/pawtograder-forgejo -c forgejo -- forgejo admin auth list \
  | awk '$2=="pawtograder" {print $1}')"
[ -n "$SOURCE_ID" ] || { echo "no pawtograder login source in $NS Forgejo"; exit 1; }

jq -n --arg app "$APP" --arg fj "$FJ" --arg coder "$CODER" --arg iss "$API/auth/v1" --argjson sid "$SOURCE_ID" \
  --arg fjcid "$(secret pawtograder-forgejo-oauth key)" \
  --arg fju "$(secret pawtograder-forgejo-admin username)" --arg fjp "$(secret pawtograder-forgejo-admin password)" \
  --arg ccid "$(secret pawtograder-coder-oidc CODER_OIDC_CLIENT_ID)" \
  --arg ce "$(secret pawtograder-coder-admin email)" --arg cp "$(secret pawtograder-coder-admin password)" \
  '{pawtograderBaseUrl: $app, forgejoBaseUrl: $fj, coderBaseUrl: $coder, issuer: $iss,
    forgejo: {authSourceName: "pawtograder", authSourceId: $sid, clientId: $fjcid, admin: {username: $fju, password: $fjp}},
    coder: {clientId: $ccid, admin: {email: $ce, password: $cp}}}' > tests/e2e/sso/.forgejo-coder-e2e.json

npx playwright test --config playwright.forgejo-coder.config.ts "$@"
