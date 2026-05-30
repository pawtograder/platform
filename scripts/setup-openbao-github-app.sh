#!/usr/bin/env bash
# Provision a Pawtograder GitHub App's credentials in OpenBao so that the
# Helm chart's ExternalSecret can sync them into a deploy namespace as the
# `pawtograder-edge-functions` Secret.
#
# Resulting path:  kv/apps/pawtograder/github-app-<env>
# Resulting keys:  app-id, private-key, oauth-client-id,
#                  oauth-client-secret, webhook-secret
#
# The chart-side wiring (set `secrets.externalSecret.enabled=true` and
# `secrets.externalSecret.env=<env>` in values) creates an ExternalSecret
# that pulls those five fields into a k8s Secret named per
# `secrets.names.edgeFunctions`. When this is enabled, the chart's stub
# bootstrap path is suppressed so ESO is the unambiguous owner.
#
# Usage:
#   scripts/setup-openbao-github-app.sh \
#     --env preview \
#     --from-file .secrets/github-app.env
#
# .env file format:
#   # Required — the edge runtime fails to load without these.
#   GITHUB_APP_ID=123456
#   GITHUB_OAUTH_CLIENT_ID=Iv1.abc...
#   GITHUB_PRIVATE_KEY_PATH=/abs/path/to/private-key.pem
#   # Optional — only needed if you wire up the OAuth login flow /
#   # GitHub webhook verification respectively. Defaulted to empty.
#   GITHUB_OAUTH_CLIENT_SECRET=...
#   GITHUB_WEBHOOK_SECRET=...
#
# Requires: `bao` (or `vault`) CLI on PATH, BAO_ADDR / BAO_TOKEN exported
# (or the legacy VAULT_* equivalents). `jq` is required for safe PEM
# embedding.

set -euo pipefail

usage() {
  cat <<EOF
Usage: $0 --env <name> --from-file <path>

  --env <name>         Environment slug (preview|staging|prod|...). Becomes
                       part of the Bao path: apps/pawtograder/github-app-<name>.
  --from-file <path>   Path to a .env-style file containing the five
                       GITHUB_* variables (see header comment).
  --bao-mount <name>   KV mount name (default: kv).
  --bao-path-prefix    Path prefix within the mount (default: apps/pawtograder).
  --dry-run            Print the bao command(s) that would run, don't execute.

Examples:
  $0 --env preview --from-file .secrets/github-app-preview.env
  $0 --env prod    --from-file .secrets/github-app-prod.env

The script never prints secret material to stdout/stderr — only the Bao
path it wrote to and which keys landed.
EOF
}

ENV_NAME=""
ENV_FILE=""
BAO_MOUNT="kv"
PATH_PREFIX="apps/pawtograder"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)             ENV_NAME="${2:?}"; shift 2 ;;
    --from-file)       ENV_FILE="${2:?}"; shift 2 ;;
    --bao-mount)       BAO_MOUNT="${2:?}"; shift 2 ;;
    --bao-path-prefix) PATH_PREFIX="${2:?}"; shift 2 ;;
    --dry-run)         DRY_RUN=1; shift ;;
    -h|--help)         usage; exit 0 ;;
    *)                 echo "unknown flag: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$ENV_NAME"  ]] || { echo "ERROR: --env is required" >&2; usage >&2; exit 2; }
[[ -n "$ENV_FILE"  ]] || { echo "ERROR: --from-file is required" >&2; usage >&2; exit 2; }
[[ -r "$ENV_FILE"  ]] || { echo "ERROR: cannot read --from-file: $ENV_FILE" >&2; exit 2; }

# Pick CLI. Prefer `bao`; accept `vault` as fallback.
CLI=""
if command -v bao >/dev/null 2>&1; then
  CLI=bao
elif command -v vault >/dev/null 2>&1; then
  CLI=vault
  # Mirror Bao env into Vault env if not already set.
  : "${VAULT_ADDR:=${BAO_ADDR:-}}"
  : "${VAULT_TOKEN:=${BAO_TOKEN:-}}"
  export VAULT_ADDR VAULT_TOKEN
else
  echo "ERROR: neither 'bao' nor 'vault' found on PATH" >&2
  exit 2
fi

command -v jq >/dev/null 2>&1 || { echo "ERROR: 'jq' is required for safe PEM embedding" >&2; exit 2; }

# Sanity-check connectivity (skipped in dry-run so dry runs work offline).
if [[ $DRY_RUN -eq 0 ]]; then
  if ! $CLI status >/dev/null 2>&1; then
    echo "ERROR: $CLI status failed — set BAO_ADDR/BAO_TOKEN (or VAULT_*) and log in" >&2
    exit 1
  fi
fi

# Source the env file in a subshell-safe way: only the GITHUB_* vars cross
# back, nothing else from the file leaks into the calling shell.
# shellcheck disable=SC1090
set -a
. "$ENV_FILE"
set +a

required=(GITHUB_APP_ID GITHUB_OAUTH_CLIENT_ID GITHUB_PRIVATE_KEY_PATH)
optional=(GITHUB_OAUTH_CLIENT_SECRET GITHUB_WEBHOOK_SECRET)
missing=()
for v in "${required[@]}"; do
  if [[ -z "${!v:-}" ]]; then missing+=("$v"); fi
done
if (( ${#missing[@]} )); then
  echo "ERROR: missing required keys in $ENV_FILE: ${missing[*]}" >&2
  exit 2
fi
# Default empties so jq always emits the same 5-key shape (the chart's
# ExternalSecret pulls all 5 properties — a missing one would be a sync
# error, not a silent skip).
: "${GITHUB_OAUTH_CLIENT_SECRET:=}"
: "${GITHUB_WEBHOOK_SECRET:=}"

[[ -r "$GITHUB_PRIVATE_KEY_PATH" ]] || {
  echo "ERROR: cannot read GITHUB_PRIVATE_KEY_PATH=$GITHUB_PRIVATE_KEY_PATH" >&2
  exit 2
}

# Light shape check: GitHub App PEM should be PKCS#1 or PKCS#8 RSA.
if ! head -1 "$GITHUB_PRIVATE_KEY_PATH" | grep -qE '^-----BEGIN (RSA )?PRIVATE KEY-----'; then
  echo "ERROR: $GITHUB_PRIVATE_KEY_PATH does not look like a PEM-encoded private key" >&2
  exit 2
fi

# App ID must parse as integer (createAppAuth rejects strings).
if ! [[ "$GITHUB_APP_ID" =~ ^[0-9]+$ ]]; then
  echo "ERROR: GITHUB_APP_ID must be a positive integer (got: $GITHUB_APP_ID)" >&2
  exit 2
fi

BAO_PATH="${PATH_PREFIX}/github-app-${ENV_NAME}"

# Build the JSON payload via jq so a multiline PEM round-trips safely
# (literal newlines, no shell escaping pitfalls). `--rawfile` reads the
# whole file as one JSON string.
PAYLOAD=$(jq -n \
  --arg app_id              "$GITHUB_APP_ID" \
  --arg oauth_client_id     "$GITHUB_OAUTH_CLIENT_ID" \
  --arg oauth_client_secret "$GITHUB_OAUTH_CLIENT_SECRET" \
  --arg webhook_secret      "$GITHUB_WEBHOOK_SECRET" \
  --rawfile private_key     "$GITHUB_PRIVATE_KEY_PATH" \
  '{
    "app-id":              $app_id,
    "private-key":         $private_key,
    "oauth-client-id":     $oauth_client_id,
    "oauth-client-secret": $oauth_client_secret,
    "webhook-secret":      $webhook_secret
  }')

supplied_opt=()
[[ -n "$GITHUB_OAUTH_CLIENT_SECRET" ]] && supplied_opt+=(oauth-client-secret)
[[ -n "$GITHUB_WEBHOOK_SECRET"      ]] && supplied_opt+=(webhook-secret)
echo "Target:   ${CLI} kv put -mount=${BAO_MOUNT} ${BAO_PATH}"
echo "Required: app-id private-key oauth-client-id"
if (( ${#supplied_opt[@]} )); then
  echo "Optional: ${supplied_opt[*]} (also supplied)"
  missing_opt=()
  [[ -z "$GITHUB_OAUTH_CLIENT_SECRET" ]] && missing_opt+=(oauth-client-secret)
  [[ -z "$GITHUB_WEBHOOK_SECRET"      ]] && missing_opt+=(webhook-secret)
  (( ${#missing_opt[@]} )) && echo "Empty:    ${missing_opt[*]} (written as empty string)"
else
  echo "Optional: none — oauth-client-secret + webhook-secret written as empty strings"
fi

if [[ $DRY_RUN -eq 1 ]]; then
  echo "(dry-run; not writing)"
  exit 0
fi

# Pipe JSON to the CLI. `-` reads the data from stdin.
printf '%s' "$PAYLOAD" | $CLI kv put -mount="$BAO_MOUNT" "$BAO_PATH" -

echo "OK: wrote ${BAO_MOUNT}/${BAO_PATH}"
echo
echo "Next steps:"
echo "  1. In the deploy namespace's helm values, set:"
echo "       secrets:"
echo "         externalSecret:"
echo "           enabled: true"
echo "           env: ${ENV_NAME}"
echo "  2. helm upgrade. ESO will create the Secret named per"
echo "     secrets.names.edgeFunctions (default: pawtograder-edge-functions)."
echo "  3. Verify:"
echo "       kubectl -n <ns> get externalsecret pawtograder-edge-functions"
echo "       kubectl -n <ns> get secret pawtograder-edge-functions -o jsonpath='{.data}' | jq 'keys'"
