#!/usr/bin/env bash
# Usage: setup-sso-clients.sh --api-url URL --forgejo-url URL --coder-url URL (env: NAMESPACE, RELEASE, JWT_SECRET_NAME, FORGEJO_SOURCE_NAME)
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

# GoTrue only returns a client secret at creation, so replace rather than reuse.
register() {
  local ids
  ids="$(echo "$existing" | jq -r --arg n "$1" '(.clients // .)[] | select(.client_name == $n) | .client_id')"
  for id in $ids; do gotrue -X DELETE -o /dev/null "$auth/admin/oauth/clients/$id"; done
  gotrue -X POST "$auth/admin/oauth/clients" \
    -d "$(jq -n --arg n "$1" --arg r "$2" '{client_name: $n, redirect_uris: [$r], client_type: "confidential"}')"
}

apply_secret() {
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
