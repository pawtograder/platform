#!/usr/bin/env bash
# Load test for Forgejo Actions: push N commits to M repos over T minutes, wait for every run
# to finish, then report queue wait (run started - run created) and job duration (stopped -
# started) from Forgejo's API. Use it to pick forgejoRunner.capacity before a real deadline.
#
# Usage: charts/pawtograder/tests/forgejo-actions-load.sh [options]
#   --url URL          Forgejo base URL (default $FORGEJO_URL). For an in-cluster install:
#                      kubectl -n <ns> port-forward svc/pawtograder-forgejo-http 3000:3000
#   --org ORG          org that holds the test repos, created if missing (default loadtest)
#   --repos M          number of repos, named <org>/load-001 ... (default 10)
#   --pushes N         total pushes, round-robin across the repos (default 50)
#   --minutes T        spread the pushes evenly over T minutes; 0 pushes back to back (default 5)
#   --job-seconds S    how long the built-in workflow's job sleeps (default 60)
#   --workflow FILE    install FILE as the workflow instead of the built-in one; it must run on
#                      push to main, and set concurrency.cancel-in-progress: false or Forgejo
#                      cancels a repo's earlier runs on each push
#   --runs-on LABEL    runs-on for the built-in workflow (default ubuntu-latest)
#   --capacity C       only for the plan: the runner capacity to estimate the queue against
#   --timeout MIN      stop waiting for runs after MIN minutes (default 180)
#   --out FILE         also write one TSV row per run (repo, sha, status, created, wait, duration)
#   --dry-run          print the plan and touch nothing (no URL or credentials needed)
#   --cleanup          delete <org>/load-* and exit
#
# Credentials: FORGEJO_TOKEN (scopes write:organization and write:repository), or
# FORGEJO_USER and FORGEJO_PASSWORD. Needs bash, curl and jq.
set -euo pipefail

URL=${FORGEJO_URL:-} ORG=loadtest REPOS=10 PUSHES=50 MINUTES=5 JOB_SECONDS=60 WORKFLOW=""
RUNS_ON=ubuntu-latest CAPACITY="" TIMEOUT=180 OUTFILE="" DRY=0 CLEANUP=0
usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit "${1:-0}"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL=$2; shift ;;
    --org) ORG=$2; shift ;;
    --repos) REPOS=$2; shift ;;
    --pushes) PUSHES=$2; shift ;;
    --minutes) MINUTES=$2; shift ;;
    --job-seconds) JOB_SECONDS=$2; shift ;;
    --workflow) WORKFLOW=$2; shift ;;
    --runs-on) RUNS_ON=$2; shift ;;
    --capacity) CAPACITY=$2; shift ;;
    --timeout) TIMEOUT=$2; shift ;;
    --out) OUTFILE=$2; shift ;;
    --dry-run) DRY=1 ;;
    --cleanup) CLEANUP=1 ;;
    -h|--help) usage ;;
    *) echo "unknown option $1" >&2; usage 2 ;;
  esac
  shift
done
for v in REPOS PUSHES MINUTES JOB_SECONDS TIMEOUT ${CAPACITY:+CAPACITY}; do
  case "${!v}" in ''|*[!0-9]*) echo "--$(tr 'A-Z_' 'a-z-' <<<"$v") must be a whole number" >&2; exit 2 ;; esac
done
[ "$REPOS" -gt 0 ] && [ "$PUSHES" -gt 0 ] || { echo "--repos and --pushes must be at least 1" >&2; exit 2; }
[ -z "$WORKFLOW" ] || [ -r "$WORKFLOW" ] || { echo "can't read $WORKFLOW" >&2; exit 2; }

repo_name() { printf 'load-%03d' "$1"; }
SPACING=$(awk -v t="$MINUTES" -v n="$PUSHES" 'BEGIN { printf "%.2f", t * 60 / n }')

plan() {
  echo "plan: $PUSHES pushes to $REPOS repos ($ORG/$(repo_name 1) ... $ORG/$(repo_name "$REPOS")) over $MINUTES min, one every ${SPACING}s"
  if [ -n "$WORKFLOW" ]; then echo "workflow: $WORKFLOW"; else echo "workflow: built-in, runs-on $RUNS_ON, sleeps ${JOB_SECONDS}s"; fi
  if [ -n "$CAPACITY" ] && [ "$CAPACITY" -gt 0 ]; then
    awk -v n="$PUSHES" -v c="$CAPACITY" -v j="$JOB_SECONDS" -v t="$MINUTES" 'BEGIN {
      drain = n * j / c; arrive = t * 60
      printf "estimate at capacity %d: %.1f job-minutes of work, ", c, n * j / 60
      if (drain > arrive) printf "queue grows; the last job finishes about %.1f min after the first push, having waited about %.1f min\n", (drain + j) / 60, (drain - arrive) / 60
      else printf "capacity keeps up; queue wait stays near the dispatcher poll interval\n"
    }'
  fi
}
plan
[ "$DRY" = 0 ] || exit 0

[ -n "$URL" ] || { echo "--url or FORGEJO_URL is required" >&2; exit 2; }
URL=${URL%/}
API="$URL/api/v1"
if [ -n "${FORGEJO_TOKEN:-}" ]; then AUTH=(-H "Authorization: token $FORGEJO_TOKEN")
elif [ -n "${FORGEJO_USER:-}" ] && [ -n "${FORGEJO_PASSWORD:-}" ]; then AUTH=(-u "$FORGEJO_USER:$FORGEJO_PASSWORD")
else echo "set FORGEJO_TOKEN, or FORGEJO_USER and FORGEJO_PASSWORD" >&2; exit 2; fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
BODY="$TMP/body"
api() {
  local args=(-sS --connect-timeout 10 --max-time 120 -o "$BODY" -w '%{http_code}' -H 'Content-Type: application/json' -X "$1")
  [ $# -lt 3 ] || args+=(--data-binary "$3")
  LAST="$1 $2"
  code=$(curl "${args[@]}" "${AUTH[@]}" "$API$2") || code=000
}
need() { case " $* " in *" $code "*) ;; *) echo "$LAST returned $code: $(head -c 300 "$BODY")" >&2; exit 1 ;; esac; }
b64() { base64 | tr -d '\n'; }

if [ "$CLEANUP" = 1 ]; then
  for i in $(seq 1 "$REPOS"); do
    api DELETE "/repos/$ORG/$(repo_name "$i")"; need 204 404
  done
  echo "deleted $ORG/load-001 ... $ORG/$(repo_name "$REPOS")"
  exit 0
fi

if [ -n "$WORKFLOW" ]; then WF=$(b64 <"$WORKFLOW"); else
  WF=$(printf '%s\n' \
    'name: load test' 'on:' '  push:' '    branches: [main]' \
    '# Without this, a push cancels the runs of earlier pushes to the branch, and grading needs every one.' \
    'concurrency:' '  cancel-in-progress: false' \
    'jobs:' '  grade:' "    runs-on: $RUNS_ON" '    steps:' \
    "      - run: sleep $JOB_SECONDS" | b64)
fi

echo "setting up $REPOS repos in $ORG"
api GET "/orgs/$ORG"; need 200 404
if [ "$code" = 404 ]; then api POST /orgs "$(jq -nc --arg o "$ORG" '{username: $o, visibility: "private"}')"; need 201; fi
for i in $(seq 1 "$REPOS"); do
  r="$ORG/$(repo_name "$i")"
  api GET "/repos/$r"; need 200 404
  if [ "$code" = 404 ]; then
    api POST "/orgs/$ORG/repos" "$(jq -nc --arg n "$(repo_name "$i")" '{name: $n, private: true, auto_init: true, default_branch: "main"}')"; need 201
  fi
  path=.forgejo/workflows/load.yml
  api GET "/repos/$r/contents/$path?ref=main"; need 200 404
  if [ "$code" = 200 ]; then
    [ "$(jq -r .content "$BODY" | tr -d '\n')" = "$WF" ] && continue
    api PUT "/repos/$r/contents/$path" "$(jq -nc --arg c "$WF" --arg s "$(jq -r .sha "$BODY")" '{content: $c, sha: $s, branch: "main", message: "load test workflow [skip ci]"}')"; need 200
  else
    api POST "/repos/$r/contents/$path" "$(jq -nc --arg c "$WF" '{content: $c, branch: "main", message: "load test workflow [skip ci]"}')"; need 201
  fi
done

PUSHED="$TMP/pushed"
: >"$PUSHED"
t0=$(date +%s)
echo "pushing"
for k in $(seq 1 "$PUSHES"); do
  due=$(awk -v t0="$t0" -v k="$k" -v s="$SPACING" 'BEGIN { printf "%.2f", t0 + (k - 1) * s }')
  now=$(date +%s)
  wait=$(awk -v d="$due" -v n="$now" 'BEGIN { w = d - n; if (w > 0) printf "%.2f", w; else print 0 }')
  [ "$wait" = 0 ] || sleep "$wait"
  r="$ORG/$(repo_name $(( (k - 1) % REPOS + 1 )))"
  api GET "/repos/$r/contents/push.txt?ref=main"; need 200 404
  content=$(printf 'push %d at %s\n' "$k" "$(date -u +%FT%TZ)" | b64)
  if [ "$code" = 200 ]; then
    api PUT "/repos/$r/contents/push.txt" "$(jq -nc --arg c "$content" --arg s "$(jq -r .sha "$BODY")" --arg m "load push $k" '{content: $c, sha: $s, branch: "main", message: $m}')"; need 200
  else
    api POST "/repos/$r/contents/push.txt" "$(jq -nc --arg c "$content" --arg m "load push $k" '{content: $c, branch: "main", message: $m}')"; need 201
  fi
  printf '%s\t%s\t%s\n' "$r" "$(jq -r .commit.sha "$BODY")" "$(date +%s)" >>"$PUSHED"
  [ $((k % 10)) -ne 0 ] || echo "  $k/$PUSHES pushed"
done

# Forgejo's timestamps may carry an offset; an epoch started/stopped means never.
# shellcheck disable=SC2016 # jq, not shell
JQ_TS='def ts: if . == null or startswith("0001-") or startswith("1970-") then null
  else sub("\\.[0-9]+"; "") | if endswith("Z") then fromdateiso8601
  else capture("^(?<d>.*)(?<s>[+-])(?<h>[0-9]{2}):(?<m>[0-9]{2})$") as $c
    | ($c.d + "Z" | fromdateiso8601) - (($c.s + "1" | tonumber) * (($c.h | tonumber) * 3600 + ($c.m | tonumber) * 60)) end end;'
RUNS="$TMP/runs.json"
deadline=$(( $(date +%s) + TIMEOUT * 60 ))
echo "waiting for $PUSHES runs"
while :; do
  echo '[]' >"$RUNS"
  while IFS= read -r r; do
    page=1
    while :; do
      api GET "/repos/$r/actions/runs?limit=50&page=$page"; need 200
      jq -c --arg r "$r" '[(.workflow_runs // [])[] | {repo: $r, sha: .commit_sha, status, created, started, stopped}]' "$BODY" >"$TMP/page"
      jq -s 'add' "$RUNS" "$TMP/page" >"$TMP/merged" && mv "$TMP/merged" "$RUNS"
      [ "$(jq length "$TMP/page")" -eq 50 ] || break
      page=$((page + 1))
    done
  done < <(cut -f1 "$PUSHED" | sort -u)
  jq -c --rawfile p "$PUSHED" '($p | split("\n") | map(select(length > 0) | split("\t")[1])) as $shas
    | map(select(.sha as $s | $shas | index($s)))' "$RUNS" >"$TMP/ours" && mv "$TMP/ours" "$RUNS"
  read -r total finished running waiting < <(jq -r '[length,
      (map(select(.status | IN("success", "failure", "cancelled", "skipped"))) | length),
      (map(select(.status == "running")) | length),
      (map(select(.status | IN("waiting", "blocked"))) | length)] | @tsv' "$RUNS")
  echo "  $(date -u +%T) runs: $total of $PUSHES created, $waiting waiting, $running running, $finished finished"
  [ "$finished" -lt "$PUSHES" ] || break
  if [ "$(date +%s)" -ge "$deadline" ]; then echo "timed out after $TIMEOUT min; reporting what finished" >&2; break; fi
  sleep 10
done

jq -r "$JQ_TS"'
  def pct($p): sort | .[((length - 1) * $p | floor)];
  def stats: if length == 0 then "n/a" else
    "min \(min)s  p50 \(pct(0.5))s  p90 \(pct(0.9))s  max \(max)s  mean \((add / length * 10 | round) / 10)s" end;
  map(. + {c: (.created | ts), s: (.started | ts), e: (.stopped | ts)}) as $all
  | ($all | map(select(.s != null and .e != null))) as $done
  | ($done | map(.s - .c)) as $wait
  | ($done | map(.e - .s)) as $dur
  | ([$done[] | [.s, 1], [.e, -1]] | sort | reduce .[] as $ev ({n: 0, peak: 0}; .n += $ev[1] | .peak = ([.peak, .n] | max)) | .peak) as $peak
  | "finished runs:    \($done | length) of \($all | length) (\($all | map(select(.status == "failure")) | length) failed)",
    "queue wait:       \($wait | stats)",
    "job duration:     \($dur | stats)",
    "peak concurrency: \($peak)",
    (if ($done | length) > 0 then "first run created to last run stopped: \((($done | map(.e) | max) - ($all | map(.c) | min)) / 60 * 10 | round / 10) min" else empty end)
' "$RUNS"

if [ -n "$OUTFILE" ]; then
  jq -r "$JQ_TS"'(["repo", "sha", "status", "created", "wait_s", "duration_s"] | @tsv),
    (.[] | [.repo, .sha, .status, .created,
            (if (.started | ts) then (.started | ts) - (.created | ts) else "" end),
            (if (.stopped | ts) and (.started | ts) then (.stopped | ts) - (.started | ts) else "" end)] | @tsv)' "$RUNS" >"$OUTFILE"
  echo "per-run rows: $OUTFILE"
fi
