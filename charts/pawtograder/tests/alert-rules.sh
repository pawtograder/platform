#!/usr/bin/env bash
# Alert-rule tests for charts/pawtograder/templates/prometheus-rules.yaml.
#
# WHY THIS EXISTS SEPARATELY FROM render-guardrails.sh. That script proves the
# chart REFUSES dangerous values; this one proves the alerts it ships actually
# FIRE. Those are different failure modes and only one of them was covered.
# `helm lint` and `promtool check rules` both pass on a rule whose expression is
# permanently inert — a selector on a metric that does not exist, an `absent()`
# arm that never evaluates, a comparison against an empty vector that yields
# silence instead of an alert. Syntax checking cannot see any of those, and a
# silently-inert alert is worse than a missing one because it looks shipped.
#
# `promtool test rules` is the only thing that can: it feeds synthetic series
# into the real expressions and asserts on what fires and when. Two of this
# chart's worker-tier rules are built on exactly the shapes that need it —
# `... or absent(...)` and `(... or vector(0)) == 0 and ... > 0` — and both were
# refactored through new helpers in the same change that added them.
#
# The rules are TEMPLATED, so the tests cannot point at a file in the repo:
# every run renders the chart first and unit-tests the rendered output. That is
# deliberate — it tests what would actually be installed, including the values
# interpolated into the expressions, rather than a hand-copied approximation
# that can drift from the template.
#
# Usage:  charts/pawtograder/tests/alert-rules.sh
# Requires: helm 3.x and promtool on PATH. Run from anywhere.

set -uo pipefail

CHART="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TESTS="$CHART/tests/alerts"
FAILED=0
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

for tool in helm promtool; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "FAIL: $tool is not on PATH"
    exit 1
  fi
done

# The rendered rule set the tests run against. Everything that gates a rule is
# turned ON, so `promtool check rules` sees every expression the chart can emit
# rather than the subset a default render happens to produce; a syntax error in
# a rule that only appears with wal-g or a replica enabled would otherwise ship.
# Release name `t` and namespace `default` are what the expressions interpolate,
# so the test fixtures' series labels must match — see tests/alerts/*.test.yaml.
#
# `--namespace default` is PINNED and load-bearing, not decoration. Six rules in
# prometheus-rules.yaml interpolate .Release.Namespace into their expressions,
# and `helm template` with no --namespace resolves it from the ambient kube
# context rather than defaulting to "default". On a workstation with no context
# that happens to BE "default", so this suite passed locally and failed only in
# CI, where the runner is itself a pod: the expressions came out selecting
# namespace="arc-runners-pawtograder", matched none of the fixtures' series, and
# eight assertions failed with `got: nil` -- looking like broken rules rather
# than a broken harness. Without the pin the suite's result depends on whoever
# runs it.
render_rules() {
  helm template t "$CHART" \
    --namespace default \
    --set monitoring.enabled=true \
    --set monitoring.prometheusRules.labels.release=kps \
    --set edgeFunctions.workerTier.enabled=true \
    --set backup.enabled=true \
    --set backup.s3.endpoint=https://s3.example.com \
    --set backup.s3.bucket=b \
    --set postgres.walg.enabled=true \
    --set postgres.walg.s3Prefix=s3://b/walg \
    --set postgres.replica.enabled=true \
    --set postgres.replica.persistence.storageClass=lp \
    --show-only templates/prometheus-rules.yaml "$@"
}

# Strip the PrometheusRule CRD wrapper down to the bare `groups:` document
# promtool understands, by slicing from `spec.groups` to EOF and dedenting one
# level. Done with sed rather than a YAML library on purpose: this runs in CI
# next to `helm lint`, and adding a Python/PyYAML dependency to a shell test
# that already has helm and promtool is a third thing that can break the job.
# Safe because `groups` is the last key in the document — asserted below rather
# than assumed, since a later template edit that appends a sibling key under
# `spec:` would otherwise silently truncate the rule set being tested.
extract_groups() {
  local crd="$1" out="$2"
  if ! grep -q '^  groups:' "$crd"; then
    echo "FAIL: rendered PrometheusRule has no 'spec.groups' at the expected indent"
    return 1
  fi
  if awk 'f && /^  [a-zA-Z]/ { found=1 } /^  groups:/ { f=1 } END { exit !found }' "$crd"; then
    echo "FAIL: a key follows 'spec.groups' in the rendered CRD, so this extraction"
    echo "      would silently drop rules. Update extract_groups in $0."
    return 1
  fi
  sed -n '/^  groups:/,$p' "$crd" | sed 's/^  //' >"$out"
}

echo "== render and syntax-check the shipped rules =="
if ! render_rules >"$WORK/crd.yaml" 2>"$WORK/err"; then
  echo "FAIL: rendering templates/prometheus-rules.yaml failed"
  sed -n '1,5p' "$WORK/err"
  exit 1
fi
if ! extract_groups "$WORK/crd.yaml" "$WORK/rules.yaml"; then
  exit 1
fi
if promtool check rules "$WORK/rules.yaml" >"$WORK/check.out" 2>&1; then
  echo "ok   [promtool check rules] $(grep -oE '[0-9]+ rules found' "$WORK/check.out" | head -1)"
else
  echo "FAIL [promtool check rules]"
  cat "$WORK/check.out"
  FAILED=1
fi

# promtool resolves `rule_files:` relative to the TEST file, so the fixtures and
# the rendered rules have to sit in one directory. The fixtures declare
# `rule_files: [rules.yaml]` and are copied next to the render.
echo "== unit-test the alert expressions =="
shopt -s nullglob
fixtures=("$TESTS"/*.test.yaml)
if [ ${#fixtures[@]} -eq 0 ]; then
  echo "FAIL: no *.test.yaml fixtures found in $TESTS"
  exit 1
fi
for f in "${fixtures[@]}"; do
  cp "$f" "$WORK/"
done
for f in "${fixtures[@]}"; do
  name="$(basename "$f")"
  # promtool prints nothing per-unit on success, so the count comes from the
  # fixture. Reported because "SUCCESS" on a fixture that silently stopped being
  # parsed as tests would otherwise look identical to a real pass.
  # `grep -c` exits 1 on zero matches and this script has no `set -e`, so a
  # fixture that stopped being parsed as tests would report "ok [x] 0 units
  # passed" and leave the job green with no alert coverage at all -- the
  # silently-inert failure this whole suite exists to close, reappearing one
  # level up in the harness. Zero units is therefore a FAILURE, not a count.
  units="$(grep -cE '^  - interval:' "$f" || true)"
  if [ "${units:-0}" -eq 0 ]; then
    echo "FAIL [$name]: no test units found (no '^  - interval:' entries)."
    echo "      promtool exits 0 on a fixture with nothing to run, so this would"
    echo "      otherwise pass with zero coverage. Check the fixture's indentation."
    FAILED=1
    continue
  fi
  if promtool test rules "$WORK/$name" >"$WORK/test.out" 2>&1; then
    echo "ok   [$name] $units units passed"
  else
    echo "FAIL [$name]"
    cat "$WORK/test.out"
    FAILED=1
  fi
done

echo
if [ "$FAILED" -ne 0 ]; then
  echo "ALERT-RULE TESTS FAILED"
  exit 1
fi
echo "All alert-rule tests passed."
