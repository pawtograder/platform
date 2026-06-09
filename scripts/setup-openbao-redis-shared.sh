#!/usr/bin/env bash
# One-time bootstrap of the shared-Redis credentials in OpenBao.
#
# Writes two keys to kv/apps/pawtograder/redis-shared:
#   redis_password   — bare password used by the redis-server pod via
#                      the bootstrap manifests' --requirepass arg
#   REDIS_URL        — full connection URL the chart's
#                      pawtograder-redis ExternalSecret extracts into
#                      the edge-functions Deployment via envFrom
#
# Both per-PR previews (consumers) and the shared Redis StatefulSet
# (server, see charts/pawtograder/examples/shared-redis/) point at this
# same Bao path so the passwords stay in lockstep.
#
# Run this once per cluster. Re-run with --rotate to mint a new
# password; rotating requires bouncing the Redis StatefulSet AND all
# consumer pods (helm upgrade is sufficient for the latter).
#
# Usage:
#   ./scripts/setup-openbao-redis-shared.sh
#   ./scripts/setup-openbao-redis-shared.sh --rotate
#   ./scripts/setup-openbao-redis-shared.sh --host redis.<ns>.svc.cluster.local
#
# Requires `bao` (or `vault`) on PATH; BAO_ADDR/BAO_TOKEN (or VAULT_*)
# exported; `jq` for safe JSON serialisation.

set -euo pipefail

usage() {
  cat <<EOF
Usage: $0 [--rotate] [--host <host>] [--port <port>]

  --rotate         Generate a new random password even if one already
                   exists. Without this, the script refuses to overwrite.
  --host <host>    Service DNS where the shared Redis is reachable.
                   Default: redis.pawtograder-shared-redis.svc.cluster.local
                   (matches the bootstrap manifests in
                   charts/pawtograder/examples/shared-redis/).
  --port <port>    Default: 6379.
  --bao-mount      KV mount name (default: kv).
  --bao-path       Path within the mount (default: apps/pawtograder/redis-shared).

The script prints the password to stdout — capture for your password
manager. Status messages go to stderr.
EOF
}

ROTATE=0
HOST="redis.pawtograder-shared-redis.svc.cluster.local"
PORT="6379"
BAO_MOUNT="kv"
BAO_PATH="apps/pawtograder/redis-shared"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --rotate)        ROTATE=1; shift ;;
    --host)          HOST="${2:?--host requires a value}"; shift 2 ;;
    --port)          PORT="${2:?--port requires a value}"; shift 2 ;;
    --bao-mount)     BAO_MOUNT="${2:?--bao-mount requires a value}"; shift 2 ;;
    --bao-path)      BAO_PATH="${2:?--bao-path requires a value}"; shift 2 ;;
    --host=*)        HOST="${1#*=}"; shift ;;
    --port=*)        PORT="${1#*=}"; shift ;;
    --bao-mount=*)   BAO_MOUNT="${1#*=}"; shift ;;
    --bao-path=*)    BAO_PATH="${1#*=}"; shift ;;
    -h|--help)       usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
done

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

$CLI status >/dev/null 2>&1 || {
  echo "ERROR: $CLI status failed — set BAO_ADDR/BAO_TOKEN (or VAULT_*) and log in" >&2
  exit 1
}

if $CLI kv get -mount="$BAO_MOUNT" "$BAO_PATH" >/dev/null 2>&1; then
  if [ "$ROTATE" -ne 1 ]; then
    echo "ERROR: ${BAO_MOUNT}/${BAO_PATH} already exists. Pass --rotate to overwrite." >&2
    exit 1
  fi
  echo "Existing creds at ${BAO_MOUNT}/${BAO_PATH} — rotating." >&2
fi

# 24-char URL-safe password (no @ / : / # / ? to keep the URL parseable).
PASSWORD="$(openssl rand -base64 32 | tr -d '=+/@:#?' | cut -c1-24)"

# URL-encode the password so the URL parses cleanly even if a future
# rotation lands on a character openssl decides to emit and the strip
# above misses. Currently the strip handles all the special URL chars
# but the encode is cheap defense.
URLPW="$(jq -rn --arg p "$PASSWORD" '$p|@uri')"
REDIS_URL="redis://:${URLPW}@${HOST}:${PORT}"

jq -n --arg pw "$PASSWORD" --arg url "$REDIS_URL" \
  '{redis_password: $pw, REDIS_URL: $url}' \
  | $CLI kv put -mount="$BAO_MOUNT" "$BAO_PATH" - >/dev/null

# Stdout: just the password (for clean capture).
echo "$PASSWORD"

{
  echo
  echo "Wrote ${BAO_MOUNT}/${BAO_PATH}:"
  echo "  redis_password = <printed to stdout>"
  echo "  REDIS_URL      = redis://:***@${HOST}:${PORT}"
  echo
  echo "Next steps:"
  echo "  1. Apply the shared Redis bootstrap manifests (once per cluster):"
  echo "       kubectl apply -k charts/pawtograder/examples/shared-redis/"
  echo "     ESO syncs the password into the namespace, the StatefulSet"
  echo "     reads it as REQUIREPASS via env."
  echo
  echo "  2. Set redis.provider=shared in your chart values (already done"
  echo "     in values-preview.yaml). On next helm upgrade, ESO syncs"
  echo "     REDIS_URL into pawtograder-redis and the edge runtime mounts"
  echo "     it via envFrom — Redis.ts picks the ioredis branch."
  echo
  echo "  3. Rotation later: --rotate writes a new password, but you must"
  echo "     also restart the Redis StatefulSet (so it picks up the new"
  echo "     requirepass) AND all consumer pods (helm upgrade)."
} >&2
