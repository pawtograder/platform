#!/usr/bin/env bash
# Guard-rail render tests for charts/pawtograder/templates/validations.yaml.
#
# PRODUCTION-READINESS §4 hardened the chart to REFUSE a `helm template`/install
# whose values combination is dangerous in a durable environment (e2e bypasses,
# plaintext/non-recoverable secrets, seeding, resetOnDrift, floating image tags,
# an unauthenticated Studio ingress). Those guards are the safety net that keeps
# a staging-shaped values file from reaching prod — this script asserts they
# actually fire, so a refactor of validations.yaml can't silently disarm them.
#
# Each case renders the chart with a clean production baseline plus one
# dangerous override, and asserts the render FAILS with the expected message.
# It also asserts the clean baseline renders, and that ephemeral tiers still
# permit the flags a durable tier refuses.
#
# Usage:  charts/pawtograder/tests/render-guardrails.sh
# Requires: helm 3.x on PATH. Run from anywhere (paths are resolved below).

set -uo pipefail

CHART="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILED=0
ERRFILE="$(mktemp)"
trap 'rm -f "$ERRFILE"' EXIT

# A production values set that renders clean. Each guard test adds ONE
# dangerous override on top so the only reason a render can fail is that guard.
BASE=(
  --set global.environment=production
  --set global.hostname=pawtograder.example.com
  --set postgres.persistence.storageClass=fast
  --set web.image.tag=v1.0.0
  --set edgeFunctions.image.tag=v1.0.0
  --set migrations.image.tag=v1.0.0
  --set backup.enabled=false
  --set storage.backend=file
  --set studio.enabled=false
)

render() { helm template t "$CHART" "${BASE[@]}" "$@" >/dev/null 2>"$ERRFILE"; }

# assert_refused "<label>" "<expected substring>" <extra --set args...>
assert_refused() {
  local label="$1" want="$2"; shift 2
  if render "$@"; then
    echo "FAIL [$label]: render SUCCEEDED but the guard should have refused it"
    FAILED=1
  elif ! grep -qF "$want" "$ERRFILE"; then
    echo "FAIL [$label]: refused, but message missing expected text: $want"
    echo "       got: $(grep -oiE 'Error:.*' "$ERRFILE" | head -1)"
    FAILED=1
  else
    echo "ok   [$label]"
  fi
}

# assert_renders "<label>" <extra --set args...>
assert_renders() {
  local label="$1"; shift
  if render "$@"; then
    echo "ok   [$label]"
  else
    echo "FAIL [$label]: render was REFUSED but should have succeeded"
    echo "       got: $(grep -oiE 'Error:.*' "$ERRFILE" | head -1)"
    FAILED=1
  fi
}

echo "== baseline =="
assert_renders "clean production baseline renders"

echo "== any-environment guards =="
assert_refused "invalid environment value" \
  "global.environment must be one of" --set global.environment=bogus
assert_refused "metrics leader on multi-replica web" \
  "web.workflowMetricsLeader requires web.replicas=1" \
  --set web.workflowMetricsLeader=true --set web.replicas=2
assert_refused "studio ingress without auth" \
  "exposes full database control" \
  --set studio.enabled=true --set studio.ingressEnabled=true
assert_refused "replica without wal-g" \
  "requires postgres.walg.enabled=true" \
  --set postgres.replica.enabled=true --set postgres.replica.persistence.storageClass=lp

echo "== staging + production guards =="
assert_refused "secrets.create in production" \
  "renders plaintext secret material" --set secrets.create=true
assert_refused "resetOnDrift in production" \
  "DESTROYS ALL APPLICATION DATA" --set migrations.resetOnDrift=true

echo "== production-only guards =="
assert_refused "web e2e bypass" \
  "enable privileged test-only code paths" --set web.e2e.enabled=true
assert_refused "edge e2e mockGitHub" \
  "enable privileged test-only code paths" --set edgeFunctions.e2e.mockGitHub=true
assert_refused "secrets.autogenerate" \
  "non-recoverable key material" --set secrets.autogenerate=true
assert_refused "seed enabled" \
  "loads demo classes" --set seed.enabled=true
assert_refused "floating web image tag (latest)" \
  "is a floating tag" --set web.image.tag=latest
assert_refused "floating edge image tag (-latest suffix)" \
  "is a floating tag" --set edgeFunctions.image.tag=canary-latest

echo "== ephemeral tiers still permit what durable tiers refuse =="
# resetOnDrift is a legitimate dev/preview convenience; the guard must NOT fire
# there. (migrate.sh independently re-checks the tier at runtime.)
assert_renders "resetOnDrift allowed on dev" \
  --set global.environment=dev --set migrations.resetOnDrift=true
assert_renders "seed allowed on dev" \
  --set global.environment=dev --set seed.enabled=true

echo
if [ "$FAILED" -ne 0 ]; then
  echo "GUARD-RAIL TESTS FAILED"
  exit 1
fi
echo "All guard-rail render tests passed."
