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
# NOT yet wired into .github/workflows/lint.yml, which runs render-guardrails.sh
# at the "helm guard-rail render tests" step. Add this alongside it.

set -uo pipefail

CHART="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TESTS="$CHART/tests"
PROMETHEUS_IMAGE="${PROMETHEUS_IMAGE:-prom/prometheus:v3.1.0}"
FAILED=0

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# A container promtool runs as a different uid; mktemp -d is 0700, so the bind
# mount would be unreadable and the run would fail as "permission denied" rather
# than as a test result.
chmod 0755 "$WORK"

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

# promtool takes a bare rules file (`groups:` at the top level), not a
# PrometheusRule CRD. Strip everything above `spec:` and dedent by two. No YAML
# parser is involved on purpose: this script's only hard dependency should be
# helm, exactly as render-guardrails.sh's is.
render_rules() {
  local out="$1"
  helm template pawtograder "$CHART" "${BASE[@]}" \
    --show-only templates/prometheus-rules.yaml 2>"$WORK/helm.err" \
    | awk '/^spec:$/ { f = 1; next } f' | sed 's/^  //' > "$out"
  if [ ! -s "$out" ]; then
    echo "FAIL: could not render templates/prometheus-rules.yaml"
    sed 's/^/       /' "$WORK/helm.err"
    return 1
  fi
  if ! head -1 "$out" | grep -q '^groups:$'; then
    echo "FAIL: rendered rules do not start with \`groups:\` — the spec-extraction"
    echo "       in render_rules() no longer matches helm's output shape."
    return 1
  fi
}

# promtool, from PATH if it is there and from a pinned container image if not.
promtool_run() {
  if command -v promtool >/dev/null 2>&1; then
    (cd "$WORK" && promtool "$@")
  elif command -v docker >/dev/null 2>&1; then
    docker run --rm -u "$(id -u):$(id -g)" --entrypoint promtool \
      -v "$WORK:/w" -w /w "$PROMETHEUS_IMAGE" "$@"
  elif command -v podman >/dev/null 2>&1; then
    podman run --rm --entrypoint promtool \
      -v "$WORK:/w" -w /w "$PROMETHEUS_IMAGE" "$@"
  else
    echo "promtool not found, and no docker/podman to run $PROMETHEUS_IMAGE with" >&2
    return 127
  fi
}

if ! command -v helm >/dev/null 2>&1; then
  echo "SKIP: helm not on PATH"
  exit 0
fi
if ! command -v promtool >/dev/null 2>&1 \
  && ! command -v docker >/dev/null 2>&1 \
  && ! command -v podman >/dev/null 2>&1; then
  echo "SKIP: no promtool and no container runtime to supply one"
  exit 0
fi

render_rules "$WORK/rendered-rules.yaml" || exit 1
cp "$TESTS/promrules-unit.yaml" "$WORK/promrules-unit.yaml"
chmod 0644 "$WORK"/*.yaml

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
  echo "ok   [rendered rules parse]"
else
  echo "FAIL [rendered rules parse]"
  FAILED=1
fi

echo
echo "== the queue alerts must behave as documented =="
if promtool_run test rules promrules-unit.yaml; then
  echo "ok   [queue alert behaviour]"
else
  echo "FAIL [queue alert behaviour]"
  FAILED=1
fi

# NEGATIVE CONTROLS.
#
# A suite that cannot demonstrate it catches a break is decoration. Each control
# applies one plausible edit to the rendered rules and asserts the suite goes
# red. If a control ever passes, the tests above have stopped testing anything —
# which is a louder failure than a red test, because it is silent.
#
# assert_control "<label>" "<sed script>" — mutate, expect `test rules` to FAIL.
assert_control() {
  local label="$1" mutation="$2"
  sed "$mutation" "$WORK/rendered-rules.yaml" > "$WORK/mutated.yaml"
  if cmp -s "$WORK/rendered-rules.yaml" "$WORK/mutated.yaml"; then
    echo "FAIL [$label]: the mutation changed nothing — this control is inert"
    FAILED=1
    return
  fi
  mv "$WORK/rendered-rules.yaml" "$WORK/rendered-rules.yaml.keep"
  mv "$WORK/mutated.yaml" "$WORK/rendered-rules.yaml"
  chmod 0644 "$WORK/rendered-rules.yaml"
  if promtool_run test rules promrules-unit.yaml >/dev/null 2>&1; then
    echo "FAIL [$label]: the mutated rules still PASS — the tests above do not"
    echo "       actually pin this property"
    FAILED=1
  else
    echo "ok   [$label]"
  fi
  mv "$WORK/rendered-rules.yaml.keep" "$WORK/rendered-rules.yaml"
}

echo
echo "== negative controls: these mutations MUST break the suite =="

# The fail-open swap. With `and`, an absent pawtograder_queue_depth empties the
# whole expression and both critical alerts stop firing with no signal. This is
# the single most important control in the file.
assert_control "unless -> and is caught" \
  's/^\([[:space:]]*\)unless$/\1and/'

# The dropped minus sign. `< 2` is true for every queue that is not filling
# fast, so it suppresses the stalls instead of the healthy drains — the exact
# inversion of the intent, and still valid PromQL.
assert_control "a dropped minus sign on the floor is caught" \
  's/\* 60 < -/* 60 < /'

# A floor far above any real drain rate suppresses everything, including the
# 2026-09-07 stall the rule exists to catch.
assert_control "a floor above every real drain rate is caught" \
  's/\* 60 < -2$/* 60 < -600/'

# Dropping the DLQ / low-priority exclusion. Those queues sit ancient and
# motionless as their normal steady state, so without the matcher the age alert
# becomes a permanent critical and gets silenced — taking the live queues with
# it. This control also proves the exclusion scenario above is not vacuous.
assert_control "removing the dlq/low-priority exclusion is caught" \
  's/, queue!~"[.][*]_dlq|async_calls_low_priority"//g'

echo
if [ "$FAILED" -ne 0 ]; then
  echo "PROMETHEUS RULE UNIT TESTS FAILED"
  exit 1
fi
echo "All Prometheus rule unit tests passed."
