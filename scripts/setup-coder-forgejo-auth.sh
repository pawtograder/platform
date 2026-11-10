#!/usr/bin/env bash
# Registers the Forgejo OAuth2 app that Coder uses as its external auth provider, and stores its
# client ID and secret in OpenBao for the chart's ExternalSecret (pawtograder-coder-external-auth).
# See charts/pawtograder/README.md, "Cloning private repositories".
set -euo pipefail

usage() {
  cat <<EOF
Usage: $0 --env <env> --forgejo-url <url> --coder-url <url> [--rotate] [--id <id>]
          [--bao-mount <mount>] [--prefix <path>]

  --env <env>          preview|staging|prod.
  --forgejo-url <url>  Forgejo's public URL, e.g. https://git.staging.pawtograder.net.
  --coder-url <url>    Coder's access URL, e.g. https://coder.staging.pawtograder.net.
  --rotate             Register a new app even though one is stored, switch Coder to it, then delete
                       the old one. Every user has to link Forgejo in Coder again.
  --id <id>            coder.externalAuth.forgejo.id (default: forgejo).
  --bao-mount <mount>  KV mount name (default: kv).
  --prefix <path>      Path within the mount (default: apps/pawtograder).

Reads the Forgejo admin from <prefix>/forgejo-<env> and writes client_id and client_secret to
<prefix>/coder-external-auth-<env>. When the release already has the ExternalSecret
(env: NAMESPACE, default pawtograder; RELEASE, default pawtograder), it also syncs it and restarts
Coder. Prints nothing secret.
EOF
}

ENV_NAME="" forgejo_url="" coder_url="" ROTATE=0 ID=forgejo BAO_MOUNT=kv PREFIX=apps/pawtograder
NAMESPACE="${NAMESPACE:-pawtograder}"
RELEASE="${RELEASE:-pawtograder}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)         ENV_NAME="${2:?--env requires a value}"; shift 2 ;;
    --forgejo-url) forgejo_url="${2:?--forgejo-url requires a value}"; forgejo_url="${forgejo_url%/}"; shift 2 ;;
    --coder-url)   coder_url="${2:?--coder-url requires a value}"; coder_url="${coder_url%/}"; shift 2 ;;
    --rotate)      ROTATE=1; shift ;;
    --id)          ID="${2:?--id requires a value}"; shift 2 ;;
    --bao-mount)   BAO_MOUNT="${2:?--bao-mount requires a value}"; shift 2 ;;
    --prefix)      PREFIX="${2:?--prefix requires a value}"; shift 2 ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
done
case "$ENV_NAME" in
  preview|staging|prod) ;;
  *) echo "ERROR: --env must be preview, staging or prod (got '${ENV_NAME}')" >&2; usage >&2; exit 2 ;;
esac
[ -n "$forgejo_url" ] && [ -n "$coder_url" ] || { usage >&2; exit 2; }
[[ "$ID" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || { echo "ERROR: --id must be lowercase letters, digits and single dashes" >&2; exit 2; }

CLI=""
if command -v bao >/dev/null 2>&1; then
  CLI=bao
elif command -v vault >/dev/null 2>&1; then
  CLI=vault
  : "${VAULT_ADDR:=${BAO_ADDR:-}}"
  : "${VAULT_TOKEN:=${BAO_TOKEN:-}}"
  export VAULT_ADDR VAULT_TOKEN
else
  echo "ERROR: neither 'bao' nor 'vault' found on PATH" >&2; exit 2
fi
for c in curl jq; do command -v "$c" >/dev/null || { echo "ERROR: '$c' is required" >&2; exit 2; }; done
# Check the token before registering: failing after it would orphan the new Forgejo app.
$CLI token lookup >/dev/null 2>&1 || {
  echo "ERROR: $CLI token lookup failed: set BAO_ADDR/BAO_TOKEN (or VAULT_*) and log in" >&2; exit 1; }

fj_path="$PREFIX/forgejo-$ENV_NAME"
auth_path="$PREFIX/coder-external-auth-$ENV_NAME"
callback="$coder_url/external-auth/$ID/callback"

# Returns 1 when the path doesn't exist, and exits on any other read error.
bao_get() {
  local out
  if out="$($CLI kv get -mount="$BAO_MOUNT" -format=json "$1" 2>&1)"; then
    printf '%s' "$out"
  elif grep -q 'No value found' <<<"$out"; then
    return 1
  else
    echo "ERROR: could not read ${BAO_MOUNT}/$1: $out" >&2; exit 1
  fi
}

fj_admin="$(bao_get "$fj_path")" || { echo "ERROR: no ${BAO_MOUNT}/${fj_path}; run setup-openbao-forgejo-coder.sh first" >&2; exit 1; }
FJ_USER="$(jq -r '.data.data.admin_username // empty' <<<"$fj_admin")"
FJ_PASS="$(jq -r '.data.data.admin_password // empty' <<<"$fj_admin")"
unset fj_admin
[ -n "$FJ_USER" ] && [ -n "$FJ_PASS" ] || { echo "ERROR: ${BAO_MOUNT}/${fj_path} has no admin_username/admin_password" >&2; exit 1; }

# Credentials go through a curl config on a pipe, never argv, so `ps` on a shared host can't read them.
forgejo() {
  local path="$1"; shift
  curl -fsS -K <(printf 'user = "%s:%s"\n' "$FJ_USER" "$FJ_PASS") \
    -H 'Content-Type: application/json' "$@" "$forgejo_url/api/v1$path"
}

apps="$(forgejo "/user/applications/oauth2?limit=50")" || {
  echo "ERROR: could not list $FJ_USER's OAuth2 apps at $forgejo_url; check --forgejo-url and the admin password" >&2; exit 1; }
# Apps a previous run registered for this Coder: same callback.
old_ids="$(jq -r --arg cb "$callback" '.[] | select((.redirect_uris // []) | index($cb)) | .id' <<<"$apps")"

stored_client=""
if stored="$(bao_get "$auth_path")"; then
  stored_client="$(jq -r '.data.data.client_id // empty' <<<"$stored")"
fi
unset stored
if [ -n "$stored_client" ] && [ "$ROTATE" -ne 1 ]; then
  if jq -e --arg id "$stored_client" 'any(.[]; .client_id == $id)' <<<"$apps" >/dev/null; then
    echo "${BAO_MOUNT}/${auth_path} holds a client that Forgejo still has; nothing to do. Pass --rotate to replace it."
    exit 0
  fi
  echo "ERROR: ${BAO_MOUNT}/${auth_path} names client $stored_client, which Forgejo doesn't have. Pass --rotate." >&2
  exit 1
fi

echo "Registering Coder ($callback) as an OAuth2 app of $FJ_USER on $forgejo_url"
created="$(forgejo /user/applications/oauth2 -X POST \
  -d "$(jq -n --arg n "Coder" --arg cb "$callback" '{name: $n, redirect_uris: [$cb], confidential_client: true}')")"
new_id="$(jq -r .id <<<"$created")"
CLIENT_ID="$(jq -r .client_id <<<"$created")"
CLIENT_SECRET="$(jq -r .client_secret <<<"$created")"
unset created
[ -n "$CLIENT_ID" ] && [ -n "$CLIENT_SECRET" ] && [ "$CLIENT_SECRET" != null ] || {
  echo "ERROR: Forgejo's response had no client secret; delete app $new_id by hand" >&2; exit 1; }

CAS=()
[ -n "$stored_client" ] || CAS=(-cas=0)
# The secret reaches jq through its environment, not argv.
if ! CS="$CLIENT_SECRET" jq -n --arg id "$CLIENT_ID" '{client_id: $id, client_secret: $ENV.CS}' \
  | $CLI kv put -mount="$BAO_MOUNT" ${CAS[@]+"${CAS[@]}"} "$auth_path" - >/dev/null; then
  echo "ERROR: could not write ${BAO_MOUNT}/${auth_path}; delete Forgejo app $new_id by hand and rerun" >&2
  exit 1
fi
unset CLIENT_SECRET
echo "  wrote ${BAO_MOUNT}/${auth_path} (client $CLIENT_ID)"

es="$RELEASE-coder-external-auth"
if command -v kubectl >/dev/null 2>&1 && kubectl -n "$NAMESPACE" get externalsecret "$es" >/dev/null 2>&1; then
  kubectl -n "$NAMESPACE" annotate externalsecret "$es" force-sync="$(date +%s)" --overwrite >/dev/null
  deadline=$(( $(date +%s) + 120 ))
  until [ "$(kubectl -n "$NAMESPACE" get secret "$es" -o jsonpath='{.data.CODER_EXTERNAL_AUTH_0_CLIENT_ID}' 2>/dev/null | base64 -d)" = "$CLIENT_ID" ]; do
    [ "$(date +%s)" -lt "$deadline" ] || { echo "ERROR: $NAMESPACE/$es didn't pick up the new client within 2m; check the ExternalSecret's status" >&2; exit 1; }
    sleep 3
  done
  echo "  synced $NAMESPACE/$es"
  kubectl -n "$NAMESPACE" rollout restart deploy/coder >/dev/null
  kubectl -n "$NAMESPACE" rollout status deploy/coder --timeout="${ROLLOUT_TIMEOUT:-10m}" >/dev/null
  echo "  restarted coder"
  failed=""
  for id in $old_ids; do
    if forgejo "/user/applications/oauth2/$id" -X DELETE -o /dev/null; then
      echo "  deleted old app $id"
    else
      echo "  could not delete old app $id; delete it in $FJ_USER's Applications settings" >&2; failed=1
    fi
  done
  [ -z "$failed" ] || exit 1
else
  {
    echo "No ExternalSecret $NAMESPACE/$es yet. Set these and deploy:"
    echo "  coder.externalAuth.forgejo.enabled: true"
    [ "$ID" = forgejo ] || echo "  coder.externalAuth.forgejo.id: $ID"
    echo "  forgejoCoderSecrets.externalSecret.coderExternalAuthPath: $auth_path"
    echo "then restart Coder: kubectl -n $NAMESPACE rollout restart deploy/coder"
    if [ -n "$old_ids" ]; then
      echo "Once Coder runs on client $CLIENT_ID, delete the old Forgejo app(s) $(echo $old_ids) in $FJ_USER's Applications settings."
    fi
  } >&2
fi
