#!/usr/bin/env bash
# Usage: setup-sso-clients.sh --api-url URL [--forgejo-url URL] [--coder-url URL] (env: NAMESPACE, RELEASE, JWT_SECRET_NAME, FORGEJO_SOURCE_NAME, ROLLOUT_TIMEOUT)
# Run after deploying auth.oauthServer.enabled=true and before setting forgejo.gitea.oauth (Forgejo's init container needs the Secret).
# Sets up only the apps whose URLs are given. Leave out the URL of an app the release doesn't install.
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
if [ -z "$api_url" ] || [ -z "$forgejo_url$coder_url" ]; then
  echo "need --api-url and at least one of --forgejo-url and --coder-url" >&2; exit 2
fi
for c in kubectl curl jq; do command -v "$c" >/dev/null || { echo "missing $c" >&2; exit 1; }; done

# Without its Deployment an app can't be restarted onto the new client and would keep the old secret,
# so check before anything in GoTrue or the cluster changes.
require_deploy() {
  kubectl -n "$NAMESPACE" get deploy "$1" >/dev/null || {
    echo "no deploy/$1 in $NAMESPACE; leave out $2 if the release doesn't install that app" >&2; exit 1; }
}
[ -z "$forgejo_url" ] || require_deploy "$RELEASE-forgejo" --forgejo-url
[ -z "$coder_url" ] || require_deploy coder --coder-url

service_key="$(kubectl -n "$NAMESPACE" get secret "$JWT_SECRET_NAME" -o jsonpath='{.data.SERVICE_ROLE_KEY}' | base64 -d)"
[ -n "$service_key" ] || { echo "no SERVICE_ROLE_KEY in $NAMESPACE/$JWT_SECRET_NAME" >&2; exit 1; }
auth="$api_url/auth/v1"
# Credentials go through builtins and pipes, never argv, so `ps` on a shared host can't read them.
gotrue() {
  curl -fsS -H @<(printf 'apikey: %s\nAuthorization: Bearer %s\n' "$service_key" "$service_key") \
    -H 'Content-Type: application/json' "$@"
}

curl -fsS -o /dev/null "$auth/.well-known/openid-configuration" || {
  echo "$auth/.well-known/openid-configuration is not reachable without an apikey." >&2
  echo "Deploy with auth.oauthServer.enabled=true first." >&2; exit 1; }

existing="$(gotrue "$auth/admin/oauth/clients?per_page=1000")"

# GoTrue returns a client secret only at creation, so register a new client and revoke old ones after rollout.
old_ids() { echo "$existing" | jq -r --arg n "$1" '(.clients // .)[] | select(.client_name == $n) | .client_id'; }
create_client() {
  gotrue -X POST "$auth/admin/oauth/clients" \
    -d "$(jq -n --arg n "$1" --arg r "$2" '{client_name: $n, redirect_uris: [$r], client_type: "confidential"}')"
}
revoke() { for id in $1; do gotrue -X DELETE -o /dev/null "$auth/admin/oauth/clients/$id"; done; }

apply_secret() {
  local name="$1"; shift
  local data="" kv
  for kv in "$@"; do
    data+="${data:+,}\"${kv%%=*}\":\"$(printf %s "${kv#*=}" | base64 | tr -d '\n')\""
  done
  printf '{"apiVersion":"v1","kind":"Secret","type":"Opaque","metadata":{"name":"%s"},"data":{%s}}' "$name" "$data" \
    | kubectl -n "$NAMESPACE" apply -f - >/dev/null
  echo "  wrote $NAMESPACE/$name"
}

restart() {
  kubectl -n "$NAMESPACE" rollout restart "deploy/$1" >/dev/null
  kubectl -n "$NAMESPACE" rollout status "deploy/$1" --timeout="${ROLLOUT_TIMEOUT:-10m}" >/dev/null
  echo "  restarted $1"
}

if [ -n "$forgejo_url" ]; then
  echo "Registering Forgejo ($forgejo_url)"
  fj_old="$(old_ids Forgejo)"
  fj="$(create_client Forgejo "$forgejo_url/user/oauth2/$FORGEJO_SOURCE_NAME/callback")"
  apply_secret "$RELEASE-forgejo-oauth" "key=$(echo "$fj" | jq -r .client_id)" "secret=$(echo "$fj" | jq -r .client_secret)"
  restart "$RELEASE-forgejo"
  revoke "$fj_old"
fi

if [ -n "$coder_url" ]; then
  echo "Registering Coder ($coder_url)"
  cd_old="$(old_ids Coder)"
  cd_="$(create_client Coder "$coder_url/api/v2/users/oidc/callback")"
  apply_secret "$RELEASE-coder-oidc" "CODER_OIDC_CLIENT_ID=$(echo "$cd_" | jq -r .client_id)" \
    "CODER_OIDC_CLIENT_SECRET=$(echo "$cd_" | jq -r .client_secret)"
  restart coder
  revoke "$cd_old"
fi
