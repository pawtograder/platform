#!/usr/bin/env bash
# Register Forgejo and Coder as OAuth 2.1 / OIDC clients of Pawtograder, so
# they can offer "Sign in with Pawtograder", and store their credentials in the
# Secrets the chart reads:
#
#   pawtograder-forgejo-oauth  key, secret                         (forgejo.gitea.oauth[].existingSecret)
#   pawtograder-coder-oidc     CODER_OIDC_CLIENT_ID, _CLIENT_SECRET (coder.coder.envFrom)
#
# Re-running replaces both clients (GoTrue only returns a secret at creation)
# and restarts Forgejo and Coder so they pick up the new credentials.
#
# Order on a release that doesn't have SSO yet:
#   1. Deploy with auth.oauthServer.enabled=true (and coder.oidc.enabled=true;
#      its Secret is optional).
#   2. Run this script.
#   3. Deploy with forgejo.gitea.oauth set. Forgejo's init container reads
#      pawtograder-forgejo-oauth, so it has to exist first.
#
# Usage:
#   scripts/setup-sso-clients.sh --api-url https://api.example.com \
#     --forgejo-url https://git.example.com --coder-url https://coder.example.com
#
# Env: NAMESPACE (default pawtograder), RELEASE (default pawtograder),
#      JWT_SECRET_NAME (default pawtograder-jwt), FORGEJO_SOURCE_NAME (default pawtograder).
# Requires: kubectl, curl, jq.
set -euo pipefail

NAMESPACE="${NAMESPACE:-pawtograder}"
RELEASE="${RELEASE:-pawtograder}"
JWT_SECRET_NAME="${JWT_SECRET_NAME:-pawtograder-jwt}"
FORGEJO_SOURCE_NAME="${FORGEJO_SOURCE_NAME:-pawtograder}"
api_url="" forgejo_url="" coder_url=""

while [ $# -gt 0 ]; do
  case "$1" in
    --api-url) api_url="${2%/}"; shift 2 ;;
    --forgejo-url) forgejo_url="${2%/}"; shift 2 ;;
    --coder-url) coder_url="${2%/}"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$api_url" ] && [ -n "$forgejo_url" ] && [ -n "$coder_url" ] || {
  echo "need --api-url, --forgejo-url and --coder-url" >&2; exit 2; }
for c in kubectl curl jq; do command -v "$c" >/dev/null || { echo "missing $c" >&2; exit 1; }; done

service_key="$(kubectl -n "$NAMESPACE" get secret "$JWT_SECRET_NAME" -o jsonpath='{.data.SERVICE_ROLE_KEY}' | base64 -d)"
[ -n "$service_key" ] || { echo "no SERVICE_ROLE_KEY in $NAMESPACE/$JWT_SECRET_NAME" >&2; exit 1; }
auth="$api_url/auth/v1"
gotrue() { curl -fsS -H "apikey: $service_key" -H "Authorization: Bearer $service_key" -H 'Content-Type: application/json' "$@"; }

curl -fsS -o /dev/null "$auth/.well-known/openid-configuration" || {
  echo "$auth/.well-known/openid-configuration is not reachable without an apikey." >&2
  echo "Deploy with auth.oauthServer.enabled=true first." >&2; exit 1; }

existing="$(gotrue "$auth/admin/oauth/clients?per_page=1000")"

# register <client_name> <redirect_uri>: prints the created client JSON
register() {
  local ids
  ids="$(echo "$existing" | jq -r --arg n "$1" '(.clients // .)[] | select(.client_name == $n) | .client_id')"
  for id in $ids; do gotrue -X DELETE -o /dev/null "$auth/admin/oauth/clients/$id"; done
  gotrue -X POST "$auth/admin/oauth/clients" \
    -d "$(jq -n --arg n "$1" --arg r "$2" '{client_name: $n, redirect_uris: [$r], client_type: "confidential"}')"
}

apply_secret() { # name key=value...
  local name="$1"; shift
  local args=()
  for kv in "$@"; do args+=(--from-literal="$kv"); done
  kubectl -n "$NAMESPACE" create secret generic "$name" "${args[@]}" --dry-run=client -o yaml \
    | kubectl -n "$NAMESPACE" apply -f - >/dev/null
  echo "  wrote $NAMESPACE/$name"
}

echo "Registering Forgejo ($forgejo_url)"
fj="$(register Forgejo "$forgejo_url/user/oauth2/$FORGEJO_SOURCE_NAME/callback")"
apply_secret "$RELEASE-forgejo-oauth" "key=$(echo "$fj" | jq -r .client_id)" "secret=$(echo "$fj" | jq -r .client_secret)"

echo "Registering Coder ($coder_url)"
cd_="$(register Coder "$coder_url/api/v2/users/oidc/callback")"
apply_secret "$RELEASE-coder-oidc" "CODER_OIDC_CLIENT_ID=$(echo "$cd_" | jq -r .client_id)" \
  "CODER_OIDC_CLIENT_SECRET=$(echo "$cd_" | jq -r .client_secret)"

for d in "$RELEASE-forgejo" coder; do
  if kubectl -n "$NAMESPACE" get deploy "$d" >/dev/null 2>&1; then
    kubectl -n "$NAMESPACE" rollout restart "deploy/$d" >/dev/null && echo "  restarted $d"
  fi
done
