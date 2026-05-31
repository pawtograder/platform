#!/usr/bin/env bash
# Pulls a per-PR preview's secrets out of its k8s namespace and emits a
# `.env`-style block sized for handing off to a debugging agent. Same
# env-var schema regardless of where the agent runs — only the URLs
# change:
#
#   --target=in-cluster (default): URLs point at in-cluster Service DNS
#     (<svc>.<ns>.svc.cluster.local). Agent runs as a tenant pod
#     anywhere in the cluster; CoreDNS resolves the names. No
#     port-forward, no TLS, no ingress hops. Postgres is directly
#     reachable.
#
#   --target=external: URLs point at the public ingress
#     (https://api.pr-<id>.preview.pawtograder.net). Agent runs
#     outside the cluster. Kong handles path routing for
#     auth/rest/storage/realtime/functions; direct-service URLs (rest,
#     auth, storage, realtime, functions) collapse to the same Kong
#     URL — the path prefix routes to the right backend. Internal-only
#     URLs (Kong admin, pg-meta) are absent. Postgres requires a
#     port-forward (see PGHOST notes in the output).
#
# Usage:
#   ./scripts/export-preview-agent-env.sh helm                     > tenant.env
#   ./scripts/export-preview-agent-env.sh helm --target=external   > tenant.env
#   eval "$(./scripts/export-preview-agent-env.sh helm --shell)"
#   eval "$(./scripts/export-preview-agent-env.sh helm --shell --target=external)"
#
# Reads from these in-namespace Secrets:
#   pawtograder-jwt              JWT bundle
#   pawtograder-postgres         POSTGRES_PASSWORD, PAWTOGRADER_PASSWORD
#   pawtograder-e2e              E2E + edge bypass tokens
#
# Intentionally NOT exported (integration credentials, not service-access
# credentials — agent shouldn't be able to act as the app to GitHub /
# AWS Chime / etc.):
#   pawtograder-edge-functions   GITHUB_APP_ID, GITHUB_PRIVATE_KEY_STRING,
#                                GITHUB_OAUTH_CLIENT_*, GITHUB_WEBHOOK_SECRET
#   pawtograder-s3               AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
#                                (storage backend + Chime API)

set -euo pipefail

if [ $# -lt 1 ] || [[ "${1:-}" =~ ^(-h|--help)$ ]]; then
  grep '^#' "$0" | sed 's/^# \?//'
  exit 0
fi

PREVIEW_ID="$1"; shift
mode=env
target=in-cluster
for arg in "$@"; do
  case "$arg" in
    --shell)             mode=shell ;;
    --env)               mode=env ;;
    --target=in-cluster) target=in-cluster ;;
    --target=external)   target=external ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

NS="pawtograder-preview-pr-${PREVIEW_ID}"
PREVIEW_DOMAIN="${PREVIEW_DOMAIN:-preview.pawtograder.net}"

command -v kubectl >/dev/null 2>&1 || { echo "missing dependency: kubectl" >&2; exit 1; }

if ! kubectl get namespace "$NS" >/dev/null 2>&1; then
  echo "namespace $NS not found — was the preview deployed?" >&2
  exit 1
fi

emit() {
  if [ "$mode" = shell ]; then
    printf 'export %s=%q\n' "$1" "${2:-}"
  else
    local value="${2:-}"
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    value="${value//$'\n'/\\n}"
    value="${value//$'\r'/\\r}"
    printf '%s="%s"\n' "$1" "$value"
  fi
}

field() {
  kubectl -n "$NS" get secret "$1" -o jsonpath="{.data.$2}" 2>/dev/null | base64 -d 2>/dev/null || true
}

# --- read secrets ------------------------------------------------------------
JWT_SECRET=$(field pawtograder-jwt JWT_SECRET)
ANON_KEY=$(field pawtograder-jwt ANON_KEY)
SERVICE_ROLE_KEY=$(field pawtograder-jwt SERVICE_ROLE_KEY)
JWT_PRIVATE_JWKS=$(field pawtograder-jwt JWT_PRIVATE_JWKS)
JWT_PUBLIC_JWKS=$(field pawtograder-jwt JWT_PUBLIC_JWKS)
JWT_REALTIME_JWKS=$(field pawtograder-jwt JWT_REALTIME_JWKS)

POSTGRES_PASSWORD=$(field pawtograder-postgres POSTGRES_PASSWORD)
PAWTOGRADER_PASSWORD=$(field pawtograder-postgres PAWTOGRADER_PASSWORD)

END_TO_END_SECRET=$(field pawtograder-e2e END_TO_END_SECRET)
EDGE_FUNCTION_SECRET=$(field pawtograder-e2e EDGE_FUNCTION_SECRET)

# --- compute URLs based on target -------------------------------------------
SVC="svc.cluster.local"
if [ "$target" = in-cluster ]; then
  WEB_URL="http://pawtograder-web.${NS}.${SVC}:3000"
  KONG_URL="http://pawtograder-kong.${NS}.${SVC}:8000"
  POSTGREST_URL="http://pawtograder-rest.${NS}.${SVC}:3000"
  AUTH_URL="http://pawtograder-auth.${NS}.${SVC}:9999"
  STORAGE_URL="http://pawtograder-storage.${NS}.${SVC}:5000"
  REALTIME_URL="ws://pawtograder-realtime.${NS}.${SVC}:4000/socket"
  EDGE_FUNCTIONS_URL="http://pawtograder-functions.${NS}.${SVC}:9000"
  PG_META_URL="http://pawtograder-meta.${NS}.${SVC}:8080"
  KONG_ADMIN_URL="http://pawtograder-kong.${NS}.${SVC}:8001"
  PG_HOST="pawtograder-postgres.${NS}.${SVC}"
  PG_PORT="5432"
else
  WEB_URL="https://pr-${PREVIEW_ID}.${PREVIEW_DOMAIN}"
  KONG_URL="https://api.pr-${PREVIEW_ID}.${PREVIEW_DOMAIN}"
  # All five collapse to the Kong URL — Kong's path-based routing
  # handles dispatch. Path prefixes:
  #   /rest/v1      → PostgREST
  #   /auth/v1      → GoTrue
  #   /storage/v1   → storage-api
  #   /realtime/v1  → realtime (websocket)
  #   /functions/v1 → edge-runtime
  # Direct-service URLs aren't reachable externally — Kong owns the edge.
  POSTGREST_URL="$KONG_URL"
  AUTH_URL="$KONG_URL"
  STORAGE_URL="$KONG_URL"
  # External Kong is always HTTPS, so a literal prefix swap is sufficient.
  REALTIME_URL="wss://${KONG_URL#https://}"
  EDGE_FUNCTIONS_URL="$KONG_URL"
  PG_META_URL=""
  KONG_ADMIN_URL=""
  # External Postgres: requires kubectl port-forward — use 127.0.0.1:5433
  # to match the convention in export-preview-env.sh. The agent will need
  # cluster credentials to set the port-forward up.
  PG_HOST="127.0.0.1"
  PG_PORT="5433"
fi

if [ "$mode" = env ]; then
  echo "# Generated by scripts/export-preview-agent-env.sh against namespace $NS"
  echo "# target=$target — URLs target $([ "$target" = in-cluster ] && echo "in-cluster Service DNS" || echo "public ingress")"
  echo
fi

emit NODE_ENV development
emit PAWTOGRADER_NAMESPACE "$NS"
emit PAWTOGRADER_AGENT_TARGET "$target"

# --- API surface ------------------------------------------------------------
emit NEXT_PUBLIC_PAWTOGRADER_WEB_URL "$WEB_URL"
emit NEXT_PUBLIC_SUPABASE_URL        "$KONG_URL"
emit NEXT_PUBLIC_SUPABASE_ANON_KEY   "$ANON_KEY"
emit SUPABASE_URL                    "$KONG_URL"
emit SUPABASE_ANON_KEY               "$ANON_KEY"
emit SUPABASE_SERVICE_ROLE_KEY       "$SERVICE_ROLE_KEY"

# --- Per-service URLs (same names across both targets — but external
# --- collapses them all onto Kong) ------------------------------------------
emit PAWTOGRADER_POSTGREST_URL       "$POSTGREST_URL"
emit PAWTOGRADER_AUTH_URL            "$AUTH_URL"
emit PAWTOGRADER_STORAGE_URL         "$STORAGE_URL"
emit PAWTOGRADER_REALTIME_URL        "$REALTIME_URL"
emit PAWTOGRADER_EDGE_FUNCTIONS_URL  "$EDGE_FUNCTIONS_URL"
# Only emit internal-only URLs when in-cluster — they aren't reachable externally.
[ -n "$PG_META_URL" ]    && emit PAWTOGRADER_PG_META_URL    "$PG_META_URL"
[ -n "$KONG_ADMIN_URL" ] && emit PAWTOGRADER_KONG_ADMIN_URL "$KONG_ADMIN_URL"

# --- JWT material -----------------------------------------------------------
emit JWT_SECRET           "$JWT_SECRET"
emit JWT_PRIVATE_JWKS     "$JWT_PRIVATE_JWKS"
emit JWT_PUBLIC_JWKS      "$JWT_PUBLIC_JWKS"
emit JWT_REALTIME_JWKS    "$JWT_REALTIME_JWKS"

# --- Postgres ---------------------------------------------------------------
emit PGHOST                "$PG_HOST"
emit PGPORT                "$PG_PORT"
emit PGUSER                "postgres"
emit PGDATABASE            "postgres"
emit PGPASSWORD            "$POSTGRES_PASSWORD"
emit PAWTOGRADER_DB_USER   "pawtograder"
emit PAWTOGRADER_PASSWORD  "$PAWTOGRADER_PASSWORD"
emit DATABASE_URL          "postgresql://postgres:${POSTGRES_PASSWORD}@${PG_HOST}:${PG_PORT}/postgres"
emit PAWTOGRADER_DB_URL    "postgresql://pawtograder:${PAWTOGRADER_PASSWORD}@${PG_HOST}:${PG_PORT}/postgres"

# --- E2E bypass tokens ------------------------------------------------------
emit END_TO_END_SECRET     "$END_TO_END_SECRET"
emit EDGE_FUNCTION_SECRET  "$EDGE_FUNCTION_SECRET"

if [ "$mode" = env ]; then
  if [ "$target" = in-cluster ]; then
    cat <<EOF

# In-cluster usage notes:
#   - All <svc>.${NS}.${SVC} names resolve from any pod in the cluster.
#   - Kong handles auth/rest/storage/realtime/functions path routing;
#     SUPABASE_URL is the recommended supabase-js entrypoint.
#   - For low-level debugging, hit each service directly via the
#     PAWTOGRADER_*_URL vars (skips Kong — no rate-limiting, no JWT
#     verification at the gateway, but the services still verify).
#   - Postgres connects directly: psql "\$DATABASE_URL"
#   - Storage objects are reachable through the storage API
#     (PAWTOGRADER_STORAGE_URL) using SERVICE_ROLE_KEY for admin paths
#     or ANON_KEY + user JWT for scoped paths. Direct MinIO creds are
#     intentionally not exported.
EOF
  else
    cat <<EOF

# External usage notes:
#   - SUPABASE_URL is the only externally-reachable endpoint. Kong
#     handles path routing for /rest/v1, /auth/v1, /storage/v1,
#     /realtime/v1, /functions/v1. All PAWTOGRADER_*_URL vars point
#     at it — direct-service URLs aren't exposed externally.
#   - PG_META_URL and KONG_ADMIN_URL are absent (internal-only).
#   - Postgres requires a kubectl port-forward:
#       kubectl -n $NS port-forward svc/pawtograder-postgres 5433:5432 &
#     Then connect with PGHOST=127.0.0.1 PGPORT=5433 (already set).
EOF
  fi
fi
