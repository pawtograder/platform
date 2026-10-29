#!/usr/bin/env bash
# Usage: setup-sso-clients.sh --api-url URL --forgejo-url URL --coder-url URL (env: NAMESPACE, RELEASE, JWT_SECRET_NAME, FORGEJO_SOURCE_NAME, ROLLOUT_TIMEOUT)
# Run after deploying auth.oauthServer.enabled=true and before setting forgejo.gitea.oauth (Forgejo's init container needs the Secret).
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

# GoTrue only returns a client secret at creation, so each run registers a new client.
# The old ones are revoked only after the app has rolled out with the new one.
old_ids() { echo "$existing" | jq -r --arg n "$1" '(.clients // .)[] | select(.client_name == $n) | .client_id'; }
create_client() {
  gotrue -X POST "$auth/admin/oauth/clients" \
    -d "$(jq -n --arg n "$1" --arg r "$2" '{client_name: $n, redirect_uris: [$r], client_type: "confidential"}')"
}
revoke() { for id in $1; do gotrue -X DELETE -o /dev/null "$auth/admin/oauth/clients/$id"; done; }

apply_secret() {
  local name="$1"; shift
  local args=()
  for kv in "$@"; do args+=(--from-literal="$kv"); done
  kubectl -n "$NAMESPACE" create secret generic "$name" "${args[@]}" --dry-run=client -o yaml \
    | kubectl -n "$NAMESPACE" apply -f - >/dev/null
  echo "  wrote $NAMESPACE/$name"
}

restart() {
  kubectl -n "$NAMESPACE" get deploy "$1" >/dev/null 2>&1 || { echo "  no deploy/$1, not restarted"; return 0; }
  kubectl -n "$NAMESPACE" rollout restart "deploy/$1" >/dev/null
  kubectl -n "$NAMESPACE" rollout status "deploy/$1" --timeout="${ROLLOUT_TIMEOUT:-10m}" >/dev/null
  echo "  restarted $1"
}

echo "Registering Forgejo ($forgejo_url)"
fj_old="$(old_ids Forgejo)"
fj="$(create_client Forgejo "$forgejo_url/user/oauth2/$FORGEJO_SOURCE_NAME/callback")"
apply_secret "$RELEASE-forgejo-oauth" "key=$(echo "$fj" | jq -r .client_id)" "secret=$(echo "$fj" | jq -r .client_secret)"
restart "$RELEASE-forgejo"
revoke "$fj_old"

echo "Registering Coder ($coder_url)"
cd_old="$(old_ids Coder)"
cd_="$(create_client Coder "$coder_url/api/v2/users/oidc/callback")"
apply_secret "$RELEASE-coder-oidc" "CODER_OIDC_CLIENT_ID=$(echo "$cd_" | jq -r .client_id)" \
  "CODER_OIDC_CLIENT_SECRET=$(echo "$cd_" | jq -r .client_secret)"
restart coder
revoke "$cd_old"
