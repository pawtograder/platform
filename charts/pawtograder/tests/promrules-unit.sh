#!/usr/bin/env bash
# Behavioural tests for the queue alerting rules in templates/prometheus-rules.yaml.
#
# render-guardrails.sh asserts what those rules SAY. This asserts what they DO:
# it renders the chart, feeds the rendered PromQL to promtool along with
# synthetic series shaped like real incidents, and checks which alerts fire.
# The scenarios and the reasoning behind each are documented in
# promrules-unit.yaml — read that file, not this one, to understand the tests.
#
# Why this exists as well as the render assertions: the properties that matter
# here are all invertible without changing any string a grep would notice. The
# join operator can go from `unless` to `and` (which makes both critical alerts
# stop firing entirely whenever pawtograder_queue_depth is absent — every chart
# upgrade, until the edge functions roll), the floor can lose its minus sign
# (which suppresses every stalled queue instead of every draining one), the
# lookback can change. Each of those still renders, still parses, and still
# passes a text assertion. Only an evaluation catches them.
#
# Usage:  charts/pawtograder/tests/promrules-unit.sh
# Requires: helm 3.x, and promtool — either on PATH or via a container runtime
#           (docker/podman). The image tag is PINNED below: `latest` would let
#           an upstream PromQL change silently alter what these tests mean.
#
# Environment:
#   PROMETHEUS_IMAGE   override the pinned image
#   PROMRULES_STRICT   1 = a missing helm/promtool FAILS instead of skipping.
#                      Defaults to 1 whenever $CI is set. See "WHEN THE TOOLS
#                      ARE MISSING" below.

set -uo pipefail

CHART="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TESTS="$CHART/tests"
PROMETHEUS_IMAGE="${PROMETHEUS_IMAGE:-prom/prometheus:v3.1.0}"
FAILED=0

# WORK holds ONLY the files promtool must see; the whole directory is shipped
# into the container verbatim, so nothing else may land in it. SCRATCH is the
# harness's own space (tarball, logs, saved originals) and is never shipped.
WORK="$(mktemp -d)"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$WORK" "$SCRATCH"' EXIT
LOG="$SCRATCH/promtool.log"
TARBALL="$SCRATCH/rules.tar"

# The namespace must match the one in promrules-unit.yaml's input_series: the
# rules interpolate .Release.Namespace into every selector, so a mismatch makes
# every series miss and every test pass for the wrong reason.
NS=pawtograder

# Same production-shaped baseline as render-guardrails.sh, plus the monitoring
# flags needed to emit the PrometheusRule at all.
BASE=(
  --namespace "$NS"
  --set global.environment=production
  --set global.hostname=pawtograder.example.com
  --set postgres.persistence.storageClass=fast
  --set web.image.tag=v1.0.0
  --set edgeFunctions.image.tag=v1.0.0
  --set migrations.image.tag=v1.0.0
  --set backup.enabled=false
  --set storage.backend=file
  --set studio.enabled=false
  --set web.replicas=1
  --set monitoring.allowMissingWorkflowMetrics=true
  --set monitoring.enabled=true
  --set monitoring.prometheusRules.labels.release=kps
)

# ---------------------------------------------------------------------------
# WHEN THE TOOLS ARE MISSING
#
# This used to print "SKIP" and exit 0. That is wrong in CI, where the only
# visible result is a green step — a suite that never ran and a suite that
# passed look identical, which is the same silent-loss failure the alerting
# rules below are guarded against. So a skip is now loud, and in CI it is fatal
# by default. Override with PROMRULES_STRICT=0 if you genuinely want a soft
# skip on a runner without a container runtime.
# ---------------------------------------------------------------------------
STRICT="${PROMRULES_STRICT:-}"
if [ -z "$STRICT" ]; then
  if [ -n "${CI:-}" ]; then STRICT=1; else STRICT=0; fi
fi
case "$STRICT" in 0 | false | no | off) STRICT=0 ;; *) STRICT=1 ;; esac

did_not_run() {
  echo
  echo "############################################################"
  echo "#  THESE TESTS DID NOT RUN"
  echo "#  reason: $1"
  echo "#"
  echo "#  The queue alerting rules were NOT verified by this step."
  echo "#  Do not read the exit status below as a pass."
  echo "############################################################"
  echo
  if [ "$STRICT" -eq 1 ]; then
    echo "Failing: a step that could not run its tests must not report success."
    echo "Set PROMRULES_STRICT=0 to downgrade this to a soft skip."
    exit 1
  fi
  echo "PROMRULES_STRICT=0 and \$CI is unset, so exiting 0 — but nothing was checked."
  exit 0
}

command -v helm >/dev/null 2>&1 || did_not_run "helm is not on PATH"

PROMTOOL_MODE=""
RUNTIME=""
if command -v promtool >/dev/null 2>&1; then
  PROMTOOL_MODE=local
elif command -v docker >/dev/null 2>&1; then
  PROMTOOL_MODE=container
  RUNTIME=docker
elif command -v podman >/dev/null 2>&1; then
  PROMTOOL_MODE=container
  RUNTIME=podman
else
  did_not_run "no promtool on PATH and no docker/podman to supply one"
fi

# ---------------------------------------------------------------------------
# GETTING THE FILES TO PROMTOOL
#
# NOT a bind mount. The CI runner is itself a container, so `-v $TMPDIR:/w`
# resolves against the DOCKER HOST's filesystem, not the runner's, and the
# files are simply absent inside the container:
#
#   promtool: error: path 'rendered-rules.yaml' does not exist, try --help
#
# That is docker-in-docker and no amount of path fiddling fixes it. Streaming a
# tar over stdin needs no filesystem shared between runner and daemon, so it
# works in both topologies.
#
# Deliberately NOT written as `tar ... | docker run ...`: the status that must
# propagate is promtool's, and a pipeline's status can come from either side.
# The tarball is built first, its failure reported as a harness error, and the
# container run is then a plain command whose $? is promtool's exit code.
#
# The files are unpacked under /tmp, not /: the image runs as `nobody` and
# cannot create a directory at the filesystem root.
# ---------------------------------------------------------------------------
HARNESS_ERROR=125

promtool_run() {
  : >"$LOG"
  if [ "$PROMTOOL_MODE" = local ]; then
    (cd "$WORK" && promtool "$@") >"$LOG" 2>&1
    return $?
  fi
  if ! tar -C "$WORK" -cf "$TARBALL" . 2>"$SCRATCH/tar.err"; then
    {
      echo "HARNESS ERROR: could not tar the rendered rules out of $WORK"
      cat "$SCRATCH/tar.err"
    } >"$LOG"
    return "$HARNESS_ERROR"
  fi
  "$RUNTIME" run -i --rm --entrypoint sh "$PROMETHEUS_IMAGE" -c \
    'd=/tmp/promrules && mkdir -p "$d" && tar -C "$d" -xf - && cd "$d" && exec promtool "$@"' \
    promtool "$@" <"$TARBALL" >"$LOG" 2>&1
  return $?
}

# promtool takes a bare rules file (`groups:` at the top level), not a
# PrometheusRule CRD. Strip everything above `spec:` and dedent by two. No YAML
# parser is involved on purpose: this script's only hard dependency should be
# helm, exactly as render-guardrails.sh's is.
render_rules() {
  local out="$1"
  helm template pawtograder "$CHART" "${BASE[@]}" \
    --show-only templates/prometheus-rules.yaml 2>"$SCRATCH/helm.err" \
    | awk '/^spec:$/ { f = 1; next } f' | sed 's/^  //' > "$out"
  if [ ! -s "$out" ]; then
    echo "FAIL: could not render templates/prometheus-rules.yaml"
    sed 's/^/       /' "$SCRATCH/helm.err"
    return 1
  fi
  if ! head -1 "$out" | grep -q '^groups:$'; then
    echo "FAIL: rendered rules do not start with \`groups:\` — the spec-extraction"
    echo "       in render_rules() no longer matches helm's output shape."
    return 1
  fi
}

render_rules "$WORK/rendered-rules.yaml" || exit 1
cp "$TESTS/promrules-unit.yaml" "$WORK/promrules-unit.yaml"
cp "$WORK/rendered-rules.yaml" "$SCRATCH/rendered-rules.pristine"

echo "promtool: $PROMTOOL_MODE${RUNTIME:+ via $RUNTIME $PROMETHEUS_IMAGE}"
echo

# The fixtures and the rendered selectors have to agree on the namespace. If
# they drift, no series matches any selector, every "must not fire" expectation
# passes for the wrong reason, and the only tests that would notice are the ones
# that expect an alert. Checked directly rather than left to the reader.
for f in rendered-rules.yaml promrules-unit.yaml; do
  if ! grep -q "namespace=\"$NS\"" "$WORK/$f"; then
    echo "FAIL [namespace agreement]: $f has no namespace=\"$NS\" selector —"
    echo "       the fixtures and the rendered rules have drifted apart and the"
    echo "       negative expectations below would pass vacuously."
    FAILED=1
  fi
done

echo "== the rendered PromQL must parse =="
if promtool_run check rules rendered-rules.yaml; then
  cat "$LOG"
  echo "ok   [rendered rules parse]"
else
  echo "FAIL [rendered rules parse]"
  sed 's/^/       /' "$LOG"
  FAILED=1
fi

echo
echo "== the queue alerts must behave as documented =="
if promtool_run test rules promrules-unit.yaml; then
  cat "$LOG"
  echo "ok   [queue alert behaviour]"
else
  echo "FAIL [queue alert behaviour]"
  sed 's/^/       /' "$LOG"
  FAILED=1
fi

# ---------------------------------------------------------------------------
# PRECONDITION FOR THE NEGATIVE CONTROLS
#
# The controls assert that mutating the rules turns the suite red. If the suite
# is ALREADY red — a broken bind mount, a missing image, a bad render — then
# every control "passes" while confirming nothing, and the log reads as four
# green ticks on top of a suite that never evaluated anything. That happened:
# with the files absent inside the container, all four controls reported ok.
#
# A vacuous control is worse than a failing one, because it is quiet. So the
# controls do not run at all unless the unmutated suite is known good.
# ---------------------------------------------------------------------------
if [ "$FAILED" -ne 0 ]; then
  echo
  echo "ABORTING before the negative controls."
  echo "The unmutated suite did not pass, so a control reporting a failure would"
  echo "be reporting the broken harness, not the mutation — it would confirm"
  echo "nothing while looking like proof. Fix the failures above, then re-run."
  echo
  echo "PROMETHEUS RULE UNIT TESTS FAILED"
  exit 1
fi

# ---------------------------------------------------------------------------
# NEGATIVE CONTROLS
#
# A suite that cannot demonstrate it catches a break is decoration. Each control
# applies one plausible edit to the rendered rules and requires the suite to go
# red FOR ITS OWN REASON — the specific scenario that mutation should break,
# matched in promtool's output. A bare non-zero exit is not enough: any broken
# harness produces one, which is exactly how these controls went vacuous before.
#
# assert_control "<label>" "<sed script>" "<expected text in the failure>"
# ---------------------------------------------------------------------------
assert_control() {
  local label="$1" mutation="$2" want="$3"
  sed "$mutation" "$SCRATCH/rendered-rules.pristine" > "$SCRATCH/mutated.yaml"
  if cmp -s "$SCRATCH/rendered-rules.pristine" "$SCRATCH/mutated.yaml"; then
    echo "FAIL [$label]: the mutation matched nothing — this control is inert and"
    echo "       has been proving nothing since the rule text last changed."
    FAILED=1
    return
  fi
  cp "$SCRATCH/mutated.yaml" "$WORK/rendered-rules.yaml"

  promtool_run test rules promrules-unit.yaml
  local status=$?

  if [ "$status" -eq 0 ]; then
    echo "FAIL [$label]: the mutated rules still PASS — the scenarios above do"
    echo "       not actually pin this property."
    FAILED=1
  elif [ "$status" -eq "$HARNESS_ERROR" ]; then
    echo "FAIL [$label]: the harness itself errored, so this control proved nothing"
    sed 's/^/       /' "$LOG"
    FAILED=1
  elif ! grep -qF "$want" "$LOG"; then
    echo "FAIL [$label]: the suite went red, but NOT for the expected reason."
    echo "       wanted to see: $want"
    echo "       got:"
    sed 's/^/         /' "$LOG" | head -20
    FAILED=1
  else
    echo "ok   [$label]"
  fi

  cp "$SCRATCH/rendered-rules.pristine" "$WORK/rendered-rules.yaml"
}

echo
echo "== negative controls: these mutations MUST break the suite, each its own way =="

# The fail-open swap. With `and`, an absent pawtograder_queue_depth empties the
# whole expression and both critical alerts stop firing with no signal. This is
# the single most important control in the file. It must surface as the
# missing-depth-gauge scenario losing its alert.
assert_control "unless -> and is caught by the missing-depth-gauge scenario" \
  's/^\([[:space:]]*\)unless$/\1and/' \
  "async queue stuck still fires when the depth gauge is missing"

# The dropped minus sign. `< 2` is true for every queue that is not filling
# fast, so it suppresses the stalls instead of the healthy drains — the exact
# inversion of the intent, and still valid PromQL. It must surface as the
# stalled queue no longer paging.
assert_control "a dropped minus sign on the floor is caught by the stall scenario" \
  's/\* 60 < -/* 60 < /' \
  "a stalled async queue still pages"

# A floor far BELOW every real drain rate (-600 msg/min: nothing drains that
# fast) means the guard never matches and nothing is ever subtracted, so the
# rules revert to their pre-guard behaviour and the healthy release pages again
# — the original bug, restored. Note the expectation: this mutation does NOT
# break the stall scenario, because a stall is still supposed to page. Writing
# the control against "the suite went red" would have hidden that; matching the
# specific scenario is what surfaced it.
assert_control "a floor no real drain can reach is caught by the healthy-release scenario" \
  's/\* 60 < -2$/* 60 < -600/' \
  "healthy bulk release does not trip the async queue stuck alert"

# Dropping the DLQ / low-priority exclusion. Those queues sit ancient and
# motionless as their normal steady state, so without the matcher the age alert
# becomes a permanent critical and gets silenced — taking the live queues with
# it. This control also proves the exclusion scenario is not vacuous.
assert_control "removing the dlq/low-priority exclusion is caught by the exclusion scenario" \
  's/, queue!~"[.][*]_dlq|async_calls_low_priority"//g' \
  "dlq and low-priority queues stay excluded from the age alert"

echo
if [ "$FAILED" -ne 0 ]; then
  echo "PROMETHEUS RULE UNIT TESTS FAILED"
  exit 1
fi
echo "All Prometheus rule unit tests passed."
