#!/usr/bin/env bash
# Create every Secret the stack reads, with `kubectl create secret` and fresh
# random values. Re-runnable: a Secret that already exists is left alone, so
# this never rotates anything (docs/operations/secrets-rotation.md for that).
#
# Pawtograder's follow .github/workflows/preview.yml: keys from
# scripts/GenerateJwtKeys.ts, and pawtograder-jwt / -postgres / -s3 are
# all-or-nothing, since rotating one alone breaks every running pod.
#
# Nothing is printed. Read a value back with
#   kubectl get secret <name> -o jsonpath='{.data.<key>}' | base64 -d
#
# Usage: deploy/scripts/create-secrets.sh [environment]   (default: sandbox)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$ROOT/deploy/environments/${1:-sandbox}.yaml"
[ -f "$ENV_FILE" ] || { echo "no such environment: $ENV_FILE" >&2; exit 1; }
for bin in kubectl yq openssl npx; do
  command -v "$bin" >/dev/null || { echo "missing '$bin'" >&2; exit 1; }
done

val() { yq -r "$1" "$ENV_FILE"; }
k() { kubectl --context "$(val .kubeContext)" -n "$(val .namespace)" "$@"; }
exists() { k get secret "$1" >/dev/null 2>&1; }
get() { k get secret "$1" -o "jsonpath={.data.$2}" | base64 -d; }
# URL- and shell-safe: these end up inside connection strings.
pw() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-32; }

create() {
  local name="$1"; shift
  if exists "$name"; then echo "exists:  $name"; return; fi
  k create secret generic "$name" "$@" >/dev/null
  k label secret "$name" app.kubernetes.io/part-of=pawtograder-stack >/dev/null
  echo "created: $name"
}

# Fail on "can't reach the cluster" here, not later as "Secret missing".
k get secrets --request-timeout=15s >/dev/null

s3="$(val .s3.credentialsSecret)"
for s in "$s3" "$(val .tlsSecret)"; do
  exists "$s" || { echo "Secret $s should come with the namespace; ask the cluster operator." >&2; exit 1; }
done

# --- Postgres instances and the app databases in them ---------------------
for instance in $(val '.postgres.instances | keys | .[]'); do
  create "$instance-superuser" --from-literal=POSTGRES_PASSWORD="$(pw)"
done
create forgejo-db-credentials --from-literal=FORGEJO_DB_PASSWORD="$(pw)"
create coder-db-credentials --from-literal=CODER_DB_PASSWORD="$(pw)"

# --- Forgejo --------------------------------------------------------------
create forgejo-admin --from-literal=username=forgejo-admin --from-literal=password="$(pw)"
# 40 hex chars, shared by Forgejo and the runner (offline registration).
create forgejo-runner --from-literal=secret="$(openssl rand -hex 20)"

# --- Cloud Workspaces (Coder) -----------------------------------------------
# First Coder owner, created by scripts/bootstrap-workspaces.sh.
create coder-admin \
  --from-literal=email="coder-admin@$(val .domain)" \
  --from-literal=username=coder-admin \
  --from-literal=password="$(pw)"

# --- Pawtograder ------------------------------------------------------------
atomic=(pawtograder-jwt pawtograder-postgres pawtograder-s3)
present=0
for s in "${atomic[@]}"; do exists "$s" && present=$((present + 1)); done
if [ "$present" -ne 0 ] && [ "$present" -ne "${#atomic[@]}" ]; then
  echo "Partial Pawtograder secret set (${atomic[*]}): refusing to fill in." >&2
  echo "Delete the rest too (that wipes sessions; the database must be recreated) and re-run." >&2
  exit 1
fi

generated="$(mktemp)"
chmod 600 "$generated"
trap 'rm -f "$generated"' EXIT
(cd "$ROOT" && npx -y tsx scripts/GenerateJwtKeys.ts --env) > "$generated"
gen() { sed -n "s/^$1=//p" "$generated" | head -n1; }
[ -n "$(gen JWT_SECRET)" ] || { echo "GenerateJwtKeys.ts produced no output" >&2; exit 1; }

if [ "$present" -eq 0 ]; then
  create pawtograder-jwt \
    --from-literal=JWT_SECRET="$(gen JWT_SECRET)" \
    --from-literal=ANON_KEY="$(gen ANON_KEY)" \
    --from-literal=SERVICE_ROLE_KEY="$(gen SERVICE_ROLE_KEY)" \
    --from-literal=JWT_PRIVATE_JWKS="$(gen JWT_PRIVATE_JWKS)" \
    --from-literal=JWT_PUBLIC_JWKS="$(gen JWT_PUBLIC_JWKS)" \
    --from-literal=JWT_REALTIME_JWKS="$(gen JWT_REALTIME_JWKS)" \
    --from-literal=JWT_SIGNING_JWK="$(gen JWT_SIGNING_JWK)" \
    --from-literal=REALTIME_ENC_KEY="$(gen REALTIME_ENC_KEY)" \
    --from-literal=PG_META_CRYPTO_KEY="$(gen PG_META_CRYPTO_KEY)" \
    --from-literal=PGSODIUM_ROOT_KEY="$(gen PGSODIUM_ROOT_KEY)"
  create pawtograder-postgres \
    --from-literal=POSTGRES_PASSWORD="$(gen POSTGRES_PASSWORD)" \
    --from-literal=PAWTOGRADER_PASSWORD="$(gen PAWTOGRADER_PASSWORD)"
  create pawtograder-s3 \
    --from-literal=AWS_ACCESS_KEY_ID="$(get "$s3" AWS_ACCESS_KEY_ID)" \
    --from-literal=AWS_SECRET_ACCESS_KEY="$(get "$s3" AWS_SECRET_ACCESS_KEY)"
else
  echo "exists:  ${atomic[*]}"
fi

# Integration bundles the chart mounts envFrom. GitHub App values are stubs,
# as in preview.yml, until a real App is registered (README).
create pawtograder-web --from-literal=CACHE_INVALIDATION_SECRET="$(gen CACHE_INVALIDATION_SECRET)"
create pawtograder-edge-functions \
  --from-literal=EDGE_FUNCTION_SECRET="$(gen EDGE_FUNCTION_SECRET)" \
  --from-literal=GITHUB_PRIVATE_KEY_STRING="$(openssl genrsa 2048 2>/dev/null)" \
  --from-literal=GITHUB_APP_ID=1 \
  --from-literal=GITHUB_OAUTH_CLIENT_ID=stub \
  --from-literal=GITHUB_OAUTH_CLIENT_SECRET=stub \
  --from-literal=GITHUB_WEBHOOK_SECRET="$(openssl rand -hex 20)"
