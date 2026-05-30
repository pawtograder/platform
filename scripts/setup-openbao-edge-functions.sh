#!/usr/bin/env bash
# Provision Pawtograder edge-function credentials in OpenBao, one
# integration ("bundle") at a time. Each bundle lands at its own KV path
# so rotating one integration's creds never touches the others.
#
# Resulting Bao paths (default mount=kv, prefix=apps/pawtograder):
#
#   apps/pawtograder/github-app-<env>    GITHUB_APP_ID, GITHUB_PRIVATE_KEY_STRING,
#                                        GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET,
#                                        GITHUB_WEBHOOK_SECRET
#   apps/pawtograder/aws-chime-<env>     AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
#                                        AWS_CHIME_EVENT_AUTH_TOKEN, AWS_CHIME_SQS_QUEUE_ARN,
#                                        EVENTBRIDGE_SECRET
#   apps/pawtograder/discord-<env>       DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN
#   apps/pawtograder/canvas-<env>        CANVAS_API_KEY, CANVAS_API_URL
#   apps/pawtograder/sis-<env>           SIS_API_URL, SIS_AUTH_TOKEN
#   apps/pawtograder/smtp-<env>          SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD,
#                                        SMTP_FROM, SMTP_REPLY_TO
#   apps/pawtograder/mcp-<env>           MCP_OAUTH_CLIENT_ID, MCP_OAUTH_CLIENT_SECRET,
#                                        MCP_OAUTH_ENDPOINT
#   apps/pawtograder/redis-<env>         UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
#   apps/pawtograder/sentry-<env>        SENTRY_DSN, SENTRY_DEBUG
#   apps/pawtograder/misc-<env>          ARTIFACT_SERVE_JWT_SECRET, ASSESSMENT_EXPORT_PEPPER,
#                                        METRICS_TOKEN, SUPPORT_EMAIL, APP_URL,
#                                        EDGE_FUNCTIONS_URL, PAWTOGRADER_WEBAPP_URL
#
# Keys are stored with their literal env-var names. The chart's
# ExternalSecret uses `dataFrom: extract` to dump each path verbatim
# into the pawtograder-edge-functions Secret. Adding a new env var to a
# bundle is "edit this script, rerun it." No chart change needed.
#
# All keys are OPTIONAL — the edge runtime checks before use. The script
# warns about every undocumented key and every missing documented key,
# then writes only what was supplied.
#
# File-backed values: any key ending in `_FILE` is treated as a path,
# the file contents are read, and the value is stored under the key
# name without `_FILE` (e.g. GITHUB_PRIVATE_KEY_STRING_FILE=/path/to/pem
# stores GITHUB_PRIVATE_KEY_STRING=<pem contents>).
#
# Usage:
#   scripts/setup-openbao-edge-functions.sh \
#     --env preview \
#     --bundle github-app \
#     --from-file .secrets/github-app-preview.env
#
# Requires: `bao` (or `vault`) on PATH; BAO_ADDR/BAO_TOKEN (or VAULT_*)
# exported; `jq` for safe value embedding.

set -euo pipefail

# --- bundle definitions ------------------------------------------------------
# Keep these in sync with the edge functions' Deno.env.get(...) usage
# (run: grep -rohE 'Deno\.env\.get\("[A-Z_]+"\)' supabase/functions/).
# When you add a new env var to edge functions, add it to the right bundle
# here so this script (and ESO sync) can carry it. Keys must match the
# env-var names exactly.

declare -A BUNDLE_KEYS=(
  [github-app]="GITHUB_APP_ID GITHUB_OAUTH_CLIENT_ID GITHUB_OAUTH_CLIENT_SECRET GITHUB_PRIVATE_KEY_STRING GITHUB_WEBHOOK_SECRET"
  [aws-chime]="AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_CHIME_EVENT_AUTH_TOKEN AWS_CHIME_SQS_QUEUE_ARN EVENTBRIDGE_SECRET"
  [discord]="DISCORD_APPLICATION_ID DISCORD_BOT_TOKEN"
  [canvas]="CANVAS_API_KEY CANVAS_API_URL"
  [sis]="SIS_API_URL SIS_AUTH_TOKEN"
  [smtp]="SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASSWORD SMTP_FROM SMTP_REPLY_TO"
  [mcp]="MCP_OAUTH_CLIENT_ID MCP_OAUTH_CLIENT_SECRET MCP_OAUTH_ENDPOINT"
  [redis]="UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN"
  [sentry]="SENTRY_DSN SENTRY_DEBUG"
  [misc]="ARTIFACT_SERVE_JWT_SECRET ASSESSMENT_EXPORT_PEPPER METRICS_TOKEN SUPPORT_EMAIL APP_URL EDGE_FUNCTIONS_URL PAWTOGRADER_WEBAPP_URL"
)

usage() {
  cat <<EOF
Usage: $0 --env <name> --bundle <name> --from-file <path>

  --env <name>          Environment slug (preview|staging|prod|...).
  --bundle <name>       One of: ${!BUNDLE_KEYS[*]}
  --from-file <path>    Path to a .env-style file with the bundle's keys.
                        Each key uses its literal env-var name. Append _FILE
                        to read the value from a file path (used for the
                        GitHub App PEM).
  --bao-mount <name>    KV mount name (default: kv).
  --bao-path-prefix     Path prefix within the mount (default: apps/pawtograder).
  --dry-run             Print what would be written, don't execute.
  --list                List all known bundles + their keys, then exit.

Examples:
  $0 --env preview --bundle github-app --from-file .secrets/github-app-preview.env
  $0 --env prod    --bundle discord    --from-file .secrets/discord-prod.env
  $0 --list

The script never prints secret values — only key names and counts.
EOF
}

list_bundles() {
  for b in $(echo "${!BUNDLE_KEYS[@]}" | tr ' ' '\n' | sort); do
    printf '  %-12s  %s\n' "$b" "${BUNDLE_KEYS[$b]}"
  done
}

ENV_NAME=""
BUNDLE=""
ENV_FILE=""
BAO_MOUNT="kv"
PATH_PREFIX="apps/pawtograder"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)             ENV_NAME="${2:?}"; shift 2 ;;
    --bundle)          BUNDLE="${2:?}"; shift 2 ;;
    --from-file)       ENV_FILE="${2:?}"; shift 2 ;;
    --bao-mount)       BAO_MOUNT="${2:?}"; shift 2 ;;
    --bao-path-prefix) PATH_PREFIX="${2:?}"; shift 2 ;;
    --dry-run)         DRY_RUN=1; shift ;;
    --list)            list_bundles; exit 0 ;;
    -h|--help)         usage; exit 0 ;;
    *)                 echo "unknown flag: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$ENV_NAME" ]] || { echo "ERROR: --env is required" >&2; usage >&2; exit 2; }
[[ -n "$BUNDLE"   ]] || { echo "ERROR: --bundle is required" >&2; usage >&2; exit 2; }
[[ -n "$ENV_FILE" ]] || { echo "ERROR: --from-file is required" >&2; usage >&2; exit 2; }
[[ -n "${BUNDLE_KEYS[$BUNDLE]+x}" ]] || {
  echo "ERROR: unknown bundle '$BUNDLE'. Valid: ${!BUNDLE_KEYS[*]}" >&2
  exit 2
}
[[ -r "$ENV_FILE" ]] || { echo "ERROR: cannot read --from-file: $ENV_FILE" >&2; exit 2; }

# Pick CLI. Prefer `bao`; accept `vault` as fallback.
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

if [[ $DRY_RUN -eq 0 ]]; then
  $CLI status >/dev/null 2>&1 || {
    echo "ERROR: $CLI status failed — set BAO_ADDR/BAO_TOKEN (or VAULT_*) and log in" >&2
    exit 1
  }
fi

# Source the env file; only the variables we look up cross back.
# shellcheck disable=SC1090
set -a
. "$ENV_FILE"
set +a

# shellcheck disable=SC2206
DOCUMENTED_KEYS=(${BUNDLE_KEYS[$BUNDLE]})
SUPPLIED_KEYS=()
MISSING_KEYS=()
JSON='{}'

for KEY in "${DOCUMENTED_KEYS[@]}"; do
  # File-backed value convention: ${KEY}_FILE points to a file whose
  # contents become the value of $KEY. Lets multi-line secrets like the
  # GitHub App PEM live in their own file, away from the .env.
  FILE_VAR="${KEY}_FILE"
  if [[ -n "${!FILE_VAR:-}" ]]; then
    [[ -r "${!FILE_VAR}" ]] || {
      echo "ERROR: ${FILE_VAR}=${!FILE_VAR} is not readable" >&2
      exit 2
    }
    VAL=$(cat "${!FILE_VAR}")
  else
    VAL="${!KEY:-}"
  fi

  if [[ -z "$VAL" ]]; then
    MISSING_KEYS+=("$KEY")
    continue
  fi
  SUPPLIED_KEYS+=("$KEY")
  JSON=$(jq --arg k "$KEY" --arg v "$VAL" '. + {($k): $v}' <<<"$JSON")
done

# Warn about anything in the .env that isn't a documented key for this
# bundle — usually a typo or wrong --bundle choice.
UNKNOWN_KEYS=()
while IFS= read -r line; do
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ "$line" =~ ^[[:space:]]*$ ]] && continue
  k="${line%%=*}"
  k="${k##[[:space:]]}"
  [[ "$k" == export\ * ]] && k="${k#export }"
  [[ -z "$k" ]] && continue
  # Allow _FILE suffix as the partner of a documented key.
  base="${k%_FILE}"
  is_documented=0
  for dk in "${DOCUMENTED_KEYS[@]}"; do
    if [[ "$dk" == "$base" ]]; then is_documented=1; break; fi
  done
  (( is_documented )) || UNKNOWN_KEYS+=("$k")
done < "$ENV_FILE"

BAO_PATH="${PATH_PREFIX}/${BUNDLE}-${ENV_NAME}"

echo "Bundle:   $BUNDLE"
echo "Target:   ${CLI} kv put -mount=${BAO_MOUNT} ${BAO_PATH}"
if (( ${#SUPPLIED_KEYS[@]} )); then
  echo "Supplied: ${SUPPLIED_KEYS[*]}"
else
  echo "Supplied: (none)"
fi
if (( ${#MISSING_KEYS[@]} )); then
  echo "WARN: missing documented keys: ${MISSING_KEYS[*]}" >&2
fi
if (( ${#UNKNOWN_KEYS[@]} )); then
  echo "WARN: keys in $ENV_FILE not in this bundle: ${UNKNOWN_KEYS[*]}" >&2
  echo "      (typos, or wrong --bundle? Run with --list to see other bundles.)" >&2
fi

if (( ${#SUPPLIED_KEYS[@]} == 0 )); then
  echo "ERROR: nothing to write (no documented keys supplied)" >&2
  exit 2
fi

if [[ $DRY_RUN -eq 1 ]]; then
  echo "(dry-run; not writing)"
  exit 0
fi

printf '%s' "$JSON" | $CLI kv put -mount="$BAO_MOUNT" "$BAO_PATH" -

echo "OK: wrote ${#SUPPLIED_KEYS[@]} key(s) to ${BAO_MOUNT}/${BAO_PATH}"
echo
echo "Next steps:"
echo "  1. Enable this bundle in the chart values:"
echo "       secrets:"
echo "         externalSecret:"
echo "           enabled: true"
echo "           env: ${ENV_NAME}"
echo "           bundles:"
echo "             - ${BUNDLE}"
echo "             # ...add other bundles you've populated"
echo "  2. helm upgrade. ESO syncs each bundle path into the"
echo "     pawtograder-edge-functions Secret via dataFrom: extract."
