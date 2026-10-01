#!/usr/bin/env bash
# Coder postsync hook: create the first owner from Secret coder-admin if
# Coder has no users yet, then push every template in deploy/workspaces/
# templates. Idempotent: pushing an unchanged template is a no-op version.
#
# Needs the `coder` CLI (brew install coder). Uses a throwaway CLI config dir,
# so it never touches your own `coder login`.
#
# Usage: deploy/scripts/bootstrap-workspaces.sh [environment]   (default: sandbox)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$ROOT/deploy/environments/${1:-sandbox}.yaml"
val() { yq -r "$1" "$ENV_FILE"; }
k() { kubectl --context "$(val .kubeContext)" -n "$(val .namespace)" "$@"; }
get() { k get secret coder-admin -o "jsonpath={.data.$1}" | base64 -d; }
command -v coder >/dev/null || { echo "missing 'coder' CLI (brew install coder)" >&2; exit 1; }

url="https://$(val .workspaces.host)"
email="$(get email)"; username="$(get username)"; password="$(get password)"

# JSON bodies go over stdin so the password stays out of the process list.
post() { curl -fsS -X POST -H 'Content-Type: application/json' --data-binary @- "$url$1"; }

if curl -fsS "$url/api/v2/users/first" -o /dev/null 2>/dev/null; then
  echo "coder: first user already exists"
else
  printf '{"email":"%s","username":"%s","password":"%s","trial":false}' \
    "$email" "$username" "$password" | post /api/v2/users/first >/dev/null
  echo "coder: created first owner $username"
fi

CODER_SESSION_TOKEN="$(printf '{"email":"%s","password":"%s"}' "$email" "$password" \
  | post /api/v2/users/login | yq -p json -r .session_token)"
CODER_CONFIG_DIR="$(mktemp -d)"
trap 'rm -rf "$CODER_CONFIG_DIR"' EXIT
export CODER_URL="$url" CODER_SESSION_TOKEN CODER_CONFIG_DIR

for dir in "$ROOT"/deploy/workspaces/templates/*/; do
  name="$(basename "$dir")"
  coder templates push "$name" --directory "$dir" --yes \
    --variable namespace="$(val .namespace)" \
    --message "deploy/workspaces/templates/$name"
done
