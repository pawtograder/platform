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
#   .spec.replicas              -- scaling the primary to 0 stops the
#                                  database with no pod-template change
#   identity fields             -- metadata.name, serviceName, selector,
#                                  podManagementPolicy, ordinals: immutable,
#                                  or (name, ordinals) replace the workload
#   .spec.volumeClaimTemplates  -- immutable: Kubernetes rejects the update,
#                                  so the upgrade fails outright and needs a
#                                  migration or recreate plan (reported
#                                  separately)
#
# for the primary (postgres-statefulset.yaml) and the standby
# (postgres-replica.yaml). If either differs under any values set below and the
# version bump is only a patch (or nothing), it fails. Values files come from
# each side's own tree, so a values-only change counts too.
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

# Values sets: the example values files, each side rendered with ITS OWN copy
# (base chart + base values vs HEAD chart + HEAD values). Staging auto-deploys
# from examples/values-staging.yaml, so a values-only edit -- postgres.config,
# resources, the image -- rolls Postgres as surely as a template edit, and has
# to show up here. A configured file missing on either side FAILS the gate:
# a rename would otherwise drop that environment's coverage silently. For an
# intentional rename, give the old path as the case's 4th field.
#
# The prod examples leave some values to the operator that the guard-rails
# demand (image tags, storage class, WAL-G prefix, backup endpoint, the
# ruleSelector label). Those are pinned to the same fixed strings on both
# sides, so they cannot introduce a diff.
PROD_FIXUPS=(
  --set monitoring.prometheusRules.labels.release=prometheus
  --set postgres.persistence.storageClass=gate
  --set postgres.walg.s3Prefix=s3://gate/wal-g
  --set backup.s3.endpoint=https://s3.gate.invalid
)
for img in web edgeFunctions migrations backup; do PROD_FIXUPS+=(--set "$img.image.tag=v0.0.0-gate"); done
# Each case: label | HEAD values file | kind | base values file (defaults to
# the HEAD file). kind "prod" adds PROD_FIXUPS; "nopersist" renders with
# postgres.persistence.enabled=false, the emptyDir data-volume branch that no
# example file exercises.
CASES=(
  "staging|values-staging.yaml|"
  "preview|values-preview.yaml|"
  "tartangrader|values-tartangrader.yaml|"
  "prod|values-prod.yaml|prod"
  "prod-noeso|values-prod-noeso.yaml|prod"
  "nopersist|values-preview.yaml|nopersist"
)
TEMPLATES=(postgres-statefulset.yaml postgres-replica.yaml)

# extract <key>: print one 2-space-indented key under spec (`template` or
# `volumeClaimTemplates`) of every StatefulSet in a rendered file, up to the
# next 2-space key or document end. Nothing is filtered out: any change in the
# pod template, labels included, rolls the pod. The pod templates use
# version-free labels today; if chart-version labels ever get in, every bump
# rolls Postgres, and the gate should say so.
extract() {
  awk -v key="$1" '
    /^---/                { in_ss=0; keep=0; next }
    /^kind: StatefulSet/  { in_ss=1; next }
    !in_ss                { next }
    /^  [A-Za-z]/         { keep = ($0 ~ ("^  " key ":")) }
    /^[A-Za-z]/           { keep=0 }
    keep                  { print }
  '
}

# identity: the StatefulSet fields Kubernetes will not update in place
# (metadata.name, spec.serviceName, spec.selector, spec.podManagementPolicy)
# plus spec.ordinals. A change to any of them either gets the upgrade rejected
# (like volumeClaimTemplates) or replaces the database workload: a new name, or
# a new ordinals.start that turns postgres-0 into postgres-1 with a
# differently named PVC.
identity() {
  awk '
    /^---/                { in_ss=0; keep=0; next }
    /^kind: StatefulSet/  { in_ss=1; next }
    !in_ss                { next }
    /^metadata:/          { in_meta=1; next }
    /^spec:/              { in_meta=0 }
    in_meta && /^  name:/ { print "metadata." substr($0, 3) }
    /^  [A-Za-z]/         { keep = ($0 ~ /^  (serviceName|selector|podManagementPolicy|ordinals):/) }
    /^[A-Za-z]/           { keep=0 }
    keep                  { print }
  '
}

# replicas: spec.replicas of every StatefulSet. Scaling the primary to 0 stops
# the database without touching its pod template.
replicas() {
  awk '
    /^---/                { in_ss=0; next }
    /^kind: StatefulSet/  { in_ss=1; next }
    in_ss && /^  replicas:/ { print }
  '
}

# render <out-prefix> <chart> <template> <args...>: writes <out-prefix>.tpl
# (pod template), <out-prefix>.vct (claim templates), <out-prefix>.id
# (identity fields) and <out-prefix>.rep (replica count); returns 1 if the
# chart fails to render. A template
# that renders to nothing (replica disabled) makes helm say "could not find
# template" -- that is an empty result, not a failure. Helm prints the SAME
# message for a template file that does not exist, so a missing file is checked
# first and is a failure: a renamed StatefulSet template would otherwise read
# as "renders empty" on both sides and drop out of the comparison for good.
render() {
  local out="$1" chart="$2" tpl="$3"; shift 3
  : >"$out.tpl"; : >"$out.vct"; : >"$out.id"; : >"$out.rep"
  if [ ! -f "$chart/templates/$tpl" ]; then
    echo "templates/$tpl does not exist in this chart (renamed or deleted? update TEMPLATES in this script)" >"$TMP/err"
    return 1
  fi
  if helm template t "$chart" "$@" --show-only "templates/$tpl" >"$out.yaml" 2>"$TMP/err"; then
    extract template <"$out.yaml" >"$out.tpl"
    extract volumeClaimTemplates <"$out.yaml" >"$out.vct"
    identity <"$out.yaml" >"$out.id"
    replicas <"$out.yaml" >"$out.rep"
    return 0
  fi
  grep -q "could not find template" "$TMP/err"
}

POD_CHANGES=()
VCT_CHANGES=()
ID_CHANGES=()
SCALE_CHANGES=()
SKIPPED=()
BROKEN=()
CHECKED=0
show_diff() {
  echo "---- $1 (base $BASE_REF -> HEAD) ----"
  diff -u "$2" "$3" | sed -n '3,80p'
  echo
}
for c in "${CASES[@]}"; do
  IFS='|' read -r label file kind base_file <<<"$c"
  base_file="${base_file:-$file}"
  missing=()
  [ -f "$BASE_CHART/examples/$base_file" ] || missing+=("examples/$base_file at $BASE_REF")
  [ -f "$CHART/examples/$file" ] || missing+=("examples/$file at HEAD")
  if [ ${#missing[@]} -gt 0 ]; then
    BROKEN+=("$label: ${missing[*]} not found. If the file was renamed, give the old path as the 4th field of this case; if the environment is gone, remove the case.")
    continue
  fi
  base_args=(-f "$BASE_CHART/examples/$base_file")
  head_args=(-f "$CHART/examples/$file")
  case "$kind" in
    prod)      base_args+=("${PROD_FIXUPS[@]}"); head_args+=("${PROD_FIXUPS[@]}") ;;
    nopersist) base_args+=(--set postgres.persistence.enabled=false); head_args+=(--set postgres.persistence.enabled=false) ;;
  esac
  for tpl in "${TEMPLATES[@]}"; do
    if ! render "$TMP/head" "$CHART" "$tpl" "${head_args[@]}"; then
      BROKEN+=("$label/$tpl: HEAD does not render: $(head -c 200 "$TMP/err" | tr '\n' ' ')")
      continue
    fi
    if ! render "$TMP/base" "$BASE_CHART" "$tpl" "${base_args[@]}"; then
      BROKEN+=("$label/$tpl: $BASE_REF does not render: $(head -c 200 "$TMP/err" | tr '\n' ' ')")
      continue
    fi
    CHECKED=$((CHECKED + 1))
    if ! diff -q "$TMP/base.tpl" "$TMP/head.tpl" >/dev/null; then
      POD_CHANGES+=("$label/$tpl")
      show_diff "$label: $tpl pod template" "$TMP/base.tpl" "$TMP/head.tpl"
    fi
    if ! diff -q "$TMP/base.vct" "$TMP/head.vct" >/dev/null; then
      VCT_CHANGES+=("$label/$tpl")
      show_diff "$label: $tpl volumeClaimTemplates" "$TMP/base.vct" "$TMP/head.vct"
    fi
    if ! diff -q "$TMP/base.id" "$TMP/head.id" >/dev/null; then
      ID_CHANGES+=("$label/$tpl")
      show_diff "$label: $tpl StatefulSet identity fields" "$TMP/base.id" "$TMP/head.id"
    fi
    if ! diff -q "$TMP/base.rep" "$TMP/head.rep" >/dev/null; then
      SCALE_CHANGES+=("$label/$tpl: $(tr -d ' \n' <"$TMP/base.rep") -> $(tr -d ' \n' <"$TMP/head.rep")")
      show_diff "$label: $tpl replica count" "$TMP/base.rep" "$TMP/head.rep"
    fi
  done
done

for s in "${SKIPPED[@]}"; do echo "skip $s"; done

gh_annotate() { [ -n "${GITHUB_ACTIONS:-}" ] && echo "::$1 title=$2::$3"; return 0; }

# Fail closed. Every configured render has to compare: a case that cannot
# render is coverage the gate does not have, and a partial pass would let a
# change in exactly that case through.
if [ ${#BROKEN[@]} -gt 0 ]; then
  for b in "${BROKEN[@]}"; do echo "FAIL $b"; done
  msg="${#BROKEN[@]} case(s) could not be compared, so the gate cannot vouch for them. Fix the render or the values file, or update the cases list in this script."
  echo "FAIL $msg"
  gh_annotate error "Postgres restart gate could not render" "$msg"
  exit 1
fi
if [ "$CHECKED" -eq 0 ]; then
  msg="No values set exists at both $BASE_REF and HEAD, so nothing was compared."
  echo "FAIL $msg"
  gh_annotate error "Postgres restart gate compared nothing" "$msg"
  exit 1
fi

if [ ${#POD_CHANGES[@]} -eq 0 ] && [ ${#VCT_CHANGES[@]} -eq 0 ] && [ ${#ID_CHANGES[@]} -eq 0 ] && [ ${#SCALE_CHANGES[@]} -eq 0 ]; then
  echo "ok   no Postgres pod-template, volumeClaimTemplates, identity or replica-count change against $BASE_REF across $CHECKED renders (chart $BASE_VER -> $HEAD_VER)"
  exit 0
fi

# What each kind of change does on upgrade. A pod-template change rolls the
# pod. A volumeClaimTemplates change does NOT roll anything: the field is
# immutable, so Kubernetes REJECTS the StatefulSet update and the helm upgrade
# fails. That needs a migration or delete-and-recreate plan, not just a window.
what=()
[ ${#POD_CHANGES[@]} -gt 0 ] && what+=("restarts Postgres (${POD_CHANGES[*]})")
[ ${#SCALE_CHANGES[@]} -gt 0 ] && what+=("alters a Postgres StatefulSet replica count (${SCALE_CHANGES[*]}), which scales database pods up or down (on the primary, 0 is an outage)")
[ ${#ID_CHANGES[@]} -gt 0 ] && what+=("alters the StatefulSet name, serviceName, selector, podManagementPolicy or ordinals (${ID_CHANGES[*]}), which Kubernetes rejects on upgrade -- or, for a rename or new start ordinal, replaces the database pod and its PVC -- so it needs an explicit migration plan")
[ ${#VCT_CHANGES[@]} -gt 0 ] && what+=("edits the immutable volumeClaimTemplates (${VCT_CHANGES[*]}), which Kubernetes rejects on upgrade and so needs an explicit storage migration or StatefulSet recreation plan")
change="This change"
for i in "${!what[@]}"; do
  if [ "$i" -eq 0 ]; then change+=" ${what[$i]}"; else change+="; and ${what[$i]}"; fi
done

IFS=. read -r bmaj bmin _ <<<"$BASE_VER"
IFS=. read -r hmaj hmin _ <<<"$HEAD_VER"
if [ "$hmaj" -gt "$bmaj" ] || { [ "$hmaj" -eq "$bmaj" ] && [ "$hmin" -gt "$bmin" ]; }; then
  msg="$change. The chart goes $BASE_VER -> $HEAD_VER. Coordinate the merge to staging with the production maintenance window: docs/operations/planned-maintenance.md."
  echo "ok   $msg"
  gh_annotate notice "Postgres restart" "$msg"
  exit 0
fi

msg="$change, but the chart version goes $BASE_VER -> $HEAD_VER. This needs at least a MINOR bump (e.g. $bmaj.$((bmin + 1)).0) so the deploy is planned as a maintenance window. See docs/operations/planned-maintenance.md (Chart versions and Postgres restarts)."
echo "FAIL $msg"
gh_annotate error "Postgres restart needs a minor version bump" "$msg"
exit 1
