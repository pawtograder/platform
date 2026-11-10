#!/usr/bin/env bash
# Usage: setup-sso-clients.sh --api-url URL [--forgejo-url URL] [--coder-url URL] (env: NAMESPACE, RELEASE, JWT_SECRET_NAME, FORGEJO_SOURCE_NAME, ROLLOUT_TIMEOUT, BAO_MOUNT, SYNC_TIMEOUT)
# Run after deploying auth.oauthServer.enabled=true and before setting forgejo.gitea.oauth (Forgejo's init container needs the Secret).
# Sets up only the apps whose URLs are given. Leave out the URL of an app the release doesn't install.
# When the chart renders an ExternalSecret for an app's Secret (forgejoCoderSecrets.externalSecret.forgejoOAuthPath
# or coderOIDCPath), the client goes to the OpenBao path it names (mount BAO_MOUNT, default kv) and ESO syncs it.
# That needs bao or vault logged in (BAO_ADDR/BAO_TOKEN). Otherwise the script writes the Secret with kubectl.
# The client names stay Forgejo and Coder: the access token hook finds Coder's client by that name and its callback.
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

# The OpenBao path of the ExternalSecret that owns a Secret, or nothing when ESO doesn't manage it.
# ESO would overwrite a Secret written with kubectl at its next refresh, so the path decides where the client goes,
# and any error reading the ExternalSecret stops the script instead of falling back to kubectl.
eso=""
eso_resources="$(kubectl api-resources --api-group=external-secrets.io -o name)"
! grep -q '^externalsecrets\.' <<<"$eso_resources" || eso=1
# set -e doesn't reach into $(...), so every kubectl here returns its failure explicitly.
bao_path() {
  [ -n "$eso" ] || return 0
  local es path
  es="$(kubectl -n "$NAMESPACE" get externalsecret "$1" --ignore-not-found -o name)" || return 1
  [ -n "$es" ] || return 0
  path="$(kubectl -n "$NAMESPACE" get externalsecret "$1" -o jsonpath='{.spec.data[0].remoteRef.key}')" || return 1
  [ -n "$path" ] || { echo "externalsecret/$1 has no remoteRef.key; can't tell where its client goes" >&2; return 1; }
  printf '%s' "$path"
}
# The KV mount is the ExternalSecret's store's, unless BAO_MOUNT says otherwise.
store_mount() {
  local kind name
  kind="$(kubectl -n "$NAMESPACE" get externalsecret "$1" -o jsonpath='{.spec.secretStoreRef.kind}')" || return 1
  name="$(kubectl -n "$NAMESPACE" get externalsecret "$1" -o jsonpath='{.spec.secretStoreRef.name}')" || return 1
  if [ "$kind" = ClusterSecretStore ]; then
    kubectl get clustersecretstore "$name" -o jsonpath='{.spec.provider.vault.path}'
  else
    kubectl -n "$NAMESPACE" get secretstore "$name" -o jsonpath='{.spec.provider.vault.path}'
  fi || { echo "can't read the store of externalsecret/$1; set BAO_MOUNT to its KV mount" >&2; return 1; }
}
fj_bao="" cd_bao=""
if [ -n "$forgejo_url" ]; then fj_bao="$(bao_path "$RELEASE-forgejo-oauth")"; fi
if [ -n "$coder_url" ]; then cd_bao="$(bao_path "$RELEASE-coder-oidc")"; fi
CLI=""
if [ -n "$fj_bao$cd_bao" ]; then
  if [ -z "${BAO_MOUNT:-}" ]; then
    BAO_MOUNT="$(store_mount "$RELEASE-$([ -n "$fj_bao" ] && echo forgejo-oauth || echo coder-oidc)")"
    [ -n "$BAO_MOUNT" ] || { echo "the ExternalSecret's store names no vault path; set BAO_MOUNT" >&2; exit 1; }
  fi
  if command -v bao >/dev/null; then CLI=bao
  elif command -v vault >/dev/null; then
    CLI=vault
    : "${VAULT_ADDR:=${BAO_ADDR:-}}"; : "${VAULT_TOKEN:=${BAO_TOKEN:-}}"; export VAULT_ADDR VAULT_TOKEN
  else echo "ExternalSecrets manage the client Secrets, so this needs bao or vault on PATH" >&2; exit 1; fi
  # status passes without a token, so check the token too, before any client is registered.
  $CLI token lookup >/dev/null 2>&1 || {
    echo "$CLI token lookup failed; set BAO_ADDR/BAO_TOKEN (or VAULT_*) and log in" >&2; exit 1; }
fi

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
# Another release or app on this GoTrue may have a client with the same name, so a client counts as this
# release's only if it sends sign-ins to this release's callback (which also catches clients left by a run
# that stopped before revoking), or if it is the client ID in this release's Secret (which catches a changed URL).
secret_value() {
  kubectl -n "$NAMESPACE" get secret "$1" -o "jsonpath={.data.$2}" 2>/dev/null | base64 -d || true
}
old_ids() {
  echo "$existing" | jq -r --arg n "$1" --arg r "$2" --arg cur "$3" \
    '(if type == "array" then . else .clients end)[] | select((.client_name == $n and ((.redirect_uris // []) | index($r))) or (.client_id == $cur and $cur != "")) | .client_id'
}
create_client() {
  gotrue -X POST "$auth/admin/oauth/clients" \
    -d "$(jq -n --arg n "$1" --arg r "$2" '{client_name: $n, redirect_uris: [$r], client_type: "confidential"}')"
}
# A failed revoke leaves an unused client behind, which shouldn't stop the other app's setup.
# Keep going, and exit non-zero at the end. A 404 means the client is already gone.
revoke_failed=""
revoke() {
  local id code
  for id in $1; do
    code="$(gotrue -X DELETE -o /dev/null -w '%{http_code}' "$auth/admin/oauth/clients/$id" 2>/dev/null || true)"
    case "$code" in
      2??|404) echo "  revoked old client $id" ;;
      *) echo "  could not revoke old client $id (HTTP ${code:-none}); delete it by hand" >&2
         revoke_failed=1 ;;
    esac
  done
}

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

# store_client SECRET BAO_PATH ID_KEY SECRET_KEY CLIENT_JSON: put the client in the app's Secret, through OpenBao when
# BAO_PATH is set. ESO refreshes hourly, so force a sync and wait until the Secret holds the new client ID; restarting
# the app before that would load the old client.
store_client() {
  local name="$1" path="$2" id_key="$3" secret_key="$4" client="$5" id deadline
  id="$(echo "$client" | jq -r .client_id)"
  if [ -z "$path" ]; then
    apply_secret "$name" "$id_key=$id" "$secret_key=$(echo "$client" | jq -r .client_secret)"
    return
  fi
  echo "$client" | jq '{client_id, client_secret}' | $CLI kv put -mount="$BAO_MOUNT" "$path" - >/dev/null
  echo "  wrote $BAO_MOUNT/$path"
  kubectl -n "$NAMESPACE" annotate externalsecret "$name" "force-sync=$(date +%s)" --overwrite >/dev/null
  deadline=$(( $(date +%s) + ${SYNC_TIMEOUT:-120} ))
  until [ "$(secret_value "$name" "$id_key")" = "$id" ]; do
    [ "$(date +%s)" -lt "$deadline" ] || {
      echo "  $NAMESPACE/$name didn't get the new client within ${SYNC_TIMEOUT:-120}s; check: kubectl -n $NAMESPACE describe externalsecret $name" >&2
      exit 1; }
    sleep 2
  done
  echo "  ESO synced $NAMESPACE/$name"
}

restart() {
  kubectl -n "$NAMESPACE" rollout restart "deploy/$1" >/dev/null
  kubectl -n "$NAMESPACE" rollout status "deploy/$1" --timeout="${ROLLOUT_TIMEOUT:-10m}" >/dev/null
  echo "  restarted $1"
}

if [ -n "$forgejo_url" ]; then
  echo "Registering Forgejo ($forgejo_url)"
  fj_cb="$forgejo_url/user/oauth2/$FORGEJO_SOURCE_NAME/callback"
  fj_old="$(old_ids Forgejo "$fj_cb" "$(secret_value "$RELEASE-forgejo-oauth" key)")"
  fj="$(create_client Forgejo "$fj_cb")"
  store_client "$RELEASE-forgejo-oauth" "$fj_bao" key secret "$fj"
  restart "$RELEASE-forgejo"
  revoke "$fj_old"
fi

if [ -n "$coder_url" ]; then
  echo "Registering Coder ($coder_url)"
  cd_cb="$coder_url/api/v2/users/oidc/callback"
  cd_old="$(old_ids Coder "$cd_cb" "$(secret_value "$RELEASE-coder-oidc" CODER_OIDC_CLIENT_ID)")"
  cd_="$(create_client Coder "$cd_cb")"
  store_client "$RELEASE-coder-oidc" "$cd_bao" CODER_OIDC_CLIENT_ID CODER_OIDC_CLIENT_SECRET "$cd_"
  restart coder
  revoke "$cd_old"
fi

if [ -n "$revoke_failed" ]; then
  echo "Both apps use their new clients, but some old clients are still registered; see above." >&2
  exit 1
fi
