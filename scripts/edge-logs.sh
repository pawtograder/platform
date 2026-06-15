#!/usr/bin/env bash
# Tail/query edge-function logs from Loki, filtered BY function name.
#
# All ~49 functions share one pod's stdout behind the demuxer, but each line is
# tagged `[fn=<name>]` (by main.ts + _shared/HandlerUtils.ts), so this isolates a
# single function across all replicas + history. Loki has no external ingress, so
# this port-forwards svc/loki in the monitoring namespace and tears it down on exit.
#
# Usage (target defaults to staging):
#   scripts/edge-logs.sh --function autograder-create-submission
#   scripts/edge-logs.sh --preview 815 --function discord-async-worker --follow
#   scripts/edge-logs.sh --function grade-submission --since 6h --grep error
#   scripts/edge-logs.sh                       # all functions, last 1h
#
# Target: --env staging | --preview <id> | --namespace <ns>
# Filter: --function <name>  --grep <text>  --since <dur, e.g. 30m/6h/2d>  --limit <n>
#         --follow   (live tail)
#
# Requires: kubectl, jq. Uses `logcli` if installed (nicer paging/tail), else
# curl against the Loki HTTP API (and `kubectl logs -f` for --follow).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/cluster-env.sh
. "${SCRIPT_DIR}/lib/cluster-env.sh"

LOKI_NS="monitoring"
LOKI_SVC="loki"
LOKI_PORT=3100

env="" preview="" namespace="" function="" grep_text="" since="1h" limit=200 follow=0 localport=3100
while [ $# -gt 0 ]; do
  case "$1" in
    --env)          env="$2"; shift 2 ;;
    --preview)      preview="$2"; shift 2 ;;
    --namespace|-n) namespace="$2"; shift 2 ;;
    --function|-f)  function="$2"; shift 2 ;;
    --grep)         grep_text="$2"; shift 2 ;;
    --since)        since="$2"; shift 2 ;;
    --limit)        limit="$2"; shift 2 ;;
    --port)         localport="$2"; shift 2 ;;
    --follow)       follow=1; shift ;;
    -h|--help)      grep '^#' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

require kubectl; require jq
NAMESPACE="$(resolve_namespace "$env" "$preview" "$namespace")"
assert_namespace "$NAMESPACE"

# Build the LogQL stream selector + line filters.
LOGQL="{namespace=\"${NAMESPACE}\", component=\"functions\"}"
[ -n "$function" ]  && LOGQL="${LOGQL} |= \"[fn=${function}]\""
[ -n "$grep_text" ] && LOGQL="${LOGQL} |= \"${grep_text}\""

# --follow with no logcli: fall back to live pod logs (no history, but no tunnel
# needed). grep the same tags so the UX matches.
if [ "$follow" -eq 1 ] && ! command -v logcli >/dev/null 2>&1; then
  echo "==> logcli not found; live-tailing pod stdout via kubectl (no history)" >&2
  if [ -n "$function" ] || [ -n "$grep_text" ]; then
    pat="${function:+[fn=${function}]}"
    kubectl logs -f "deploy/pawtograder-functions" -n "$NAMESPACE" --max-log-requests=10 --prefix=false \
      | { [ -n "$pat" ] && grep --line-buffered -F "$pat" || cat; } \
      | { [ -n "$grep_text" ] && grep --line-buffered -F "$grep_text" || cat; }
  else
    kubectl logs -f "deploy/pawtograder-functions" -n "$NAMESPACE" --max-log-requests=10 --prefix=false
  fi
  exit 0
fi

# Otherwise query Loki. Open the tunnel; clean up on exit.
# Refuse to proceed if the port is already taken — otherwise the readiness probe
# below would "succeed" against an unrelated process and we'd query the wrong thing.
if (exec 9<>"/dev/tcp/127.0.0.1/${localport}") 2>/dev/null; then
  exec 9>&- 9<&-
  echo "local port ${localport} is already in use; pass --port <free-port>" >&2
  exit 1
fi
echo "==> port-forward ${LOKI_NS}/svc/${LOKI_SVC} -> 127.0.0.1:${localport}  (query: ${LOGQL})" >&2
kubectl port-forward -n "$LOKI_NS" "svc/${LOKI_SVC}" "${localport}:${LOKI_PORT}" >/dev/null 2>&1 &
PF_PID=$!
cleanup() { kill "$PF_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
up=0
for _ in $(seq 1 50); do
  if (exec 3<>"/dev/tcp/127.0.0.1/${localport}") 2>/dev/null; then exec 3>&- 3<&-; up=1; break; fi
  sleep 0.2
done
[ "$up" = 1 ] || { echo "Loki tunnel never came up on :${localport}" >&2; exit 1; }

ADDR="http://127.0.0.1:${localport}"

if command -v logcli >/dev/null 2>&1; then
  if [ "$follow" -eq 1 ]; then
    exec logcli --addr="$ADDR" query --tail "$LOGQL"
  fi
  exec logcli --addr="$ADDR" query --since="$since" --limit="$limit" --forward --no-labels "$LOGQL"
fi

# curl + jq path. Loki query_range wants ns timestamps; compute start from --since.
dur_to_secs() {
  local v="$1" n="${1%[smhd]}" u="${1: -1}"
  case "$u" in s) echo "$n";; m) echo $((n*60));; h) echo $((n*3600));; d) echo $((n*86400));; *) echo "$v";; esac
}
now_ns=$(date +%s)000000000
start_ns=$(( now_ns - $(dur_to_secs "$since") * 1000000000 ))

curl -sG "${ADDR}/loki/api/v1/query_range" \
  --data-urlencode "query=${LOGQL}" \
  --data "start=${start_ns}" --data "end=${now_ns}" \
  --data "limit=${limit}" --data "direction=backward" \
  | jq -r '
      .data.result[]?.values[]?
      | select((.[1] | gsub("\\s";"")) != "")          # drop blank lines
      | ((.[0][0:10] | tonumber | todate) + "  " + .[1]) # UTC ISO ts + line
    ' \
  | sort \
  | cat -s   # collapse the blank lines the functions emit between entries
