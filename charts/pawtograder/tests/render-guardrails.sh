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
  elif ! grep -qF -- "$want" "$OUTFILE"; then
    echo "FAIL [$label]: rendered, but missing expected text: $want"
    FAILED=1
  else
    echo "ok   [$label]"
  fi
}

# assert_rendered_lacks "<label>" "<template>" "<forbidden substring>" <extra --set args...>
# Inverse of assert_rendered_contains: the render must SUCCEED and must NOT contain
# the substring. Used to prove a manifest is absent in a mode where it would be
# actively harmful, rather than merely unused.
assert_rendered_lacks() {
  local label="$1" template="$2" forbidden="$3"; shift 3
  if ! helm template t "$CHART" "${BASE[@]}" "$@" --show-only "$template" >"$OUTFILE" 2>"$ERRFILE"; then
    echo "FAIL [$label]: render was REFUSED but should have succeeded"
    echo "       got: $(grep -oiE 'Error:.*' "$ERRFILE" | head -1)"
    FAILED=1
  elif grep -qF -- "$forbidden" "$OUTFILE"; then
    echo "FAIL [$label]: rendered, but still contains: $forbidden"
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

# assert_env_value "<label>" "<template>" "<ENV_NAME>" "<expected value>" <extra --set args...>
# Pins one container env var to an exact rendered value, matched by NAME then the
# `value:` line immediately below it.
#
# Matching on the name is the whole point here rather than pedantry: the two eszip
# budgets both render 268435456 at the current defaults (a 256Mi cache and a 256Mi
# cold-load allowance are the same number of bytes), so a bare grep for the number
# passes even if the two are swapped, or if one is left behind at 512Mi while the
# other supplies the match. Anchor to the name and the adjacent line.
assert_env_value() {
  local label="$1" template="$2" envname="$3" want="$4"; shift 4
  if ! helm template t "$CHART" "${BASE[@]}" "$@" --show-only "$template" >"$OUTFILE" 2>"$ERRFILE"; then
    echo "FAIL [$label]: render was REFUSED but should have succeeded"
    echo "       got: $(grep -oiE 'Error:.*' "$ERRFILE" | head -1)"
    FAILED=1
    return
  fi
  local got
  got="$(grep -A1 -E "^[[:space:]]*- name: ${envname}\$" "$OUTFILE" \
          | grep -E '^[[:space:]]*value:' \
          | head -1 | sed -E 's/^[[:space:]]*value:[[:space:]]*"?([^"]*)"?[[:space:]]*$/\1/')"
  if [ -z "$got" ]; then
    echo "FAIL [$label]: $envname is not rendered in $template at all"
    FAILED=1
  elif [ "$got" != "$want" ]; then
    echo "FAIL [$label]: $envname rendered $got, expected $want"
    FAILED=1
  else
    echo "ok   [$label]"
  fi
}

# assert_hpa_utilization "<label>" "<memory|cpu>" "<expected>" <extra --set args...>
# Pins one HPA resource metric's averageUtilization, keyed on the RESOURCE NAME.
#
# The HPA renders `averageUtilization` once per metric, so the field name alone is
# ambiguous — memory and cpu both produce a line spelled identically. Anchor on the
# `name: <resource>` line and read the averageUtilization from the following lines
# of that metric block, so a memory assertion cannot be satisfied by the cpu target.
assert_hpa_utilization() {
  local label="$1" resource="$2" want="$3"; shift 3
  if ! helm template t "$CHART" "${BASE[@]}" \
      --set edgeFunctions.autoscaling.enabled=true \
      "$@" --show-only templates/edge-functions-hpa.yaml >"$OUTFILE" 2>"$ERRFILE"; then
    echo "FAIL [$label]: render was REFUSED but should have succeeded"
    echo "       got: $(grep -oiE 'Error:.*' "$ERRFILE" | head -1)"
    FAILED=1
    return
  fi
  local got
  got="$(grep -A4 -E "^[[:space:]]*name: ${resource}\$" "$OUTFILE" \
          | grep -E '^[[:space:]]*averageUtilization:' \
          | head -1 | sed -E 's/^[[:space:]]*averageUtilization:[[:space:]]*//')"
  if [ -z "$got" ]; then
    echo "FAIL [$label]: no averageUtilization found for resource $resource"
    FAILED=1
  elif [ "$got" != "$want" ]; then
    echo "FAIL [$label]: $resource averageUtilization rendered $got, expected $want"
    FAILED=1
  else
    echo "ok   [$label]"
  fi
}

# assert_container_memory "<label>" "<template>" "<container>" "<requests|limits>" "<expected>" <extra --set args...>
# Pins one container's resources.<requests|limits>.memory to an exact rendered
# value, keyed on the CONTAINER NAME.
#
# Anchoring on the container is the point, not pedantry. `memory:` under
# `requests:` is spelled identically in every workload the chart ships, and a
# `--show-only` of one template can still hold several containers, so a bare grep
# would happily be satisfied by a sidecar, an init container, or the limit when the
# request is what regressed. Container list items and the nested `- name:` entries
# for ports and env vars are told apart by INDENT: the block ends at the next
# `- name:` at the same column, and deeper ones are skipped.
assert_container_memory() {
  local label="$1" template="$2" container="$3" section="$4" want="$5"; shift 5
  if ! helm template t "$CHART" "${BASE[@]}" "$@" \
      --show-only "$template" >"$OUTFILE" 2>"$ERRFILE"; then
    echo "FAIL [$label]: render was REFUSED but should have succeeded"
    echo "       got: $(grep -oiE 'Error:.*' "$ERRFILE" | head -1)"
    FAILED=1
    return
  fi
  local got
  got="$(awk -v c="$container" -v s="$section" '
    /^[[:space:]]*- name: / {
      ind = index($0, "-")
      name = $0; sub(/^[[:space:]]*- name: /, "", name); gsub(/"/, "", name)
      if (inc && ind == cind) { inc = 0; inres = 0; insec = 0 }
      if (!inc && name == c) { inc = 1; cind = ind; inres = 0; insec = 0 }
      next
    }
    !inc { next }
    /^[[:space:]]*resources:[[:space:]]*$/ { inres = 1; insec = 0; next }
    inres && /^[[:space:]]*(limits|requests):[[:space:]]*$/ {
      sec = $0; sub(/^[[:space:]]*/, "", sec); sub(/:.*$/, "", sec)
      insec = (sec == s)
      next
    }
    insec && /^[[:space:]]*memory:[[:space:]]*/ {
      v = $0; sub(/^[[:space:]]*memory:[[:space:]]*/, "", v); gsub(/"/, "", v)
      print v; exit
    }
  ' "$OUTFILE")"
  if [ -z "$got" ]; then
    echo "FAIL [$label]: no $section.memory found for container $container in $template"
    FAILED=1
  elif [ "$got" != "$want" ]; then
    echo "FAIL [$label]: container $container $section.memory rendered $got, expected $want"
    FAILED=1
  else
    echo "ok   [$label]"
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

# Monitoring with an externally managed database. Every DB-derived series comes
# from the postgres_exporter SIDECAR in the chart-managed Postgres StatefulSet, so
# postgres.enabled=false leaves no collector — and since this PR the `metrics` edge
# function no longer gathers them (it cost 77.7% of all DB execution time, scraped
# once per functions pod). The PawtograderPostgresExporter* self-health rules are
# gated on postgres.enabled too, so nothing would report the absence. The guard
# must refuse that combination, and the acknowledgement must clear it.
assert_refused "monitoring without the chart's postgres (no collector)" \
  "ships NO database metrics collector" \
  --set monitoring.enabled=true --set postgres.enabled=false \
  --set monitoring.prometheusRules.labels.release=kps
assert_renders "monitoring without postgres is allowed once an external exporter is declared" \
  --set monitoring.enabled=true --set postgres.enabled=false \
  --set monitoring.externalPostgresExporter=true \
  --set monitoring.prometheusRules.labels.release=kps
# ...and in that mode the chart must NOT ship its own exporter Service/ServiceMonitor:
# they select the sidecar's pod, which does not exist, so they would sit permanently
# "down" and mask the operator's real exporter. The queries.yaml ConfigMap SHOULD
# still render — it is worth mounting into an external exporter to keep the metric
# names the dashboards and alert rules expect.
assert_rendered_lacks "external-exporter mode ships no dangling exporter Service/ServiceMonitor" \
  templates/monitoring.yaml "9187" \
  --set monitoring.enabled=true --set postgres.enabled=false \
  --set monitoring.externalPostgresExporter=true \
  --set monitoring.prometheusRules.labels.release=kps
assert_rendered_contains "external-exporter mode still ships queries.yaml to mount" \
  templates/monitoring.yaml "queries.yaml: |" \
  --set monitoring.enabled=true --set postgres.enabled=false \
  --set monitoring.externalPostgresExporter=true \
  --set monitoring.prometheusRules.labels.release=kps

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
# Latent on the currently deployed supabase/postgres 17.4.x: the discovery query
# excludes templates, and prod has only `postgres`, `template0` and `template1`,
# so nothing is discovered (prod pg_exporter_last_scrape_error is 0, one `server`
# label value). On 17.6.x and later Supabase adds `_supabase` and
# `storage_vectors`, and then four of these blocks error once per discovered
# database on every scrape and pawtograder_table_sizes runs against the wrong
# databases — so this is a prerequisite for the next Postgres image bump. It also
# guards worse than noise: the `server` label is only host:port
# (parseFingerprint, no database name), so databases on one instance are
# indistinguishable by label, and the first query that returns a row from a
# second database yields a duplicate label set — which makes the exporter return
# HTTP 500 for the WHOLE /metrics endpoint, taking down all postgres metrics.
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

# assert_no_liveness_probe "<label>" "<template>" <extra --set args...>
# The postgres primary and its replica must render NO livenessProbe, and must
# still render a readinessProbe.
#
# On 2026-08-27 the hardcoded liveness probes killed BOTH pods during a transient
# NetApp NFS stall caused by network maintenance — the primary at 14:02:44 and
# postgres-replica-0 at 17:18:18. Each template carried periodSeconds 10 /
# timeoutSeconds 5 with failureThreshold unset, so both inherited the Kubernetes
# default of 3 and had only ~30s of tolerance. The shutdown checkpoint one second
# after the primary was killed flushed 1397 buffers in 0.122s (sync 0.002s), so
# storage was already healthy: the probe's patience ran out about a second before
# the problem cleared itself. Each misfire cost the 4GB warm buffer pool, every
# connection, and a hard exit of all three realtime pods.
#
# Restarting a single-writer Postgres cannot fix external storage, so waiting is
# strictly better. Loosening was rejected because pg_isready ALSO exits non-zero
# during crash recovery ("rejecting connections"), and on this ~29 GB database WAL
# replay can outlast any sane liveness window — the probe would then kill the pod
# mid-recovery, each kill leaving more WAL to replay than the last.
#
# This assertion exists so that cannot be silently undone. Readiness is asserted
# present in the same breath, because removing THAT would be the opposite mistake:
# it is the non-destructive half of the signal. Rationale lives in
# templates/postgres-statefulset.yaml.
assert_no_liveness_probe() {
  local label="$1" template="$2"; shift 2
  if ! helm template t "$CHART" "${BASE[@]}" "$@" --show-only "$template" >"$OUTFILE" 2>"$ERRFILE"; then
    echo "FAIL [$label]: render was REFUSED but should have succeeded"
    echo "       got: $(grep -oiE 'Error:.*' "$ERRFILE" | head -1)"
    FAILED=1
    return
  fi
  local bad=0
  if grep -qE '^[[:space:]]*livenessProbe:' "$OUTFILE"; then
    echo "FAIL [$label]: $template renders a livenessProbe — see the note above and in postgres-statefulset.yaml"
    bad=1
  fi
  if ! grep -qE '^[[:space:]]*readinessProbe:' "$OUTFILE"; then
    echo "FAIL [$label]: $template renders NO readinessProbe — that is the half we must keep"
    bad=1
  fi
  if [ "$bad" -ne 0 ]; then FAILED=1; else echo "ok   [$label]"; fi
}

echo "== postgres liveness probes stay removed (2026-08-27 incident) =="
assert_no_liveness_probe "postgres primary has no livenessProbe, keeps readinessProbe" \
  templates/postgres-statefulset.yaml
assert_no_liveness_probe "postgres replica has no livenessProbe, keeps readinessProbe" \
  templates/postgres-replica.yaml \
  --set postgres.replica.enabled=true \
  --set postgres.replica.persistence.storageClass=lp \
  --set postgres.walg.enabled=true \
  --set postgres.walg.s3Prefix=s3://b/walg

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

# The eszip cache is a load-INDEPENDENT term in per-pod RSS, so it sets the FLOOR
# the memory-target HPA measures against the request. At 512Mi that floor sat at
# ~992Mi against prod's 1Gi request, i.e. ~100% before any load, and the HPA
# pinned at maxReplicas 32 with CPU at 5% — see the note on eszipCacheMaxMb in
# values.yaml. 2026-08-28 halved it to 256Mi. Pin the rendered BYTES so a future
# edit cannot quietly restore 512 and re-pin the autoscaler: this is a number
# whose regression is invisible in behaviour for hours (the floor climbs with
# cache warmth after each deploy) and then permanent.
echo "== edge-function eszip byte budgets are pinned (HPA floor, 2026-08-28) =="
assert_env_value "eszip cache renders 256Mi in bytes" \
  templates/edge-functions.yaml EDGE_ESZIP_CACHE_MAX_BYTES 268435456
assert_env_value "eszip cold-load allowance renders 256Mi in bytes" \
  templates/edge-functions.yaml EDGE_ESZIP_COLD_LOAD_MAX_BYTES 268435456

# The budget assertion is the thing that makes the four terms safe to tune at all,
# so prove it still REFUSES rather than trusting that it would. 3160Mi is the exact
# sum at the current defaults (256 + 256 + 8 x 256 + 90), so one MiB below it is
# the tightest possible negative case and it also pins the arithmetic itself.
assert_refused "memory budget refuses a limit one MiB below the computed sum" \
  "+ ~600Mi Deno host = 3160Mi" \
  --set edgeFunctions.resources.limits.memory=3159Mi
assert_renders "memory budget accepts a limit exactly equal to the computed sum" \
  --set edgeFunctions.resources.limits.memory=3160Mi
# eszipColdLoadHeadroomMb must still cover the largest bundle in the image. It is
# NOT reduced alongside the cache: halving the cache makes cold reads MORE frequent.
assert_refused "cold-load allowance below the largest bundle is refused" \
  "below the 64Mi needed to cover the largest bundle" \
  --set edgeFunctions.eszipColdLoadHeadroomMb=32

# A memory-target HPA measures utilization against the REQUEST, so the request is
# an autoscaling input on this tier and not just a scheduling hint. The chart
# default was 512Mi, which is below the per-pod floor on any deployment at any
# load: the load-independent Deno baseline alone measures ~600Mi. An idle pod
# therefore reads over 100%, and the HPA is pinned at maxReplicas from the moment
# it is enabled — it cannot scale down (needs <90% of target) and cannot scale up
# (already at max). Production ran that way for weeks.
#
# Pin both halves of the block. The request is what regressed and what must not
# drift back to 512Mi; the limit is pinned alongside it because the render-time
# budget assertion is computed against the LIMIT, and this is the cheapest place
# to prove the two were not confused for each other in a later edit. 2026-09-01.
echo "== edge-function memory request is pinned (the HPA measures against it, 2026-09-01) =="
assert_container_memory "functions container requests 1.5Gi, not 512Mi" \
  templates/edge-functions.yaml functions requests 1.5Gi
assert_container_memory "functions container limit stays 4Gi" \
  templates/edge-functions.yaml functions limits 4Gi

# The (request, memory target) pair has to be coherent, and the example overlays are
# where that is easiest to get wrong: an overlay setting a target OVERRIDES the
# chart default, so an overlay left at 100 hands an operator back exactly the
# configuration that pinned production for weeks -- while the freshly-tuned request
# beside it makes the file look deliberately sized.
#
# Both failure modes are the same dead band seen from opposite ends. At target 100
# the band is 90-110% of the request; at 80 it is 72-88%. A request below
# idle/0.72 can never scale DOWN (the floor never leaves the band) and a request
# above loaded/0.88 can never scale UP. With request 1.5Gi and target 100 the band
# is 1382-1690Mi, and 1690Mi is the measured loaded ceiling -- so the fleet would
# sit at minReplicas and never scale up on memory. Pin both numbers per overlay.
#
# The overlays ship placeholders (blank image tags, blank storage class, blank
# ruleSelector label, wal-g without an s3 prefix) that are meant to be filled in per
# install, so fill them here rather than weakening the guards that reject them.
OVERLAY_FILL=(
  --set monitoring.prometheusRules.labels.release=kube-prometheus-stack
  --set postgres.walg.s3Prefix=s3://example/wal-archive
)
echo "== example overlays carry a coherent (memory request, HPA target) pair =="
for _ov in values-prod values-prod-noeso; do
  # Production overlays carry the measured PROD pair, not the chart default: prod's
  # converged idle floor is ~1260Mi and its loaded ceiling ~1690Mi, so the usable
  # window is 1750-1920Mi and 1.5Gi (1536Mi) sits below it.
  assert_container_memory "$_ov: functions requests 1.8Gi (prod window 1750-1920Mi)" \
    templates/edge-functions.yaml functions requests 1.8Gi \
    -f "$CHART/examples/$_ov.yaml" "${OVERLAY_FILL[@]}"
  assert_hpa_utilization "$_ov: memory target 80, not 100" memory 80 \
    -f "$CHART/examples/$_ov.yaml" "${OVERLAY_FILL[@]}"
done
# Staging keeps the chart default request: it serves fewer distinct functions, so its
# floor is lower and 1.5Gi against target 80 is coherent there. It enables e2e, which
# a production render legitimately refuses, so render it as the staging tier it is.
assert_container_memory "values-staging: functions requests 1.5Gi (chart default)" \
  templates/edge-functions.yaml functions requests 1.5Gi \
  -f "$CHART/examples/values-staging.yaml" "${OVERLAY_FILL[@]}" \
  --set global.environment=staging
assert_hpa_utilization "values-staging: memory target 80, not 100" memory 80 \
  -f "$CHART/examples/values-staging.yaml" "${OVERLAY_FILL[@]}" \
  --set global.environment=staging

# The HPA controller applies a default 10% tolerance, so a target of 100 is a dead
# band of 90-110%. The edge tier's load-independent floor sat inside that band,
# which wedged scaling in BOTH directions: it could not scale down (needs <90%) and
# at 109% under load it could not scale up (needs >110%). 80 puts the band at
# 72-88%, between the measured ~56% floor and ~146% loaded peak. Pin it so the
# value cannot drift back to a number whose dead band swallows the floor.
echo "== edge-function HPA targets are pinned (dead-band sizing, 2026-08-28) =="
assert_hpa_utilization "memory target renders 80, not 100" memory 80
assert_hpa_utilization "cpu target renders 200" cpu 200

# assert_cli_arg "<label>" "<template>" "<flag>" "<expected>" <extra --set args...>
# Pins the value that FOLLOWS a container arg flag. edge-runtime takes its config
# as `- --flag` / `- value` pairs, so a bare grep for the value cannot tell which
# flag it belongs to -- and once two tiers render from one template, cannot tell
# which TIER either. Anchor on the flag and read the next non-comment list item.
assert_cli_arg() {
  local label="$1" template="$2" flag="$3" want="$4"; shift 4
  if ! helm template t "$CHART" "${BASE[@]}" "$@" --show-only "$template" >"$OUTFILE" 2>"$ERRFILE"; then
    echo "FAIL [$label]: render was REFUSED but should have succeeded"
    echo "       got: $(grep -oiE 'Error:.*' "$ERRFILE" | head -1)"
    FAILED=1
    return
  fi
  local got
  got="$(awk -v f="$flag" '
    $0 ~ "^[[:space:]]*- " f "[[:space:]]*$" { hit = 1; next }
    hit && /^[[:space:]]*#/ { next }
    hit && /^[[:space:]]*- / {
      v = $0; sub(/^[[:space:]]*- /, "", v); gsub(/"/, "", v)
      print v; exit
    }
  ' "$OUTFILE")"
  if [ -z "$got" ]; then
    echo "FAIL [$label]: $flag is not rendered in $template at all"
    FAILED=1
  elif [ "$got" != "$want" ]; then
    echo "FAIL [$label]: $flag rendered $got, expected $want"
    FAILED=1
  else
    echo "ok   [$label]"
  fi
}

# assert_absent "<label>" "<forbidden substring>" <extra --set args...>
# Proves a string appears NOWHERE in the whole rendered chart.
#
# Not assert_rendered_lacks: that takes --show-only, and helm ERRORS with "could
# not find template" when the named template renders nothing at all -- which is
# precisely the state an absence assertion needs to accept. Rendering everything
# also catches the string leaking in from a template you did not think to name.
assert_absent() {
  local label="$1" forbidden="$2"; shift 2
  if ! helm template t "$CHART" "${BASE[@]}" "$@" >"$OUTFILE" 2>"$ERRFILE"; then
    echo "FAIL [$label]: render was REFUSED but should have succeeded"
    echo "       got: $(grep -oiE 'Error:.*' "$ERRFILE" | head -1)"
    FAILED=1
  elif grep -qF -- "$forbidden" "$OUTFILE"; then
    echo "FAIL [$label]: rendered chart still contains: $forbidden"
    FAILED=1
  else
    echo "ok   [$label]"
  fi
}

# -----------------------------------------------------------------------------
# Background-worker tier (edgeFunctions.workerTier)
# -----------------------------------------------------------------------------
# The tier splits the edge fleet by isolation model: the four pg_cron-poked pgmq
# consumers get their own Deployment, their own admission budget and their own
# eszip cache, and Kong routes those function NAMES to it by path.
#
# The single most important property is that it is OFF by default and inert when
# off, because hosted supabase.com and `supabase functions serve` have neither the
# demuxer nor our Kong. Assert absence first.
echo "== background-worker tier is absent unless enabled =="
WT=(--set edgeFunctions.workerTier.enabled=true)
assert_absent "no worker-tier workload by default" "functions-workers"
assert_absent "no worker-tier Kong routes by default" "functions-v1-worker-"
assert_absent "no worker-tier availability alert by default" \
  "PawtograderEdgeWorkerTierUnavailable"

echo "== background-worker tier renders its own isolation config =="
assert_rendered_contains "worker tier renders a Deployment" \
  templates/edge-functions-worker-tier.yaml "kind: Deployment" "${WT[@]}"
# The two tiers must differ in the args that define the split. Pinning the REQUEST
# tier alongside is what catches the mutation hazard in the shared template:
# mergeOverwrite aliases sub-maps out of its source, so without deepCopy on both
# operands a tier's overrides leak into .Values and the request tier silently
# inherits them.
assert_cli_arg "worker tier graceful-exit is 60s, not the base 410s" \
  templates/edge-functions-worker-tier.yaml --graceful-exit-timeout 60 "${WT[@]}"
assert_cli_arg "request tier keeps graceful-exit 410s (no override leak)" \
  templates/edge-functions.yaml --graceful-exit-timeout 410 "${WT[@]}"
assert_env_value "worker tier eszip cache renders 192Mi in bytes" \
  templates/edge-functions-worker-tier.yaml EDGE_ESZIP_CACHE_MAX_BYTES 201326592 "${WT[@]}"
assert_env_value "request tier eszip cache stays 256Mi (no override leak)" \
  templates/edge-functions.yaml EDGE_ESZIP_CACHE_MAX_BYTES 268435456 "${WT[@]}"
assert_container_memory "worker tier limit is 3584Mi, not the base 4Gi" \
  templates/edge-functions-worker-tier.yaml functions limits 3584Mi "${WT[@]}"
# resources is a nested map, so a shallow merge would replace `limits` and drop
# `requests` entirely. Assert the sibling survived.
assert_container_memory "worker tier requests survive the deep merge" \
  templates/edge-functions-worker-tier.yaml functions requests 1Gi "${WT[@]}"
assert_container_memory "request tier limit stays 4Gi (no override leak)" \
  templates/edge-functions.yaml functions limits 4Gi "${WT[@]}"

# The Kong construction that fails quietly. strip_path removes the MATCHED route
# path, so a worker route pointed at a service url of ".../" delivers "/" upstream
# and main.ts answers 400 "missing function name in request path" on every poke.
# The function name MUST be in the service URL. This is the assertion that catches
# it, and it is the easiest thing in this change to break by tidying.
echo "== worker-tier Kong routes carry the function name in the upstream URL =="
assert_rendered_contains "worker route upstream ends in the function name" \
  templates/kong-config.yaml \
  "url: http://t-pawtograder-functions-workers:9000/github-async-worker" "${WT[@]}"
# ANCHORED, and this is the assertion that prevents a silently-wrong function.
# A plain prefix matches on the path string, not segment boundaries: measured
# against Kong 3.9.1, `/functions/v1/github-async-worker-v2` was routed to the
# worker tier AND rewritten to `/github-async-worker/-v2`, so the demuxer would
# read pathParts[0] and execute github-async-worker instead. Note the syntax is
# format-2.1 (no `~` prefix; Kong auto-detects the regex) -- the `~/` form is
# REJECTED by this config version.
assert_rendered_contains "worker route path is anchored to the function name" \
  templates/kong-config.yaml '- "/functions/v1/github-async-worker$"' "${WT[@]}"
assert_absent "no worker route uses an unanchored plain prefix" \
  "- /functions/v1/github-async-worker" "${WT[@]}"
assert_rendered_contains "request tier keeps the catch-all route" \
  templates/kong-config.yaml "- /functions/v1/" "${WT[@]}"
# hosts on a worker route would miss every in-cluster pg_net poke, because
# SUPABASE_URL is http://<kong-svc>:8000 and those requests carry the Kong service
# name as Host. That would send all worker traffic back to the request tier while
# looking correct.
assert_rendered_lacks "worker routes carry no hosts" \
  templates/kong-config.yaml "hosts:" "${WT[@]}" --set channels=null

echo "== worker-tier guards refuse the configurations that fail silently =="
assert_refused "enabled with no routed functions is refused" \
  "Kong routes this tier by function NAME" \
  "${WT[@]}" --set edgeFunctions.workerTier.functions=null
assert_refused "a channel named workers collides with the tier" \
  "collides with edgeFunctions.workerTier" \
  "${WT[@]}" --set channelWildcardTlsSecret=wc \
  --set 'channels[0].name=workers' --set 'channels[0].web.image.tag=v1' \
  --set 'channels[0].edgeFunctions.image.tag=v1'
# Sprig's mergeOverwrite (mergo) skips empty source values, so a mistyped or
# unsupported override key would be silently ignored rather than applied. The
# allowlist turns that into a render error.
# An EMPTY allowlisted override is the same failure as a disallowed key, just
# harder to see: mergeOverwrite skips empty source values, so the tier would
# silently keep the BASE's value while the values file said otherwise. Clearing
# the integration secrets off the worker tier is the one that would bite.
assert_refused "an empty list override is refused, not silently inherited" \
  "is empty" "${WT[@]}" -f /dev/stdin <<<'edgeFunctions: {workerTier: {envFromSecrets: []}}'
assert_refused "an empty map override is refused" \
  "is empty" "${WT[@]}" -f /dev/stdin <<<'edgeFunctions: {workerTier: {nodeSelector: {}}}'
assert_refused "an empty string override is refused" \
  "is empty" "${WT[@]}" -f /dev/stdin <<<'edgeFunctions: {workerTier: {priorityClassName: ""}}'
# A channel renders the Kong service functions-v1-<channel>; a routed worker
# renders functions-v1-worker-<fn>. A channel named worker-<fn> produces the SAME
# Kong entity name, and Kong rejects duplicate names outright -- so Kong fails to
# START and the whole deployment's API is down, not just that channel.
assert_refused "a channel named worker-<fn> is refused" \
  "collides with the worker route" \
  "${WT[@]}" --set channelWildcardTlsSecret=wc \
  --set 'channels[0].name=worker-github-async-worker' \
  --set 'channels[0].web.image.tag=v1' --set 'channels[0].edgeFunctions.image.tag=v1'
# This tier is reachable ONLY by Kong path routing. With Kong off the pods
# schedule and cost their full memory limit while every routed function keeps
# being served by the request tier -- the split silently does not exist.
assert_refused "the tier without Kong is refused" \
  "kong.enabled is false" \
  "${WT[@]}" --set kong.enabled=false
# A duplicate renders two Kong services and two routes with the same name, and
# Kong rejects a declarative config with duplicate entity names outright -- so
# Kong does not start and the whole deployment's API is down, not just this tier.
assert_refused "a duplicated worker function name is refused" \
  "more than once" \
  "${WT[@]}" --set 'edgeFunctions.workerTier.functions={github-async-worker,github-async-worker}'
assert_refused "an unrecognised override key is refused, not ignored" \
  "is not an overridable per-tier key" \
  "${WT[@]}" --set edgeFunctions.workerTier.polciy=oneshot
# A routed tier exists partly so it never evicts: it serves a handful of bundles,
# all of them hot. Sized off the LARGEST bundle, not the median -- averaging
# bundle sizes is how 2026-08-19 happened.
# 5, not 4: `metrics` is hot on every tier and in no route list -- the
# ServiceMonitor scrapes /metrics, the demuxer resolves it by first path segment
# like any other function, and its bundle stays resident at the scrape interval.
assert_refused "a cache too small to hold every hot bundle is refused" \
  "needed to hold all 5 hot bundles" \
  "${WT[@]}" --set edgeFunctions.workerTier.eszipCacheMaxMb=128
# Under per_worker an isolate is reused, so a routed tier needs one resident
# isolate per routed function, doubled for beforeUnload recycling overlap.
assert_refused "per_worker with too few admission slots is refused" \
  "needs at least 8 admission slots" \
  "${WT[@]}" --set edgeFunctions.workerTier.policy=per_worker \
  --set edgeFunctions.workerTier.maxParallelism=6
# Each tier has its OWN budget. A failure that named edgeFunctions.* would send
# the reader to the wrong values block, which defeats the point of the assertion.
assert_refused "the worker tier's budget failure names the worker tier" \
  "edgeFunctions.workerTier memory budget does not fit" \
  "${WT[@]}" --set edgeFunctions.workerTier.resources.limits.memory=2935Mi
assert_renders "worker tier accepts a limit exactly equal to its sum (2936Mi)" \
  "${WT[@]}" --set edgeFunctions.workerTier.resources.limits.memory=2936Mi

# A Kong plain-prefix path also matches LONGER paths, so /functions/v1/<worker>
# would swallow /functions/v1/<worker>-something. Nothing collides today
# (gradebook-column-inserted vs gradebook-column-recalculate diverge before the
# boundary), but that is luck rather than design: a future function whose name
# extends a worker's would be silently routed to the worker tier and 404 there.
# Checked against the real tree, not a hardcoded list.
echo "== worker-tier override surface is honoured, not merely accepted =="
# `image` is on the allowlist AND the workload takes its image from an ARGUMENT,
# so passing the base image would accept workerTier.image in values and silently
# run the base image anyway -- the exact "accepted then ignored" failure the
# allowlist exists to prevent.
assert_rendered_contains "workerTier.image.tag actually changes the running image" \
  templates/edge-functions-worker-tier.yaml "edge-functions:wt-canary" \
  "${WT[@]}" --set edgeFunctions.workerTier.image.tag=wt-canary
# Booleans cannot survive mergeOverwrite, so they must be refused rather than
# accepted-and-ignored. spreadAcrossNodes was briefly on the allowlist.
assert_refused "a boolean override (spreadAcrossNodes) is refused, not ignored" \
  "is not an overridable per-tier key" \
  "${WT[@]}" --set edgeFunctions.workerTier.spreadAcrossNodes=false
# replicas: 0 is a supported way to idle the tier, so an availability alert whose
# expression is `replicas_available == 0` must not render -- it would be
# permanently true and page continuously five minutes after deploy.
assert_absent "availability alert is absent when the tier is idled at 0 replicas" \
  "PawtograderEdgeWorkerTierUnavailable" \
  "${WT[@]}" --set edgeFunctions.workerTier.replicas=0 \
  --set monitoring.enabled=true --set monitoring.prometheusRules.labels.release=kps
assert_rendered_contains "availability alert IS present at a positive replica count" \
  templates/prometheus-rules.yaml "PawtograderEdgeWorkerTierUnavailable" \
  "${WT[@]}" --set monitoring.enabled=true --set monitoring.prometheusRules.labels.release=kps

echo "== no routed worker name shadows another function's path =="
shadow_check() {
  local fns_dir="$CHART/../../supabase/functions" bad=0 w f
  local workers
  workers="$(helm template t "$CHART" "${BASE[@]}" "${WT[@]}" \
    --show-only templates/kong-config.yaml 2>/dev/null \
    | sed -nE 's#^[ \t]*- "/functions/v1/([a-z0-9-]+)[$]"$#\1#p' | sort -u)"
  if [ -z "$workers" ]; then
    echo "FAIL [prefix shadowing]: could not read routed worker names from the render"
    FAILED=1
    return
  fi
  for w in $workers; do
    for f in "$fns_dir"/*/; do
      f="$(basename "$f")"
      [ "$f" = "$w" ] && continue
      [ -f "$fns_dir/$f/index.ts" ] || continue
      case "$f" in
        "$w"*) echo "FAIL [prefix shadowing]: function $f is shadowed by the worker route /functions/v1/$w"; bad=1 ;;
      esac
    done
  done
  [ "$bad" -eq 0 ] && echo "ok   [no routed worker name is a prefix of another function name]" || FAILED=1
}
shadow_check

echo
if [ "$FAILED" -ne 0 ]; then
  echo "GUARD-RAIL TESTS FAILED"
  exit 1
fi
echo "All guard-rail render tests passed."
