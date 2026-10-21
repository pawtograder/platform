#!/usr/bin/env bash
# One-time bootstrap of the Forgejo and Coder credentials in OpenBao, read by
# the chart's forgejoCoderSecrets ExternalSecrets.
#
# Writes (default mount=kv):
#   <prefix>/forgejo-<env>   admin_username, admin_password, db_password, runner_secret
#   <prefix>/coder-<env>     admin_email, admin_username, admin_password, db_password
#
# Passwords are alphanumeric: Coder's connection settings don't escape them.
# runner_secret is 40 hex characters, as `forgejo-cli actions register` requires.
#
# Usage:
#   ./scripts/setup-openbao-forgejo-coder.sh --env staging --coder-email ops@example.edu
#   ./scripts/setup-openbao-forgejo-coder.sh --env staging --coder-email ... --rotate
#
# Requires `bao` (or `vault`) on PATH; BAO_ADDR/BAO_TOKEN (or VAULT_*)
# exported; `jq` and `openssl`.

set -euo pipefail

usage() {
  cat <<EOF
Usage: $0 --env <env> --coder-email <email> [--rotate] [--bao-mount <mount>] [--prefix <path>]

  --env <env>            preview|staging|prod.
  --coder-email <email>  Email for Coder's first owner (Coder requires one).
  --rotate               Overwrite paths that already exist. Rotating db_password needs a
                         helm upgrade (the app-databases Job re-sets the role's password).
  --bao-mount <mount>    KV mount name (default: kv).
  --prefix <path>        Path within the mount (default: apps/pawtograder).

Prints nothing secret; read values back with \`bao kv get\`.
EOF
}

ENV_NAME=""
CODER_EMAIL=""
ROTATE=0
BAO_MOUNT="kv"
PREFIX="apps/pawtograder"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)          ENV_NAME="${2:?--env requires a value}"; shift 2 ;;
    --coder-email)  CODER_EMAIL="${2:?--coder-email requires a value}"; shift 2 ;;
    --rotate)       ROTATE=1; shift ;;
    --bao-mount)    BAO_MOUNT="${2:?--bao-mount requires a value}"; shift 2 ;;
    --prefix)       PREFIX="${2:?--prefix requires a value}"; shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
done
[ -n "$ENV_NAME" ] || { usage >&2; exit 2; }
[ -n "$CODER_EMAIL" ] || { usage >&2; exit 2; }

CLI=""
if command -v bao >/dev/null 2>&1; then
  CLI=bao
elif command -v vault >/dev/null 2>&1; then
  CLI=vault
  : "${VAULT_ADDR:=${BAO_ADDR:-}}"
  : "${VAULT_TOKEN:=${BAO_TOKEN:-}}"
  export VAULT_ADDR VAULT_TOKEN
else
  echo "ERROR: neither 'bao' nor 'vault' found on PATH" >&2
  exit 2
fi
command -v jq >/dev/null 2>&1 || { echo "ERROR: 'jq' is required" >&2; exit 2; }
command -v openssl >/dev/null 2>&1 || { echo "ERROR: 'openssl' is required" >&2; exit 2; }

$CLI status >/dev/null 2>&1 || {
  echo "ERROR: $CLI status failed — set BAO_ADDR/BAO_TOKEN (or VAULT_*) and log in" >&2
  exit 1
}

pw() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-32; }

for app in forgejo coder; do
  if $CLI kv get -mount="$BAO_MOUNT" "$PREFIX/$app-$ENV_NAME" >/dev/null 2>&1 && [ "$ROTATE" -ne 1 ]; then
    echo "ERROR: ${BAO_MOUNT}/${PREFIX}/${app}-${ENV_NAME} already exists. Pass --rotate to overwrite." >&2
    exit 1
  fi
done

jq -n --arg a "$(pw)" --arg d "$(pw)" --arg r "$(openssl rand -hex 20)" \
  '{admin_username: "forgejo-admin", admin_password: $a, db_password: $d, runner_secret: $r}' \
  | $CLI kv put -mount="$BAO_MOUNT" "$PREFIX/forgejo-$ENV_NAME" - >/dev/null
jq -n --arg e "$CODER_EMAIL" --arg a "$(pw)" --arg d "$(pw)" \
  '{admin_email: $e, admin_username: "coder-admin", admin_password: $a, db_password: $d}' \
  | $CLI kv put -mount="$BAO_MOUNT" "$PREFIX/coder-$ENV_NAME" - >/dev/null

{
  echo "Wrote ${BAO_MOUNT}/${PREFIX}/forgejo-${ENV_NAME} and ${BAO_MOUNT}/${PREFIX}/coder-${ENV_NAME}."
  echo "Point the chart at them:"
  echo "  forgejoCoderSecrets.externalSecret.enabled: true"
  echo "  forgejoCoderSecrets.externalSecret.forgejoPath: ${PREFIX}/forgejo-${ENV_NAME}"
  echo "  forgejoCoderSecrets.externalSecret.coderPath: ${PREFIX}/coder-${ENV_NAME}"
} >&2
