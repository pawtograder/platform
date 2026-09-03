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
# Scope: by default this reads the two edge TIERS -- the request tier
#   (component=functions) and, when edgeFunctions.workerTier is enabled, the
#   background-worker tier (component=functions-workers). Deployment CHANNELS are
#   excluded on purpose: they run their own image tag, and neither output path
#   labels which stream a line came from, so including them answers "is my change
#   working?" with lines from a different build. To read one deliberately:
#     EDGE_LOG_COMPONENTS='functions-canary' scripts/edge-logs.sh --function X
#   The value is a LogQL/ERE alternation, so 'functions|functions-canary' works.
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
# Regex over the two TIERS, not an exact match and not a wildcard.
#
# Exact `component="functions"` silently omits every line from the four pgmq
# workers (component=functions-workers, chart: edgeFunctions.workerTier) --
# exactly the functions someone reaches for this tool to debug.
#
# But `functions(-.*)?` is too wide, and the extra it catches is worse than what
# it fixes: it also matches deployment CHANNELS (component=functions-<channel>),
# which run a DIFFERENT IMAGE TAG. values-staging.yaml ships a `canary` channel
# on `canary-<sha>` beside the two tiers on `staging-latest`, and neither output
# path shows which stream a line came from -- logcli runs with --no-labels and
# the curl+jq path projects only timestamp + line. So `--function X` would answer
# "is my change working?" with interleaved output from a build that does not
# contain the change, and nothing on screen would say so.
#
# Scoped to the two tiers instead, which is the same call the chart makes for
# metrics: templates/monitoring.yaml selects `component In (functions,
# functions-workers)` and says channels "are a whole-function-set A/B on their
# own host and out of scope here". A channel is still reachable by asking for it
# explicitly -- set EDGE_LOG_COMPONENTS.
EDGE_LOG_COMPONENTS="${EDGE_LOG_COMPONENTS:-functions|functions-workers}"
LOGQL="{namespace=\"${NAMESPACE}\", component=~\"${EDGE_LOG_COMPONENTS}\"}"
# The kubectl fallback must cover the SAME components as the LogQL selector
# above, or "logcli is not installed" silently becomes "some tiers are missing".
# kubectl has no regex label matching, so the component set is discovered from
# the cluster, filtered through the same EDGE_LOG_COMPONENTS pattern, and fed to
# an `in (...)` selector -- which keeps the two paths in step for whatever that
# variable is set to, including an override that widens it to a channel.
#
# Resolved lazily (only the fallback path needs it) so the normal Loki path costs
# no extra API call. `-l` also replaces `deploy/pawtograder-functions`, which
# hardcoded both the release name and the single-Deployment assumption.
edge_pod_selector() {
  local rows name components
  # DISCOVER the app.kubernetes.io/name value rather than hardcoding it, which is
  # what this did and is the trap docs/operations/disaster-recovery.md spells out
  # for its own fence: `pawtograder.name` is `default .Chart.Name .Values.nameOverride`,
  # so on an install that sets nameOverride the label is NOT "pawtograder" and a
  # fixed `-l app.kubernetes.io/name=pawtograder` matches nothing at all. The
  # fallback below could not rescue that either, because it still emitted the
  # hardcoded name -- so the tool printed no logs for a healthy fleet. The
  # NAMESPACE is already the scope here, so the component set alone identifies the
  # edge tiers; the name label is added only when the cluster says what it is.
  #
  # `|| true` is load-bearing, not defensive. Under `set -euo pipefail` a failed
  # kubectl propagates through the pipeline, and an assignment takes the
  # substitution's status -- so the script would exit HERE and never reach the
  # fallback below.
  rows="$( { kubectl get deploy -n "$NAMESPACE" \
      -o jsonpath='{range .items[*]}{.metadata.labels.app\.kubernetes\.io/name}{" "}{.metadata.labels.app\.kubernetes\.io/component}{"\n"}{end}' 2>/dev/null \
    | awk -v re="^(${EDGE_LOG_COMPONENTS})\$" '$2 ~ re { print }'; } || true)"
  name="$(printf '%s\n' "$rows" | awk 'NF { print $1; exit }')"
  components="$(printf '%s\n' "$rows" | awk 'NF { print $2 }' | sort -u | paste -sd, -)"
  # No Deployments found (wrong namespace, no RBAC): fall back to the two tiers
  # the chart always names, rather than emitting `in ()` which selects nothing.
  [ -z "$components" ] && components="$(printf '%s' "$EDGE_LOG_COMPONENTS" | tr '|' ',')"
  if [ -n "$name" ]; then
    echo "app.kubernetes.io/name=${name},app.kubernetes.io/component in (${components})"
  else
    echo "app.kubernetes.io/component in (${components})"
  fi
}

# `kubectl logs -l` REFUSES to run when the selector matches more pods than
# --max-log-requests, rather than tailing a subset -- so a limit that is merely
# "generous" is a hard failure, not degraded output. The old value of 10 was
# already marginal against staging/prod's 12 request replicas and became wrong
# the moment a second tier existed (12 + 2 = 14). Count the pods and ask for
# HEADROOM over that count, not the count itself: the count is one API call and
# the tail is another, so a surge pod appearing between them (maxSurge: 1 on both
# tiers, i.e. exactly during a deploy, which is when this tool gets used) would
# otherwise turn a tail into a hard refusal.
#
# Takes the selector as $1 so it is not recomputed: the caller resolves it once.
#
# No `|| echo 0` on the substitution. `wc -l` succeeds and prints "0" even when
# the kubectl before it fails, and pipefail then makes the group non-zero, so
# `|| echo 0` appended a SECOND line and the function returned two lines of "0"
# -- which `[ ... -lt ]` rejects as a non-integer and kubectl rejects as a flag
# value, breaking the very fallback the guard was written for. `|| true` inside
# the substitution is safe because `true` writes nothing.
edge_log_stream_limit() {
  local n
  n="$( { kubectl get pods -n "$NAMESPACE" -l "$1" --no-headers 2>/dev/null | wc -l; } || true)"
  # tr, not just ${n:-0}: BSD/macOS `wc -l` pads its output with leading spaces,
  # which would reach kubectl as `--max-log-requests=      14`.
  n="$(printf '%s' "${n:-0}" | tr -cd 0-9)"
  n=$(( ${n:-0} + 6 ))
  [ "$n" -lt 16 ] && n=16
  echo "$n"
}
[ -n "$function" ]  && LOGQL="${LOGQL} |= \"[fn=${function}]\""
[ -n "$grep_text" ] && LOGQL="${LOGQL} |= \"${grep_text}\""

# --follow with no logcli: fall back to live pod logs (no history, but no tunnel
# needed). grep the same tags so the UX matches.
if [ "$follow" -eq 1 ] && ! command -v logcli >/dev/null 2>&1; then
  echo "==> logcli not found; live-tailing pod stdout via kubectl (no history)" >&2
  # Resolve both once. edge_log_stream_limit used to call edge_pod_selector
  # itself, so each branch below issued the identical `kubectl get deploy` twice;
  # hoisting also guarantees the pod count was taken against the SAME selector
  # the tail then uses.
  SEL="$(edge_pod_selector)"
  MAXREQ="$(edge_log_stream_limit "$SEL")"
  # --prefix=TRUE, unlike the `deploy/...` form this replaced. That form resolved
  # to a single pod (kubectl GetFirstPod), so a prefix bought nothing; `-l` now
  # interleaves up to 14 streams across two tiers, and "which tier produced this
  # line?" is the first question docs/operations/incident-response.md tells a
  # responder to ask. Unprefixed output cannot answer it.
  pat="${function:+[fn=${function}]}"
  kubectl logs -f -l "$SEL" -n "$NAMESPACE" --max-log-requests="$MAXREQ" --prefix=true \
    | { [ -n "$pat" ] && grep --line-buffered -F "$pat" || cat; } \
    | { [ -n "$grep_text" ] && grep --line-buffered -F "$grep_text" || cat; }
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
