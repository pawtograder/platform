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
OUTFILE="$(mktemp)"
trap 'rm -f "$ERRFILE" "$OUTFILE"' EXIT

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

# assert_rendered_contains "<label>" "<template>" "<expected substring>" <extra --set args...>
# Renders one template with --show-only and asserts the output contains the
# expected text — used to lock in a hardening detail (securityContext, SA-token
# opt-out) that lives in a rendered manifest rather than in a guard `fail`.
assert_rendered_contains() {
  local label="$1" template="$2" want="$3"; shift 3
  if ! helm template t "$CHART" "${BASE[@]}" "$@" --show-only "$template" >"$OUTFILE" 2>"$ERRFILE"; then
    echo "FAIL [$label]: render was REFUSED but should have succeeded"
    echo "       got: $(grep -oiE 'Error:.*' "$ERRFILE" | head -1)"
    FAILED=1
  elif ! grep -qF "$want" "$OUTFILE"; then
    echo "FAIL [$label]: rendered, but missing expected text: $want"
    FAILED=1
  else
    echo "ok   [$label]"
  fi
}

# assert_edge_envfrom_optional "<label>" "<template>" <extra --set args...>
# Every Secret listed in edgeFunctions.envFromSecrets must render optional: true.
# envFrom is one-shot and all-or-nothing: a single absent Secret puts the whole
# edge tier (grading included) into CreateContainerConfigError with no
# self-heal, so a missing integration Secret must never gate startup. This
# asserts the property directly on the rendered manifest so nothing — a flag, a
# refactor — can quietly make those Secrets mandatory again.
assert_edge_envfrom_optional() {
  local label="$1" template="$2"; shift 2
  local a=guardrail-envfrom-a b=guardrail-envfrom-b
  if ! helm template t "$CHART" "${BASE[@]}" \
      --set "edgeFunctions.envFromSecrets={$a,$b}" \
      "$@" --show-only "$template" >"$OUTFILE" 2>"$ERRFILE"; then
    echo "FAIL [$label]: render was REFUSED but should have succeeded"
    echo "       got: $(grep -oiE 'Error:.*' "$ERRFILE" | head -1)"
    FAILED=1
    return
  fi
  local secret bad=0
  for secret in "$a" "$b"; do
    # The secretRef name line, then the line right after it, which must be the
    # optional field. Anything else (absent, or optional: false) fails.
    if ! grep -A1 -F "name: $secret" "$OUTFILE" | grep -qF "optional: true"; then
      echo "FAIL [$label]: envFrom secretRef $secret does not render optional: true"
      bad=1
    fi
  done
  # Nothing else in this workload may be mandatory either, except the in-cluster
  # Redis URL, which is deliberately optional: false (documented in the tpl) and
  # only renders for a non-external redis.provider.
  #
  # The exception has to be applied, not just described: the previous form scanned
  # the whole manifest for the field, so any call site rendering with
  # redis.provider=internal or shared would have failed on the one mandatory
  # reference the chart intends. Pair the field with the secretRef name on the line
  # above it and drop pawtograder-redis, which also keeps this anchored to the field
  # rather than the tpl's explanatory comments (they mention the string).
  # Captured rather than tested with `grep -q -v`: those two flags together are not portable
  # (ugrep reports no match where GNU grep reports one), and a guardrail that silently inverts on
  # a different grep is worse than no guardrail. A non-empty capture is the violation, and it
  # doubles as the failure output.
  local mandatory
  mandatory="$(grep -B1 -E '^[[:space:]]*optional: false' "$OUTFILE" \
                | grep -E '^[[:space:]]*name:' \
                | grep -vF 'name: pawtograder-redis' || true)"
  if [ -n "$mandatory" ]; then
    echo "FAIL [$label]: rendered a mandatory envFrom secretRef (optional: false)"
    echo "$mandatory"
    bad=1
  fi
  if [ "$bad" -ne 0 ]; then FAILED=1; else echo "ok   [$label]"; fi
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
assert_refused "walg without base backup" \
  "PITR silently cannot restore" \
  --set postgres.walg.enabled=true --set postgres.walg.baseBackup.enabled=false \
  --set postgres.walg.s3Prefix=s3://b/walg
assert_refused "prometheus rules without ruleSelector labels" \
  "every backup/ESO/cert alert is inert" \
  --set monitoring.enabled=true

echo "== staging tier: durable guards fire, production-only guards do not =="
# staging is a durable tier: helm's last---set-wins retiers the production
# baseline to staging, so the durable (staging+prod) guards must still bite,
# while the production-only pins (image tags, storageClass, e2e/seed) relax.
assert_refused "secrets.create in staging" \
  "renders plaintext secret material" \
  --set global.environment=staging --set secrets.create=true
assert_refused "resetOnDrift in staging" \
  "DESTROYS ALL APPLICATION DATA" \
  --set global.environment=staging --set migrations.resetOnDrift=true
assert_refused "blank prometheusRules label value in staging" \
  "matches no ruleSelector" \
  --set global.environment=staging --set monitoring.enabled=true \
  --set monitoring.prometheusRules.labels.release=""
assert_renders "web e2e allowed on staging" \
  --set global.environment=staging --set web.e2e.enabled=true
assert_renders "seed allowed on staging" \
  --set global.environment=staging --set seed.enabled=true
assert_renders "empty image tag + storageClass allowed on staging" \
  --set global.environment=staging --set web.image.tag="" \
  --set postgres.persistence.storageClass=""

echo "== production-only guards =="
assert_refused "web e2e bypass" \
  "enable privileged test-only code paths" --set web.e2e.enabled=true
assert_refused "edge e2e mockGitHub" \
  "enable privileged test-only code paths" --set edgeFunctions.e2e.mockGitHub=true
assert_refused "edge e2e enabled" \
  "enable privileged test-only code paths" --set edgeFunctions.e2e.enabled=true
assert_refused "secrets.autogenerate" \
  "non-recoverable key material" --set secrets.autogenerate=true
assert_refused "seed enabled" \
  "loads demo classes" --set seed.enabled=true
assert_refused "floating web image tag (latest)" \
  "is a floating tag" --set web.image.tag=latest
assert_refused "floating edge image tag (-latest suffix)" \
  "is a floating tag" --set edgeFunctions.image.tag=canary-latest
assert_refused "empty web image tag (appVersion fallback)" \
  "silently fall back to Chart.AppVersion" --set web.image.tag=""
assert_refused "floating migrations image tag (latest)" \
  "is a floating tag" --set migrations.image.tag=latest
assert_refused "empty migrations image tag (appVersion fallback)" \
  "silently fall back to Chart.AppVersion" --set migrations.image.tag=""
assert_refused "empty postgres storageClass (cluster default)" \
  "node loss = data loss" --set postgres.persistence.storageClass=""
assert_refused "blank prometheusRules label value" \
  "matches no ruleSelector" \
  --set monitoring.enabled=true --set monitoring.prometheusRules.labels.release=""

echo "== ephemeral tiers still permit what durable tiers refuse =="
# resetOnDrift is a legitimate dev/preview convenience; the guard must NOT fire
# there. (migrate.sh independently re-checks the tier at runtime.)
assert_renders "resetOnDrift allowed on dev" \
  --set global.environment=dev --set migrations.resetOnDrift=true
assert_renders "seed allowed on dev" \
  --set global.environment=dev --set seed.enabled=true
# Empty tag (appVersion fallback) and default storage class are fine on
# ephemeral tiers — only production must pin.
assert_renders "empty image tag + storageClass allowed on dev" \
  --set global.environment=dev --set web.image.tag="" \
  --set postgres.persistence.storageClass=""

echo "== backup / monitoring guards permit the safe combinations =="
# walg with base backup on (the default) is fine.
assert_renders "walg with base backup renders" \
  --set postgres.walg.enabled=true --set postgres.walg.baseBackup.enabled=true \
  --set postgres.walg.s3Prefix=s3://b/walg
# walg WITHOUT base backup is a legitimate ephemeral-tier convenience, so the
# guard must NOT fire there.
assert_renders "walg without base backup allowed on dev" \
  --set global.environment=dev --set postgres.walg.enabled=true \
  --set postgres.walg.baseBackup.enabled=false --set postgres.walg.s3Prefix=s3://b/walg
# A ruleSelector label, or the explicit opt-out, clears the PrometheusRule guard.
assert_renders "prometheus rules with ruleSelector label renders" \
  --set monitoring.enabled=true --set monitoring.prometheusRules.labels.release=kps
assert_renders "prometheus rules allowUnselectedRules renders" \
  --set monitoring.enabled=true --set monitoring.prometheusRules.allowUnselectedRules=true

# assert_exporter_metric "<block>" "<column>" [<label>...]
# postgres_exporter names every custom metric `<block key>_<column name>`, so the
# queries.yaml block key and the column name TOGETHER are the metric name that
# Grafana panels and alert rules query — a block rename that looks like tidying
# silently blanks a dashboard.
#
# The four metrics pinned below moved off the `metrics` edge function, which
# Prometheus scraped once per functions pod (32 replicas in prod, ~1.07
# scrapes/sec, 77.7% of all database execution time). Their block/column splits
# were chosen to land on the pre-existing names, not for elegance — hence e.g.
# block `pawtograder_db_dead` + column `tuples`. Label names are pinned too:
# panels legend on them and alert rules can match on them.
assert_exporter_metric() {
  local block="$1" column="$2"; shift 2
  local label="exporter metric ${block}_${column}"
  if ! helm template t "$CHART" "${BASE[@]}" \
      --set monitoring.enabled=true --set monitoring.prometheusRules.labels.release=kps \
      --show-only templates/monitoring.yaml >"$OUTFILE" 2>"$ERRFILE"; then
    echo "FAIL [$label]: render was REFUSED but should have succeeded"
    echo "       got: $(grep -oiE 'Error:.*' "$ERRFILE" | head -1)"
    FAILED=1
    return
  fi
  # Slice this block's stanza out of the embedded queries.yaml: queries.yaml is a
  # YAML literal inside the ConfigMap, so blocks sit at exactly 4 spaces and the
  # next 4-space key ends the stanza. Anchoring on the exact key keeps
  # `pawtograder_db_buffer_cache` from matching `pawtograder_db_buffer_cache_total`.
  local stanza
  stanza="$(awk -v b="    $block:" '
    $0 == b { inb = 1; next }
    inb && /^    [^ ]/ { exit }
    inb { print }
  ' "$OUTFILE")"
  if [ -z "$stanza" ]; then
    echo "FAIL [$label]: queries.yaml has no block named '$block'"
    FAILED=1
    return
  fi
  local bad=0
  if ! printf '%s\n' "$stanza" | grep -qE "^        - $column:$"; then
    echo "FAIL [$label]: block '$block' declares no column '$column'"
    bad=1
  fi
  local lbl
  for lbl in "$@"; do
    # The column key, then the two lines under it (usage, description). A LABEL
    # column must render usage: "LABEL" so the exporter turns it into a label
    # rather than a second metric.
    if ! printf '%s\n' "$stanza" | grep -A2 -E "^        - $lbl:$" | grep -qF 'usage: "LABEL"'; then
      echo "FAIL [$label]: block '$block' does not expose '$lbl' as a LABEL"
      bad=1
    fi
  done
  if [ "$bad" -ne 0 ]; then FAILED=1; else echo "ok   [$label]"; fi
}

echo "== postgres_exporter metric names moved off the edge function are pinned =="
assert_exporter_metric pawtograder_db_buffer_cache bytes relname
assert_exporter_metric pawtograder_db_buffer_cache_total used_bytes
assert_exporter_metric pawtograder_db_dead tuples relname
assert_exporter_metric pawtograder_vacuum alert check severity table_name

# assert_exporter_all_master
# Every custom query block in the exporter's queries.yaml must set `master: true`.
#
# The sidecar runs PG_EXPORTER_AUTO_DISCOVER_DATABASES=true, so without it a
# block runs once per discovered database. Every query in that file is either
# cluster-wide (pg_stat_statements, pg_buffercache, pg_settings,
# pg_stat_replication) or specific to the application database (public.classes,
# public.submissions, public.help_requests, the pawtograder_* functions), so
# per-database execution is wrong in all of them.
#
# Auto-discovery is not a no-op: on supabase/postgres it finds `_supabase` and
# `storage_vectors`. It has stayed harmless only because these queries error or
# return empty there — which still sets pg_exporter_last_scrape_error on every
# scrape. And the `server` label is only host:port (parseFingerprint, no
# database name), so databases on one instance are indistinguishable by label:
# the first query that does return a row from a second database yields a
# duplicate label set, and that makes the exporter return HTTP 500 for the WHOLE
# /metrics endpoint, taking down all postgres metrics at once.
#
# Blanket assertion on purpose. A future block that genuinely means something
# different per database is fine, but it has to be added to ALLOW_NO_MASTER here
# with a reason, so the decision is deliberate and reviewable instead of a
# forgotten default.
assert_exporter_all_master() {
  local label="every exporter query block sets master: true"
  # Blocks legitimately exempt (per-database by design). Space-separated.
  local ALLOW_NO_MASTER=""
  if ! helm template t "$CHART" "${BASE[@]}" \
      --set monitoring.enabled=true --set monitoring.prometheusRules.labels.release=kps \
      --show-only templates/monitoring.yaml >"$OUTFILE" 2>"$ERRFILE"; then
    echo "FAIL [$label]: render was REFUSED but should have succeeded"
    echo "       got: $(grep -oiE 'Error:.*' "$ERRFILE" | head -1)"
    FAILED=1
    return
  fi
  # Slice out just the queries.yaml literal: starts after `queries.yaml: |` and
  # ends at the next document separator. Keeps the 4-space block scan below from
  # straying into the Service/ServiceMonitor manifests further down the file.
  local queries
  queries="$(awk '
    /^  queries\.yaml: \|$/ { inq = 1; next }
    inq && /^---$/ { exit }
    inq { print }
  ' "$OUTFILE")"
  if [ -z "$queries" ]; then
    echo "FAIL [$label]: could not find the queries.yaml literal in the rendered ConfigMap"
    FAILED=1
    return
  fi
  # One line per block: "<name> <has_master>". A 4-space key with no value opens
  # a block; `master: true` at 6 spaces belongs to the block currently open.
  local report
  report="$(printf '%s\n' "$queries" | awk '
    /^    [a-z_]+:$/ { if (blk != "") print blk, has; blk = substr($1, 1, length($1) - 1); has = 0; next }
    /^      master: true$/ { has = 1 }
    END { if (blk != "") print blk, has }
  ')"
  local nblocks bad=0 name flag
  nblocks="$(printf '%s\n' "$report" | grep -c . || true)"
  if [ "$nblocks" -lt 10 ]; then
    echo "FAIL [$label]: only parsed $nblocks query blocks — the scan looks broken, not the file"
    FAILED=1
    return
  fi
  while read -r name flag; do
    [ -z "$name" ] && continue
    if [ "$flag" != "1" ] && ! printf ' %s ' "$ALLOW_NO_MASTER" | grep -qF " $name "; then
      echo "FAIL [$label]: block '$name' does not set master: true (and is not in ALLOW_NO_MASTER)"
      bad=1
    fi
  done <<EOF
$report
EOF
  if [ "$bad" -ne 0 ]; then FAILED=1; else echo "ok   [$label] ($nblocks blocks)"; fi
}

assert_exporter_all_master

echo "== rendered hardening (redis securityContext, smtp-relay SA token) =="
assert_rendered_contains "internal redis pod runs non-root with a securityContext" \
  templates/redis.yaml "runAsNonRoot: true" \
  --set redis.provider=internal
assert_rendered_contains "smtp-relay does not automount the SA token" \
  templates/smtp-relay.yaml "automountServiceAccountToken: false" \
  --set auth.smtp.enabled=true --set auth.smtp.relay.enabled=true \
  --set auth.smtp.relay.downstream=lxc.example.edu:2525

echo "== edge-function envFrom Secrets are never mandatory =="
assert_edge_envfrom_optional "edge-functions deployment envFrom is optional" \
  templates/edge-functions.yaml
assert_edge_envfrom_optional "edge-function channels envFrom is optional" \
  templates/edge-functions-channels.yaml \
  --set 'channels[0].name=canary' \
  --set 'channels[0].web.image.tag=v1.0.0' \
  --set 'channels[0].web.hostname=canary.pawtograder.example.com' \
  --set 'channels[0].edgeFunctions.image.tag=v1.0.0' \
  --set channelWildcardTlsSecret=wildcard-tls

echo
if [ "$FAILED" -ne 0 ]; then
  echo "GUARD-RAIL TESTS FAILED"
  exit 1
fi
echo "All guard-rail render tests passed."
