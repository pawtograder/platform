# shellcheck shell=bash
# Shared config for the managed -> self-hosted migration.
# Source this from the numbered scripts: `source "$(dirname "$0")/config.sh"`.
#
# Secrets are read at runtime (from the cluster and from platform/.env.local);
# nothing sensitive is hard-coded here. The only thing you must supply yourself
# is the DIRECT managed Postgres URL (see managed.env below).

set -euo pipefail

# --- Repo locations -----------------------------------------------------------
# This file lives in platform/scripts/migrate/. Resolve platform + prod-charts.
MIGRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLATFORM_DIR="$(cd "$MIGRATE_DIR/../.." && pwd)"
PROD_CHARTS_DIR="$(cd "$PLATFORM_DIR/../prod-charts" && pwd)"
WORK_DIR="${MIGRATE_DIR}/.work"      # dumps + csv land here (gitignored)
mkdir -p "$WORK_DIR"

# --- Self-hosted cluster ------------------------------------------------------
# Pin to the prod-charts kubeconfig. Do NOT inherit an ambient $KUBECONFIG —
# Jon's shell exports one pointing at a different cluster, and this migration
# must only ever touch the Pawtograder prod cluster. Override with MIGRATE_KUBECONFIG.
export KUBECONFIG="${MIGRATE_KUBECONFIG:-$PROD_CHARTS_DIR/kubeconfig}"
NS="${NS:-pawtograder-prod}"
RELEASE="${RELEASE:-pawtograder}"
SELF_API_URL="${SELF_API_URL:-https://api.pawtograder.khoury.northeastern.edu}"
LOCAL_PG_PORT="${LOCAL_PG_PORT:-5433}"   # local end of the port-forward

# --- Managed (source) ---------------------------------------------------------
# API url + service-role key come from platform/.env.local automatically.
# The DIRECT Postgres URL (dedicated IPv4, port 5432, NOT the pooler) you supply
# in scripts/migrate/managed.env (gitignored):
#     MANAGED_DB_URL=postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres?sslmode=require
if [[ -f "$MIGRATE_DIR/managed.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$MIGRATE_DIR/managed.env"; set +a
fi

# Managed API URL: DERIVE from the DB URL's project ref (db.<ref>.supabase.co →
# https://<ref>.supabase.co). We deliberately do NOT read .env.local here — after
# the migration it points at the SELF-HOSTED instance, which would make the
# storage copy run self->self (silent 100% failure). Override in managed.env.
if [[ -z "${MANAGED_API_URL:-}" && -n "${MANAGED_DB_URL:-}" ]]; then
  _mh="${MANAGED_DB_URL##*@}"; _mh="${_mh%%[:/]*}"; _mref="${_mh#db.}"; _mref="${_mref%%.*}"
  [[ -n "$_mref" ]] && MANAGED_API_URL="https://$_mref.supabase.co"
fi
# Service-role key CANNOT be derived — set it in managed.env:
#   MANAGED_SERVICE_ROLE_KEY=<managed project's service_role key, from the
#   Supabase dashboard → Project Settings → API>
MANAGED_SERVICE_ROLE_KEY="${MANAGED_SERVICE_ROLE_KEY:-}"

# --- Helpers to read cluster secrets on demand (never echoed) -----------------
k() { kubectl -n "$NS" "$@"; }
secret_val() { k get secret "$1" -o "jsonpath={.data.$2}" | base64 -d; }

# Superuser Postgres password (role `postgres`) for the load / session_replication_role.
self_pg_password()   { secret_val pawtograder-postgres POSTGRES_PASSWORD; }
# Self-hosted service-role JWT for the Storage API uploads.
self_service_role()  { secret_val pawtograder-jwt SERVICE_ROLE_KEY; }

# Auto-detect the PRIMARY in-cluster Postgres Service (override with DB_SVC=...).
# `|| true` so an early-closing `head` under pipefail+set -e can't abort the
# caller; excludes replica/exporter/meta so we land on the writable primary.
detect_db_svc() {
  if [[ -n "${DB_SVC:-}" ]]; then echo "$DB_SVC"; return; fi
  local out
  out=$(k get svc -o name 2>/dev/null \
    | grep -Ei 'supabase-db|postgres' \
    | grep -Evi 'meta|realtime|pooler|read|replica|exporter|exec' \
    | head -1) || true
  echo "$out"
}

# Primary Postgres POD (override with DB_POD=...). The wipe/load run inside the
# pod as the DB superuser, so we target the pod, not the Service.
detect_db_pod() {
  if [[ -n "${DB_POD:-}" ]]; then echo "$DB_POD"; return; fi
  local p
  p=$(k get pods -o name 2>/dev/null \
    | grep -iE 'postgres(-[0-9]+)?$' \
    | grep -Evi 'exporter|replica|read' \
    | head -1) || true
  echo "${p#pod/}"
}

# Run psql as the DB superuser (supabase_admin) over the pod's LOCAL socket.
# No password / port-forward: local peer/trust auth inside the pod. This is the
# only role that is superuser here (owns nothing in auth/public but bypasses
# ownership + RLS + can SET session_replication_role, which the load needs).
#
# Two variants because `kubectl exec -i` attaches stdin:
#   admin_psql  — STREAMS stdin to psql (`-i`). Use for piped/heredoc SQL.
#   admin_q     — one-off query, NO stdin (`-c`/`-tAc`), so it can't hang/drain.
_db_pod_checked() {
  local pod; pod="$(detect_db_pod)"
  [[ -n "$pod" ]] || { echo "no primary Postgres pod found in ns $NS (set DB_POD=)" >&2; return 1; }
  echo "$pod"
}
admin_psql() {
  local pod; pod="$(_db_pod_checked)" || return 1
  k exec -i "$pod" -c postgres -- psql -U supabase_admin -d postgres "$@"
}
admin_q() {
  local pod; pod="$(_db_pod_checked)" || return 1
  k exec "$pod" -c postgres -- psql -U supabase_admin -d postgres "$@" </dev/null
}

# Logical storage buckets to move (physical MinIO bucket is a single container).
BUCKETS="${BUCKETS:-avatars submission-files uploads}"

require() { command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1" >&2; exit 1; }; }
