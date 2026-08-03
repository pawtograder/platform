#!/usr/bin/env bash
# Publishes a per-PR preview's e2e bundle (Supabase keys + e2e bypass secrets
# + derived URLs) from the preview namespace's k8s Secrets into OpenBao, so
# out-of-cluster runners (the VoiceOver Mac) can fetch them without kubectl.
#
# Called by preview.yml's `secrets` job on every deploy (idempotent overwrite
# — preview secrets never rotate mid-PR) and removed by its `destroy` job.
# Also runnable by hand against any live preview.
#
# Usage:
#   ./scripts/publish-preview-e2e-to-bao.sh <preview_id>
#
# Requires: kubectl (cluster access to the preview namespace), `bao` (or
# `vault`) on PATH, BAO_ADDR + BAO_TOKEN exported (CI logs in via AppRole).
#
# Reader side: scripts/export-preview-e2e-from-bao.sh
set -euo pipefail

if [ $# -ne 1 ] || [[ "${1:-}" =~ ^(-h|--help)$ ]]; then
  grep '^#' "$0" | sed 's/^# \?//'
  exit 0
fi

PREVIEW_ID="$1"
# Same DNS-safe slug rule as preview.yml's meta job — the id flows into a
# namespace lookup and a Bao path.
if [[ ! "$PREVIEW_ID" =~ ^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$ ]]; then
  echo "ERROR: invalid preview_id '$PREVIEW_ID'" >&2
  exit 1
fi

NS="pawtograder-preview-pr-${PREVIEW_ID}"
PREVIEW_DOMAIN="${PREVIEW_DOMAIN:-preview.pawtograder.net}"
BASE_URL="https://pr-${PREVIEW_ID}.${PREVIEW_DOMAIN}"
# Single-label api host, matching preview.yml's meta job (NOT the older
# api.pr-<id>. form still used by export-preview-env.sh).
SUPABASE_URL="https://pr-${PREVIEW_ID}-api.${PREVIEW_DOMAIN}"
BAO_MOUNT="${BAO_MOUNT:-kv}"
BAO_PATH="apps/pawtograder/preview-e2e/pr-${PREVIEW_ID}"

command -v kubectl >/dev/null 2>&1 || { echo "missing dependency: kubectl" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "missing dependency: jq" >&2; exit 1; }

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

$CLI status >/dev/null 2>&1 || {
  echo "ERROR: $CLI status failed — set BAO_ADDR/BAO_TOKEN (or VAULT_*) and log in" >&2
  exit 1
}

if ! kubectl get namespace "$NS" >/dev/null 2>&1; then
  echo "ERROR: namespace $NS not found — was the preview deployed?" >&2
  exit 1
fi

field() {
  # $1 = secret name, $2 = key. Empty if missing.
  kubectl -n "$NS" get secret "$1" -o jsonpath="{.data.$2}" 2>/dev/null | base64 -d 2>/dev/null || true
}

ANON_KEY=$(field pawtograder-jwt ANON_KEY)
SERVICE_ROLE_KEY=$(field pawtograder-jwt SERVICE_ROLE_KEY)
END_TO_END_SECRET=$(field pawtograder-e2e END_TO_END_SECRET)
EDGE_FUNCTION_SECRET=$(field pawtograder-e2e EDGE_FUNCTION_SECRET)

for pair in "ANON_KEY:$ANON_KEY" "SERVICE_ROLE_KEY:$SERVICE_ROLE_KEY" "END_TO_END_SECRET:$END_TO_END_SECRET"; do
  if [ -z "${pair#*:}" ]; then
    echo "ERROR: ${pair%%:*} missing in $NS — did the preview's secrets job run?" >&2
    exit 1
  fi
done

# stdin form so no secret lands in argv (visible in `ps`).
jq -n \
  --arg base_url "$BASE_URL" \
  --arg supabase_url "$SUPABASE_URL" \
  --arg anon "$ANON_KEY" \
  --arg service "$SERVICE_ROLE_KEY" \
  --arg e2e "$END_TO_END_SECRET" \
  --arg edge "$EDGE_FUNCTION_SECRET" \
  --arg by "${GITHUB_SERVER_URL:-}${GITHUB_REPOSITORY:+/$GITHUB_REPOSITORY}${GITHUB_RUN_ID:+/actions/runs/$GITHUB_RUN_ID}" \
  --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{
    BASE_URL: $base_url,
    SUPABASE_URL: $supabase_url,
    SUPABASE_ANON_KEY: $anon,
    SUPABASE_SERVICE_ROLE_KEY: $service,
    END_TO_END_SECRET: $e2e,
    EDGE_FUNCTION_SECRET: $edge,
    PUBLISHED_BY: $by,
    PUBLISHED_AT: $at
  }' | $CLI kv put -mount="$BAO_MOUNT" "$BAO_PATH" - >/dev/null

echo "Published e2e bundle for pr-${PREVIEW_ID} to ${BAO_MOUNT}/${BAO_PATH}"
