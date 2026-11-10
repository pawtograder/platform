#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $0 --env <env> --forgejo-url <url> [--namespace <ns>] [--bot <username>] [--bot-email <email>]
          [--rotate] [--revoke-old] [--bao-mount <mount>] [--prefix <path>]

Creates (or resets) a Forgejo site-admin bot, mints the two Actions tokens for it, and writes them to
<mount>/<prefix>/forgejo-runner-<env> as dispatcher_token (write:admin, for forgejoRunner.dispatcher) and
mirror_token (write:organization + write:repository, for the action mirror hook), plus bot_username.
Point the chart at the path with forgejoCoderSecrets.externalSecret.runnerPath.

  --env <env>            preview|staging|prod.
  --forgejo-url <url>    Forgejo's public URL, e.g. https://git.staging.pawtograder.net.
  --namespace <ns>       Release namespace holding <release>-forgejo-admin (default: pawtograder-<env>).
  --bot <username>       Bot account (default: forgejo-actions-bot). Must not be the chart admin.
  --bot-email <email>    Bot email (default: <bot>@noreply.<forgejo host>).
  --rotate               Overwrite an existing path with new tokens (CAS on the current version).
                         Old tokens stay valid until --revoke-old, so running pods keep working
                         until ESO syncs and they restart.
  --revoke-old           With --rotate, or alone after a rotation has synced: delete the bot's
                         tokens named actions-dispatcher-* / action-mirrors-* except the ones in Bao.
  --bao-mount <mount>    KV mount name (default: kv).
  --prefix <path>        Path within the mount (default: apps/pawtograder).

Env: RELEASE (pawtograder). Uses the chart admin's username/password from <release>-forgejo-admin
in the cluster, sent to Forgejo through a curl config on a pipe. The bot's password is random,
used only to mint its tokens, and never stored or printed. Prints nothing secret.
EOF
}

ENV_NAME="" FORGEJO_URL="" NAMESPACE="" BOT="forgejo-actions-bot" BOT_EMAIL=""
ROTATE=0 REVOKE_OLD=0 BAO_MOUNT="kv" PREFIX="apps/pawtograder"
RELEASE="${RELEASE:-pawtograder}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)          ENV_NAME="${2:?--env requires a value}"; shift 2 ;;
    --forgejo-url)  FORGEJO_URL="${2:?--forgejo-url requires a value}"; FORGEJO_URL="${FORGEJO_URL%/}"; shift 2 ;;
    --namespace)    NAMESPACE="${2:?--namespace requires a value}"; shift 2 ;;
    --bot)          BOT="${2:?--bot requires a value}"; shift 2 ;;
    --bot-email)    BOT_EMAIL="${2:?--bot-email requires a value}"; shift 2 ;;
    --rotate)       ROTATE=1; shift ;;
    --revoke-old)   REVOKE_OLD=1; shift ;;
    --bao-mount)    BAO_MOUNT="${2:?--bao-mount requires a value}"; shift 2 ;;
    --prefix)       PREFIX="${2:?--prefix requires a value}"; shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
done
case "$ENV_NAME" in
  preview|staging|prod) ;;
  *) echo "ERROR: --env must be preview, staging or prod (got '${ENV_NAME}')" >&2; usage >&2; exit 2 ;;
esac
[[ "$FORGEJO_URL" =~ ^https?://[^/]+$ ]] || { echo "ERROR: --forgejo-url must be a bare http(s) origin (got '${FORGEJO_URL}')" >&2; exit 2; }
[[ "$BOT" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || { echo "ERROR: --bot '$BOT' isn't a Forgejo username" >&2; exit 2; }
NAMESPACE="${NAMESPACE:-pawtograder-$ENV_NAME}"
BOT_EMAIL="${BOT_EMAIL:-$BOT@noreply.${FORGEJO_URL#*://}}"
BAO_PATH="$PREFIX/forgejo-runner-$ENV_NAME"

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
for c in jq openssl curl kubectl base64; do
  command -v "$c" >/dev/null 2>&1 || { echo "ERROR: '$c' is required" >&2; exit 2; }
done
$CLI status >/dev/null 2>&1 || {
  echo "ERROR: $CLI status failed — set BAO_ADDR/BAO_TOKEN (or VAULT_*) and log in" >&2; exit 1; }

# Does the path exist, and at which version (for CAS)?
current_version=0
if meta="$($CLI kv metadata get -mount="$BAO_MOUNT" -format=json "$BAO_PATH" 2>/dev/null)"; then
  current_version="$(jq -r '.data.current_version // 0' <<<"$meta")"
  deleted="$(jq -r --arg v "$current_version" '.data.versions[$v].deletion_time // ""' <<<"$meta")"
  [ -z "$deleted" ] || current_version_deleted=1
fi
if [ "$current_version" != 0 ] && [ -z "${current_version_deleted:-}" ] && [ "$ROTATE" -ne 1 ] && [ "$REVOKE_OLD" -ne 1 ]; then
  echo "ERROR: ${BAO_MOUNT}/${BAO_PATH} already exists. Pass --rotate to mint new tokens." >&2; exit 1
fi

# Chart admin credentials, from the cluster into variables only.
secret_key() { kubectl -n "$NAMESPACE" get secret "$RELEASE-forgejo-admin" -o "jsonpath={.data.$1}" | base64 -d; }
ADMIN_USER="$(secret_key username)"
ADMIN_PW="$(secret_key password)"
[ -n "$ADMIN_USER" ] && [ -n "$ADMIN_PW" ] || { echo "ERROR: $NAMESPACE/$RELEASE-forgejo-admin lacks username/password" >&2; exit 1; }
[ "$ADMIN_USER" != "$BOT" ] || { echo "ERROR: --bot must not be the chart admin" >&2; exit 2; }
for v in "$ADMIN_USER" "$ADMIN_PW"; do
  [[ "$v" != *[\"\\[:cntrl:]]* ]] || { echo "ERROR: admin credentials contain characters a curl config can't carry" >&2; exit 1; }
done

API="$FORGEJO_URL/api/v1"
# curl with basic auth from a config on a pipe, so neither user nor password is in argv.
as() {  # as <user> <password> curl-args...
  local u="$1" p="$2"; shift 2
  curl -fsS --max-time 30 --config <(printf 'user = "%s:%s"\n' "$u" "$p") -H 'Content-Type: application/json' "$@"
}
admin() { as "$ADMIN_USER" "$ADMIN_PW" "$@"; }

admin -o /dev/null "$API/user" || { echo "ERROR: the chart admin can't authenticate to $API" >&2; exit 1; }

list_tokens() {  # bot token names matching our prefixes
  bot "$API/users/$BOT/tokens?limit=50" | jq -r '.[].name | select(test("^(actions-dispatcher|action-mirrors)-"))'
}

if [ "$REVOKE_OLD" -eq 1 ] && [ "$ROTATE" -ne 1 ]; then
  [ "$current_version" != 0 ] || { echo "ERROR: nothing at ${BAO_MOUNT}/${BAO_PATH}" >&2; exit 1; }
fi

# Bot password: alphanumeric, used only in this run to mint tokens (Forgejo needs basic auth for that).
BOT_PW="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-32)"
[[ "$BOT_PW" =~ ^[A-Za-z0-9]{32}$ ]] || { echo "ERROR: password generation failed" >&2; exit 1; }
bot() { as "$BOT" "$BOT_PW" "$@"; }

code="$(admin -o /dev/null -w '%{http_code}' "$API/users/$BOT" 2>/dev/null || true)"
case "$code" in
  200)
    echo "Resetting $BOT's password (site admin, no forced change)"
    PW="$BOT_PW" jq -n --arg u "$BOT" '{login_name: $u, source_id: 0, password: $ENV.PW, must_change_password: false, admin: true, active: true}' \
      | admin -o /dev/null -X PATCH --data-binary @- "$API/admin/users/$BOT" ;;
  404)
    echo "Creating site-admin bot $BOT"
    PW="$BOT_PW" jq -n --arg u "$BOT" --arg e "$BOT_EMAIL" \
      '{username: $u, email: $e, password: $ENV.PW, must_change_password: false, send_notify: false, visibility: "private"}' \
      | admin -o /dev/null -X POST --data-binary @- "$API/admin/users"
    # write:admin only works for a site admin, and POST /admin/users can't set admin.
    PW="$BOT_PW" jq -n --arg u "$BOT" '{login_name: $u, source_id: 0, admin: true, must_change_password: false}' \
      | admin -o /dev/null -X PATCH --data-binary @- "$API/admin/users/$BOT" ;;
  *) echo "ERROR: GET $API/users/$BOT returned ${code:-no response}" >&2; exit 1 ;;
esac
[ "$(admin "$API/users/$BOT" | jq -r .is_admin)" = true ] || { echo "ERROR: $BOT isn't a site admin" >&2; exit 1; }

if [ "$ROTATE" -eq 1 ] || [ "$current_version" = 0 ] || [ -n "${current_version_deleted:-}" ]; then
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  mint() {  # mint <name> <scope,...>  -> token on stdout (captured, never printed)
    jq -n --arg n "$1" --arg s "$2" '{name: $n, scopes: ($s | split(","))}' \
      | bot -X POST --data-binary @- "$API/users/$BOT/tokens" | jq -r '.sha1 // empty'
  }
  # Delete whatever this run minted, so a partial failure leaves no live token behind.
  drop_new() {
    bot -o /dev/null -X DELETE "$API/users/$BOT/tokens/actions-dispatcher-$stamp" 2>/dev/null || true
    bot -o /dev/null -X DELETE "$API/users/$BOT/tokens/action-mirrors-$stamp" 2>/dev/null || true
  }
  DISPATCHER_TOKEN="$(mint "actions-dispatcher-$stamp" write:admin || true)"
  [ ${#DISPATCHER_TOKEN} -ge 40 ] || { echo "ERROR: Forgejo returned no dispatcher token" >&2; drop_new; exit 1; }
  MIRROR_TOKEN="$(mint "action-mirrors-$stamp" write:organization,write:repository || true)"
  [ ${#MIRROR_TOKEN} -ge 40 ] || { echo "ERROR: Forgejo returned no mirror token; deleted the new dispatcher token" >&2; drop_new; exit 1; }

  CAS=(-cas="$current_version")
  [ -z "${current_version_deleted:-}" ] || CAS=()
  # Tokens reach jq through its environment, not argv, so `ps` can't show them.
  if ! T_D="$DISPATCHER_TOKEN" T_M="$MIRROR_TOKEN" jq -n --arg u "$BOT" \
      --arg nd "actions-dispatcher-$stamp" --arg nm "action-mirrors-$stamp" \
      '{bot_username: $u, dispatcher_token: $ENV.T_D, mirror_token: $ENV.T_M, dispatcher_token_name: $nd, mirror_token_name: $nm}' \
      | $CLI kv put -mount="$BAO_MOUNT" ${CAS[@]+"${CAS[@]}"} "$BAO_PATH" - >/dev/null; then
    echo "ERROR: could not write ${BAO_MOUNT}/${BAO_PATH} (changed since this run read it?). Deleting the new tokens." >&2
    drop_new
    exit 1
  fi
  unset DISPATCHER_TOKEN MIRROR_TOKEN
  echo "Wrote ${BAO_MOUNT}/${BAO_PATH} (tokens actions-dispatcher-$stamp, action-mirrors-$stamp)." >&2
fi

if [ "$REVOKE_OLD" -eq 1 ]; then
  keep="$($CLI kv get -mount="$BAO_MOUNT" -format=json "$BAO_PATH" | jq -re '.data.data | .dispatcher_token_name, .mirror_token_name')" \
    || { echo "ERROR: could not read the current token names from ${BAO_MOUNT}/${BAO_PATH}" >&2; exit 1; }
  names="$(list_tokens)" || { echo "ERROR: could not list $BOT's tokens" >&2; exit 1; }
  revoke_failed=0
  for name in $names; do
    grep -qxF "$name" <<<"$keep" && continue
    if bot -o /dev/null -X DELETE "$API/users/$BOT/tokens/$name"; then echo "  revoked $name"
    else echo "ERROR: could not revoke $name" >&2; revoke_failed=1; fi
  done
  [ "$revoke_failed" -eq 0 ] || exit 1
fi
unset ADMIN_PW BOT_PW

{
  echo "Point the chart at it:"
  echo "  forgejoCoderSecrets.externalSecret.runnerPath: ${BAO_PATH}"
  echo "  forgejoRunner.dispatcher.tokenSecret / forgejoRunner.actions.tokenSecret: the Secret names to sync (key token)"
  [ "$ROTATE" -ne 1 ] || echo "After ESO syncs (refreshInterval) and the dispatcher restarts, rerun with --revoke-old."
} >&2
