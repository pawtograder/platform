#!/usr/bin/env bash
# Tunnel to a pawtograder environment's Postgres and run the supabase CLI / psql
# against it. The cluster Postgres is not exposed publicly, so this port-forwards
# svc/pawtograder-postgres and hands the tools an authenticated --db-url. The
# tunnel is torn down on exit.
#
# Usage (target defaults to staging):
#   scripts/supabase-db.sh db dump -f schema.sql        # npx supabase db dump …
#   scripts/supabase-db.sh --preview 815 db dump -f -   # against a preview env
#   scripts/supabase-db.sh --namespace pawtograder-staging migration list
#   scripts/supabase-db.sh --psql                       # interactive psql shell
#   scripts/supabase-db.sh --shell                      # subshell w/ $SUPABASE_DB_URL
#   scripts/supabase-db.sh --print-url                  # print URL, keep tunnel open
#
# Target selection: --env staging | --preview <id> | --namespace <ns>
# Optional: --port <local> (default 55432, to avoid clashing with a local
# supabase on 54322). These flags must come BEFORE the supabase args; everything
# after them (or after `--`) is passed to `npx supabase` verbatim with
# `--db-url <tunnel>` appended.
#
# Connects as the supabase_admin superuser to db "postgres".
# Requires: kubectl, jq, and npx (for supabase) or psql (for --psql).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/cluster-env.sh
. "${SCRIPT_DIR}/lib/cluster-env.sh"

PG_SVC="pawtograder-postgres"
PG_SECRET="pawtograder-postgres"
PG_USER="supabase_admin"
PG_DB="postgres"

env="" preview="" namespace="" localport=55432 mode=supabase
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --env)          env="$2"; shift 2 ;;
    --preview)      preview="$2"; shift 2 ;;
    --namespace|-n) namespace="$2"; shift 2 ;;
    --port)         localport="$2"; shift 2 ;;
    --psql)         mode=psql; shift ;;
    --shell)        mode=shell; shift ;;
    --print-url)    mode=url; shift ;;
    -h|--help)      grep '^#' "$0" | sed 's/^# \?//'; exit 0 ;;
    --)             shift; args+=("$@"); break ;;
    *)              args+=("$1"); shift ;;
  esac
done

require kubectl; require jq
[ "$mode" = psql ] && require psql
[ "$mode" = supabase ] && require npx

NAMESPACE="$(resolve_namespace "$env" "$preview" "$namespace")"
assert_namespace "$NAMESPACE"

PW="$(kubectl get secret "$PG_SECRET" -n "$NAMESPACE" -o jsonpath='{.data.POSTGRES_PASSWORD}' 2>/dev/null | base64 -d)"
[ -n "$PW" ] || { echo "could not read ${PG_SECRET}/POSTGRES_PASSWORD in ${NAMESPACE}" >&2; exit 1; }
PW_ENC="$(jq -rn --arg v "$PW" '$v|@uri')"

echo "==> port-forward ${NAMESPACE}/svc/${PG_SVC} -> 127.0.0.1:${localport}" >&2
kubectl port-forward -n "$NAMESPACE" "svc/${PG_SVC}" "${localport}:5432" >/dev/null 2>&1 &
PF_PID=$!
cleanup() { kill "$PF_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# Wait (≤10s) for the local port to start accepting connections.
up=0
for _ in $(seq 1 50); do
  if (exec 3<>"/dev/tcp/127.0.0.1/${localport}") 2>/dev/null; then exec 3>&- 3<&-; up=1; break; fi
  sleep 0.2
done
[ "$up" = 1 ] || { echo "tunnel to ${PG_SVC} never came up on :${localport}" >&2; exit 1; }

DB_URL="postgresql://${PG_USER}:${PW_ENC}@127.0.0.1:${localport}/${PG_DB}"

case "$mode" in
  url)
    echo "$DB_URL"
    echo "tunnel open (pid ${PF_PID}); Ctrl-C to close." >&2
    wait "$PF_PID"
    ;;
  psql)
    psql "$DB_URL"
    ;;
  shell)
    echo "Subshell with SUPABASE_DB_URL / PGURL set; 'exit' to close the tunnel." >&2
    SUPABASE_DB_URL="$DB_URL" PGURL="$DB_URL" "${SHELL:-bash}" -i
    ;;
  supabase)
    [ "${#args[@]}" -gt 0 ] || {
      echo "no supabase args (e.g. 'db dump -f schema.sql'); or use --psql / --shell / --print-url" >&2
      exit 2
    }
    npx supabase "${args[@]}" --db-url "$DB_URL"
    ;;
esac
