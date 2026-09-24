#!/usr/bin/env bash
# Postgres-restart version gate.
#
# A chart change that restarts Postgres must bump the chart's MINOR (or major)
# version. Patch releases promise the database stays up. This script enforces
# that by rendering the chart at a base ref and at the working tree and
# comparing the parts of the Postgres StatefulSets whose change rolls a pod.
#
# The base ref is `main`, the branch production deploys from -- NOT the PR's
# base branch. The promise is about what production will do on its next
# upgrade. Measured against staging, backing out an unreleased restart looks
# like a restart of its own, and a second restarting change on top of an
# unreleased 0.4.0 looks like it needs 0.5.0; measured against main, the first
# is correctly nothing and the second rides the same window.
#
# Compared:
#
#   .spec.template              -- pod spec, volumes, and the checksum/config
#                                  annotation (postgres-config.yaml +
#                                  postgres-exporter-queries.yaml)
#   .spec.volumeClaimTemplates  -- immutable; a change here is a
#                                  delete-and-recreate, which is worse
#
# for the primary (postgres-statefulset.yaml) and the standby
# (postgres-replica.yaml). If either differs under any values set below and the
# version bump is only a patch (or nothing), it fails.
#
# Why this exists: #1021 shipped a /dev/shm volume on the primary as
# 0.3.26 -> 0.3.27. The version said "routine"; the deploy needed a
# maintenance window. See docs/operations/planned-maintenance.md
# ("Chart versions and Postgres restarts").
#
# Usage:  charts/pawtograder/tests/postgres-restart-gate.sh <base-ref>
#         (CI passes origin/main; locally, e.g. ghhttps/main)
# Requires: helm 3.x, git, awk. Run from anywhere inside the repo.

set -uo pipefail

BASE_REF="${1:?usage: $0 <base-ref>}"
# PGATE_CHART overrides the chart path (for testing a copy of this script).
CHART="${PGATE_CHART:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
REPO="$(git -C "$CHART" rev-parse --show-toplevel)"
CHART_REL="${CHART#"$REPO"/}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if ! git -C "$REPO" rev-parse --verify --quiet "$BASE_REF^{commit}" >/dev/null; then
  echo "postgres-restart-gate: base ref '$BASE_REF' is not available (shallow checkout? use fetch-depth: 0)" >&2
  exit 2
fi
mkdir -p "$TMP/base"
if ! git -C "$REPO" archive "$BASE_REF" "$CHART_REL" | tar -x -C "$TMP/base"; then
  echo "postgres-restart-gate: could not extract $CHART_REL at $BASE_REF" >&2
  exit 2
fi
BASE_CHART="$TMP/base/$CHART_REL"

chart_version() { awk '/^version:/ {gsub(/["'\'']/, "", $2); print $2; exit}' "$1/Chart.yaml"; }
BASE_VER="$(chart_version "$BASE_CHART")"
HEAD_VER="$(chart_version "$CHART")"
semver='^[0-9]+\.[0-9]+\.[0-9]+'
if ! [[ "$BASE_VER" =~ $semver && "$HEAD_VER" =~ $semver ]]; then
  echo "postgres-restart-gate: could not read chart versions (base '$BASE_VER', head '$HEAD_VER')" >&2
  exit 2
fi

# Values sets. Taken from the HEAD tree and used for BOTH renders, so the only
# thing that differs is the chart. The prod examples need two values the
# guard-rails demand but the example leaves for the operator (image tags,
# storage class, WAL-G prefix, backup endpoint, the ruleSelector label); they are pinned to fixed strings so they cannot
# introduce a diff.
EX="$CHART/examples"
PROD_FIXUPS=(
  --set monitoring.prometheusRules.labels.release=prometheus
  --set postgres.persistence.storageClass=gate
  --set postgres.walg.s3Prefix=s3://gate/wal-g
  --set backup.s3.endpoint=https://s3.gate.invalid
)
for img in web edgeFunctions migrations backup; do PROD_FIXUPS+=(--set "$img.image.tag=v0.0.0-gate"); done
CASES=(
  "staging|-f $EX/values-staging.yaml"
  "preview|-f $EX/values-preview.yaml"
  "tartangrader|-f $EX/values-tartangrader.yaml"
  "prod|-f $EX/values-prod.yaml ${PROD_FIXUPS[*]}"
  "prod-noeso|-f $EX/values-prod-noeso.yaml ${PROD_FIXUPS[*]}"
)
TEMPLATES=(postgres-statefulset.yaml postgres-replica.yaml)

# Print the restart-relevant blocks of every StatefulSet in a rendered file:
# the 2-space-indented `template:` and `volumeClaimTemplates:` keys under spec,
# each up to the next 2-space key or document end. Chart-version labels are
# dropped: they change on every bump and are not what rolls the pod here (the
# pod template uses version-free labels; stripping keeps the gate honest if
# that ever regresses, since a label-only roll is the bump's own doing).
extract() {
  awk '
    /^---/                { in_ss=0; keep=0; next }
    /^kind: StatefulSet/  { in_ss=1; next }
    !in_ss                { next }
    /^  [A-Za-z]/         { keep = ($0 ~ /^  (template|volumeClaimTemplates):/) }
    /^[A-Za-z]/           { keep=0 }
    keep && $0 !~ /(helm\.sh\/chart|app\.kubernetes\.io\/version):/ { print }
  '
}

# render <chart> <template> <args...>: rendered blocks on stdout; exit 1 if
# the chart fails to render. A template that renders to nothing (replica
# disabled) makes helm say "could not find template" -- that is an empty
# result, not a failure.
render() {
  local chart="$1" tpl="$2"; shift 2
  local out err
  err="$TMP/err"
  if out="$(helm template t "$chart" "$@" --show-only "templates/$tpl" 2>"$err")"; then
    printf '%s\n' "$out" | extract
    return 0
  fi
  grep -q "could not find template" "$err" && return 0
  return 1
}

RESTARTS=()
SKIPPED=()
CHECKED=0
for c in "${CASES[@]}"; do
  label="${c%%|*}"
  # shellcheck disable=SC2206  # word-splitting the args string is the intent
  args=(${c#*|})
  for tpl in "${TEMPLATES[@]}"; do
    if ! render "$CHART" "$tpl" "${args[@]}" >"$TMP/head.txt"; then
      SKIPPED+=("$label/$tpl: HEAD does not render ($(head -c 160 "$TMP/err" | tr '\n' ' '))")
      continue
    fi
    if ! render "$BASE_CHART" "$tpl" "${args[@]}" >"$TMP/base.txt"; then
      SKIPPED+=("$label/$tpl: base does not render with HEAD's values ($(head -c 160 "$TMP/err" | tr '\n' ' '))")
      continue
    fi
    CHECKED=$((CHECKED + 1))
    if ! diff -q "$TMP/base.txt" "$TMP/head.txt" >/dev/null; then
      RESTARTS+=("$label/$tpl")
      echo "---- $label: $tpl pod template changes (base $BASE_REF -> HEAD) ----"
      diff -u "$TMP/base.txt" "$TMP/head.txt" | sed -n '3,80p'
      echo
    fi
  done
done

for s in "${SKIPPED[@]}"; do echo "skip $s"; done

# Fail closed: a gate that compared nothing must not report a pass.
if [ "$CHECKED" -eq 0 ]; then
  msg="No values set rendered at both $BASE_REF and HEAD, so nothing was compared. Fix the renders (see skips above) or the cases list in this script."
  echo "FAIL $msg"
  [ -n "${GITHUB_ACTIONS:-}" ] && echo "::error title=Postgres restart gate compared nothing::$msg"
  exit 1
fi

if [ ${#RESTARTS[@]} -eq 0 ]; then
  echo "ok   no Postgres pod-template change against $BASE_REF across $CHECKED renders (chart $BASE_VER -> $HEAD_VER)"
  exit 0
fi

IFS=. read -r bmaj bmin _ <<<"$BASE_VER"
IFS=. read -r hmaj hmin _ <<<"$HEAD_VER"
if [ "$hmaj" -gt "$bmaj" ] || { [ "$hmaj" -eq "$bmaj" ] && [ "$hmin" -gt "$bmin" ]; }; then
  msg="This change restarts Postgres (${RESTARTS[*]}) and bumps the chart $BASE_VER -> $HEAD_VER. Coordinate the merge to staging with the production maintenance window: docs/operations/planned-maintenance.md."
  echo "ok   $msg"
  [ -n "${GITHUB_ACTIONS:-}" ] && echo "::notice title=Postgres restart::$msg"
  exit 0
fi

msg="This change restarts Postgres (${RESTARTS[*]}) but the chart version goes $BASE_VER -> $HEAD_VER. A Postgres restart needs at least a MINOR bump (e.g. $bmaj.$((bmin + 1)).0) so the deploy is planned as a maintenance window. See docs/operations/planned-maintenance.md (Chart versions and Postgres restarts)."
echo "FAIL $msg"
[ -n "${GITHUB_ACTIONS:-}" ] && echo "::error title=Postgres restart needs a minor version bump::$msg"
exit 1
