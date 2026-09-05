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
  # One web replica, and the workflow-metrics gap acknowledged. Chart 0.3.18
  # added a guard that refuses monitoring.enabled with no metrics leader of
  # either kind, and roughly a dozen cases below enable monitoring to exercise a
  # guard that has nothing to do with workflow metrics.
  #
  # Pinning to one replica used to be enough to keep that rule dormant. It is
  # not any more, and that was the bug: the rule was gated on replicas > 1, so
  # the single most ordinary install — monitoring on, one replica, no leader —
  # slipped through silently. The acknowledgement is the honest way to say "this
  # case is not about workflow metrics". Every case that actually exercises the
  # rule sets it back to false after this (helm's last-`--set`-wins), so nothing
  # is masked.
  --set web.replicas=1
  --set monitoring.allowMissingWorkflowMetrics=true
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
  elif grep -qF "$forbidden" "$OUTFILE"; then
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


# assert_web_render_unchanged
# templates/_web-workload.tpl is shared by templates/web.yaml (the production web
# tier) and templates/web-channels.yaml (the live canary channel). Chart 0.3.18
# parameterized it — a `config` arg for the pod shape, a `workflowLeader` arg, a
# `refreshIntervalSeconds` arg — so a dedicated metrics-leader Deployment could
# reuse the exact same pod spec. That refactor is only safe if it is a NO-OP for
# the two pre-existing call sites.
#
# It is not a stylistic concern. A single byte of difference in those manifests is
# a full rolling restart of every prod web replica plus the canary on a deploy
# that was advertised as purely additive, and the ONLY ungated item in that
# change (everything else sits behind web.metricsLeader.enabled, default false).
#
# So: render both templates from the chart as it exists in git at the merge base
# and from the working tree, against every consumer values file, and require the
# bytes to match. Note that emitted `#` YAML comments count — if you reword the
# explanatory comment next to an env var, this fires. That is deliberate: the
# check is only trustworthy if it is exact, and a comment reword is trivially
# reverted or moved into a {{/* */}} template comment, which is not emitted.
#
# ONE normalization is applied before comparing: the `helm.sh/chart:
# pawtograder-<version>` label, which every manifest carries and which changes on
# every chart bump by construction. That label is genuinely part of the pod
# template, so a chart-version bump DOES roll every Deployment in this chart —
# that is pre-existing behaviour of the chart and true of any release, not
# something a template refactor can cause or avoid. Comparing it would make the
# assertion fail on the version bump and never on the thing it exists to catch.
# Nothing else is normalized; emitted `#` YAML comments and whitespace are
# compared exactly.
#
# Skipped (not failed) when git or the base ref is unavailable, so the script
# still runs from a tarball; CI runs it from a checkout, where it does execute.
WEB_RENDER_BASE_REF="${WEB_RENDER_BASE_REF:-2b8defc1}"
assert_web_render_unchanged() {
  local label="web.yaml + web-channels.yaml render byte-identically to $WEB_RENDER_BASE_REF"
  local repo
  repo="$(cd "$CHART/../.." && pwd)"
  if ! command -v git >/dev/null 2>&1 || ! git -C "$repo" rev-parse --verify --quiet "$WEB_RENDER_BASE_REF^{commit}" >/dev/null; then
    echo "skip [$label]: git or base ref $WEB_RENDER_BASE_REF unavailable"
    return
  fi
  local tmp base_chart
  tmp="$(mktemp -d)"
  base_chart="$tmp/base/charts/pawtograder"
  mkdir -p "$tmp/base"
  if ! git -C "$repo" archive "$WEB_RENDER_BASE_REF" charts/pawtograder | tar -x -C "$tmp/base" 2>/dev/null; then
    echo "skip [$label]: could not export the chart at $WEB_RENDER_BASE_REF"
    rm -rf "$tmp"
    return
  fi

  # Values files this chart is actually consumed with. Anything under examples/
  # is in scope; the real production overlay lives in the prod-charts repo and is
  # included when that checkout is present next to this one.
  local -a vsets=()
  local f
  for f in "$CHART"/examples/values-*.yaml; do
    [ -e "$f" ] && vsets+=("$f")
  done
  # The branding skin is only meaningful layered on a base overlay.
  vsets+=("$CHART/examples/values-staging.yaml,$CHART/examples/values-tartangrader.yaml")
  vsets+=("")   # chart defaults
  local prod_overlay="$repo/../prod-charts/values/values-prod.yaml"
  if [ -f "$prod_overlay" ]; then
    vsets+=("$prod_overlay")
    # ...and the same overlay with the new leader turned on, which is the state
    # production is meant to end up in. Enabling the leader must ALSO leave the
    # web/channel manifests untouched, or flipping that gate is a web restart.
    vsets+=("$prod_overlay|--set web.metricsLeader.enabled=true")
  fi

  # Pins that make the shipped example overlays render at all (they carry
  # deliberate REPLACE_ME placeholders), plus the rule-4 acknowledgement so a
  # values file that has not yet adopted the leader still renders on both sides.
  # The pre-refactor chart ignores unknown values keys, so these are inert there.
  local -a pins=(
    --set monitoring.prometheusRules.labels.release=kps
    --set web.image.tag=v1.0.0
    --set edgeFunctions.image.tag=v1.0.0
    --set migrations.image.tag=v1.0.0
    --set postgres.persistence.storageClass=fast
    --set postgres.walg.s3Prefix=s3://b/walg
    --set backup.enabled=false
    --set monitoring.allowMissingWorkflowMetrics=true
  )

  # Chart version on each side, for the label normalization described above.
  local base_ver head_ver
  base_ver="$(awk '/^version:/ { print $2; exit }' "$base_chart/Chart.yaml")"
  head_ver="$(awk '/^version:/ { print $2; exit }' "$CHART/Chart.yaml")"

  local bad=0 n=0 vs tmpl
  for vs in "${vsets[@]}"; do
    local -a args=() extra=()
    local files="${vs%%|*}" over="" IFS_SAVE
    case "$vs" in *"|"*) over="${vs#*|}" ;; esac
    # shellcheck disable=SC2206
    [ -n "$over" ] && extra=($over)
    local ff
    IFS=',' read -ra ffs <<< "$files"
    for ff in "${ffs[@]}"; do [ -n "$ff" ] && args+=(-f "$ff"); done
    for tmpl in web.yaml web-channels.yaml; do
      local a="$tmp/a" b="$tmp/b"
      helm template pawtograder "$base_chart" "${args[@]}" "${pins[@]}" "${extra[@]}" \
        --namespace pawtograder-prod --show-only "templates/$tmpl" >"$a" 2>"$a.err"
      local rca=$?
      helm template pawtograder "$CHART" "${args[@]}" "${pins[@]}" "${extra[@]}" \
        --namespace pawtograder-prod --show-only "templates/$tmpl" >"$b" 2>"$b.err"
      local rcb=$?
      sed -i "s/pawtograder-${base_ver}/pawtograder-CHARTVERSION/g" "$a"
      sed -i "s/pawtograder-${head_ver}/pawtograder-CHARTVERSION/g" "$b"
      n=$((n + 1))
      if [ "$rca" -ne "$rcb" ]; then
        echo "FAIL [$label]: $tmpl with '${vs:-<defaults>}' changed render status ($rca -> $rcb)"
        head -1 "$b.err"
        bad=1
      elif [ "$rca" -eq 0 ] && ! cmp -s "$a" "$b"; then
        echo "FAIL [$label]: $tmpl differs with values '${vs:-<defaults>}'"
        diff -u "$a" "$b" | head -40
        bad=1
      fi
    done
  done
  rm -rf "$tmp"
  if [ "$bad" -ne 0 ]; then FAILED=1; else echo "ok   [$label] ($n renders compared)"; fi
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
  templates/postgres-exporter-queries.yaml "queries.yaml: |" \
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
      --show-only templates/postgres-exporter-queries.yaml >"$OUTFILE" 2>"$ERRFILE"; then
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
      --show-only templates/postgres-exporter-queries.yaml >"$OUTFILE" 2>"$ERRFILE"; then
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
# so prove it still REFUSES rather than trusting that it would. 2650Mi is the exact
# sum at the current defaults (256 + 256 + 8 x 256 + 90), so one MiB below it is
# the tightest possible negative case and it also pins the arithmetic itself.
assert_refused "memory budget refuses a limit one MiB below the computed sum" \
  "+ ~90Mi Deno host = 2650Mi" \
  --set edgeFunctions.resources.limits.memory=2649Mi
assert_renders "memory budget accepts a limit exactly equal to the computed sum" \
  --set edgeFunctions.resources.limits.memory=2650Mi
# eszipColdLoadHeadroomMb must still cover the largest bundle in the image. It is
# NOT reduced alongside the cache: halving the cache makes cold reads MORE frequent.
assert_refused "cold-load allowance below the largest bundle is refused" \
  "below the 64Mi needed to cover the largest bundle" \
  --set edgeFunctions.eszipColdLoadHeadroomMb=32

# The HPA controller applies a default 10% tolerance, so a target of 100 is a dead
# band of 90-110%. The edge tier's load-independent floor sat inside that band,
# which wedged scaling in BOTH directions: it could not scale down (needs <90%) and
# at 109% under load it could not scale up (needs >110%). 80 puts the band at
# 72-88%, between the measured ~56% floor and ~146% loaded peak. Pin it so the
# value cannot drift back to a number whose dead band swallows the floor.
echo "== edge-function HPA targets are pinned (dead-band sizing, 2026-08-28) =="
assert_hpa_utilization "memory target renders 80, not 100" memory 80
assert_hpa_utilization "cpu target renders 200" cpu 200

# -----------------------------------------------------------------------------
# Workflow-metrics leader (chart 0.3.18)
# -----------------------------------------------------------------------------
# A prod-shaped install: monitoring on, several web replicas. Under those values
# the four workflow gauge families have no producer unless a leader exists, which
# is what the guards below are about.
LEADER_BASE=(
  --set monitoring.enabled=true
  --set monitoring.prometheusRules.labels.release=kps
  --set web.replicas=3
  # Undo the baseline acknowledgement: this block is where rule 4 is under test.
  --set monitoring.allowMissingWorkflowMetrics=false
)

echo "== metrics-leader validations =="
# Rule 1: the two leader mechanisms are mutually exclusive. Pinned at replicas=1
# so the pre-existing replicas>1 guard cannot be the thing that refuses it —
# otherwise this case would pass for the wrong reason.
assert_refused "both leader mechanisms at once" \
  "mutually exclusive" \
  --set monitoring.enabled=true --set monitoring.prometheusRules.labels.release=kps \
  --set web.replicas=1 --set web.metricsLeader.enabled=true --set web.workflowMetricsLeader=true
# Rule 2: without monitoring there is no METRICS_SCRAPE_TOKEN, so /api/metrics
# 503s and the leader is a pod that costs memory and does nothing.
assert_refused "metrics leader without monitoring" \
  "requires monitoring.enabled=true" \
  --set web.metricsLeader.enabled=true
# Rule 3: the leader IS the web image and reuses the web pod shape.
assert_refused "metrics leader without the web tier" \
  "requires web.enabled=true" \
  --set monitoring.enabled=true --set monitoring.prometheusRules.labels.release=kps \
  --set web.enabled=false --set web.metricsLeader.enabled=true
# Rule 4: monitoring + an enabled web tier + no leader = nine permanently empty
# panels. This one is a BREAKING upgrade for installs already in that state, so
# the message must name the exact values that clear it; assert on both.
assert_refused "multi-replica web with monitoring and no leader" \
  "exports NO workflow metrics" "${LEADER_BASE[@]}"
assert_refused "rule 4 names the leader value that fixes it" \
  "web.metricsLeader.enabled: true" "${LEADER_BASE[@]}"
assert_refused "rule 4 names the escape hatch" \
  "monitoring.allowMissingWorkflowMetrics: true" "${LEADER_BASE[@]}"
# ...and at ONE replica, which is the case the rule used to skip. Nothing sets
# METRICS_WORKFLOW_REFRESH_LEADER here either, the web ServiceMonitor scrapes
# happily, and every workflow family stays empty — the silent configuration the
# rule exists to catch, previously reachable without acknowledging anything.
assert_refused "single-replica web with monitoring and no leader" \
  "exports NO workflow metrics" \
  --set monitoring.enabled=true --set monitoring.prometheusRules.labels.release=kps \
  --set web.replicas=1 --set monitoring.allowMissingWorkflowMetrics=false
# The single-replica remedy is the flag, and the message must say so.
assert_refused "rule 4 names the single-replica remedy" \
  "set \`web.workflowMetricsLeader: true\`" \
  --set monitoring.enabled=true --set monitoring.prometheusRules.labels.release=kps \
  --set web.replicas=1 --set monitoring.allowMissingWorkflowMetrics=false

echo "== metrics-leader renders =="
assert_renders "prod shape with the dedicated leader renders" \
  "${LEADER_BASE[@]}" --set web.metricsLeader.enabled=true
assert_renders "prod shape without a leader renders once acknowledged" \
  "${LEADER_BASE[@]}" --set monitoring.allowMissingWorkflowMetrics=true
# The single-pod flag is NOT deprecated: on one replica it is strictly better
# than a dedicated leader (no extra pod) and must keep working.
assert_renders "single-replica install may still use web.workflowMetricsLeader" \
  --set monitoring.enabled=true --set monitoring.prometheusRules.labels.release=kps \
  --set web.replicas=1 --set web.workflowMetricsLeader=true \
  --set monitoring.allowMissingWorkflowMetrics=false

# The absence alert must render for EITHER leader mechanism. It used to be gated
# on the dedicated Deployment alone, which left single-replica installs with no
# coverage at all: if that web target is not scraped, the refresh-errors counter
# is absent too, so neither rule in the group can fire.
assert_rendered_contains "stale alert renders for the in-web leader" \
  templates/prometheus-rules.yaml "alert: PawtograderWorkflowMetricsStale" \
  --set monitoring.enabled=true --set monitoring.prometheusRules.labels.release=kps \
  --set web.replicas=1 --set web.workflowMetricsLeader=true \
  --set monitoring.allowMissingWorkflowMetrics=false
assert_rendered_contains "stale alert names the in-web mechanism" \
  templates/prometheus-rules.yaml "web.workflowMetricsLeader, single-replica mode" \
  --set monitoring.enabled=true --set monitoring.prometheusRules.labels.release=kps \
  --set web.replicas=1 --set web.workflowMetricsLeader=true \
  --set monitoring.allowMissingWorkflowMetrics=false
assert_rendered_contains "stale alert names the dedicated mechanism" \
  templates/prometheus-rules.yaml "web.metricsLeader.enabled" \
  "${LEADER_BASE[@]}" --set web.metricsLeader.enabled=true
# With no leader at all the absence alert is meaningless — absence IS the
# configured state — so it must not render.
assert_rendered_lacks "no stale alert without a leader" \
  templates/prometheus-rules.yaml "alert: PawtograderWorkflowMetricsStale" \
  "${LEADER_BASE[@]}" --set monitoring.allowMissingWorkflowMetrics=true

echo "== the leader env vars land on the leader and NOWHERE else =="
assert_env_value "leader renders METRICS_WORKFLOW_REFRESH_LEADER=true" \
  templates/web-metrics-leader.yaml METRICS_WORKFLOW_REFRESH_LEADER true \
  "${LEADER_BASE[@]}" --set web.metricsLeader.enabled=true
assert_env_value "leader renders the refresh interval" \
  templates/web-metrics-leader.yaml METRICS_WORKFLOW_REFRESH_INTERVAL_SECONDS 300 \
  "${LEADER_BASE[@]}" --set web.metricsLeader.enabled=true
assert_env_value "refresh interval is settable" \
  templates/web-metrics-leader.yaml METRICS_WORKFLOW_REFRESH_INTERVAL_SECONDS 60 \
  "${LEADER_BASE[@]}" --set web.metricsLeader.enabled=true \
  --set web.metricsLeader.refreshIntervalSeconds=60
# The whole point of the dedicated leader is that the ordinary web replicas are
# NOT leaders. If this leaks into web.yaml, three pods refresh the same RPCs and
# every workflow gauge reads 4x under sum().
assert_rendered_lacks "web.yaml carries no leader env" \
  templates/web.yaml "METRICS_WORKFLOW_REFRESH_LEADER" \
  "${LEADER_BASE[@]}" --set web.metricsLeader.enabled=true
assert_rendered_lacks "web.yaml carries no refresh-interval env" \
  templates/web.yaml "METRICS_WORKFLOW_REFRESH_INTERVAL_SECONDS" \
  "${LEADER_BASE[@]}" --set web.metricsLeader.enabled=true
# A channel must never become a second leader; web-channels.yaml hard-codes false.
assert_rendered_lacks "channels carry no leader env" \
  templates/web-channels.yaml "METRICS_WORKFLOW_REFRESH_LEADER" \
  "${LEADER_BASE[@]}" --set web.metricsLeader.enabled=true \
  --set 'channels[0].name=canary' \
  --set 'channels[0].web.image.tag=v1.0.0' \
  --set 'channels[0].web.hostname=canary.pawtograder.example.com' \
  --set channelWildcardTlsSecret=wildcard-tls

echo "== leader pod shape: exactly one replica, Recreate rollout =="
# Both are structural, not tuning. Two leaders double the DB load and double-count
# every global gauge; RollingUpdate briefly runs two leaders on every deploy,
# which is the same failure on a timer. `replicas` is deliberately not a value.
assert_rendered_contains "leader renders replicas: 1" \
  templates/web-metrics-leader.yaml "replicas: 1" \
  "${LEADER_BASE[@]}" --set web.metricsLeader.enabled=true
assert_rendered_contains "leader renders strategy type Recreate" \
  templates/web-metrics-leader.yaml "type: Recreate" \
  "${LEADER_BASE[@]}" --set web.metricsLeader.enabled=true
# ...and NOT a rollingUpdate block: a deep merge of web's updateStrategy over the
# leader's would leave maxSurge/maxUnavailable attached to type: Recreate, which
# the apiserver rejects outright.
assert_rendered_lacks "leader renders no rollingUpdate block" \
  templates/web-metrics-leader.yaml "rollingUpdate" \
  "${LEADER_BASE[@]}" --set web.metricsLeader.enabled=true
# `replicas` must not be reachable as a value: if someone adds the key later,
# this catches it before two leaders reach a cluster.
assert_rendered_contains "web.metricsLeader.replicas is not a knob" \
  templates/web-metrics-leader.yaml "replicas: 1" \
  "${LEADER_BASE[@]}" --set web.metricsLeader.enabled=true \
  --set web.metricsLeader.replicas=4

echo "== leader component label keeps it off every user-traffic path =="
# The distinct component label is the ONLY thing separating the leader from the
# web tier: same image, same port, same Service shape. If the leader's Service
# selector ever says component: web it silently joins the ingress backend's
# endpoints and starts serving students.
assert_rendered_contains "leader Service selects component metrics-leader" \
  templates/web-metrics-leader.yaml "app.kubernetes.io/component: metrics-leader" \
  "${LEADER_BASE[@]}" --set web.metricsLeader.enabled=true
assert_rendered_lacks "leader manifest never claims component web" \
  templates/web-metrics-leader.yaml "app.kubernetes.io/component: web" \
  "${LEADER_BASE[@]}" --set web.metricsLeader.enabled=true
assert_rendered_contains "web Service still selects component web" \
  templates/web.yaml "app.kubernetes.io/component: web" \
  "${LEADER_BASE[@]}" --set web.metricsLeader.enabled=true
assert_rendered_lacks "web manifest never claims component metrics-leader" \
  templates/web.yaml "app.kubernetes.io/component: metrics-leader" \
  "${LEADER_BASE[@]}" --set web.metricsLeader.enabled=true

echo "== leader ServiceMonitor =="
assert_rendered_contains "leader ServiceMonitor selects component metrics-leader" \
  templates/monitoring.yaml "app.kubernetes.io/component: metrics-leader" \
  "${LEADER_BASE[@]}" --set web.metricsLeader.enabled=true
# Toggleable like serviceMonitors.storage, and absent entirely without a leader.
# The toggle now needs the acknowledgement too — see the assert_refused below.
assert_rendered_lacks "no leader ServiceMonitor when the toggle is off" \
  templates/monitoring.yaml "component: metrics-leader" \
  "${LEADER_BASE[@]}" --set web.metricsLeader.enabled=true \
  --set monitoring.serviceMonitors.metricsLeader=false \
  --set monitoring.allowUnscrapedMetricsLeader=true
# A leader nobody scrapes exports NOTHING: refreshWorkflowMetrics() runs only
# while /api/metrics is being served, so with no ServiceMonitor the pod is
# healthy and the dashboard is empty. Same outcome as having no leader at all,
# one setting further along, and it must be refused the same way.
assert_refused "leader enabled with its ServiceMonitor switched off" \
  "renders a metrics leader that NOTHING SCRAPES" \
  "${LEADER_BASE[@]}" --set web.metricsLeader.enabled=true \
  --set monitoring.serviceMonitors.metricsLeader=false
assert_rendered_lacks "no leader ServiceMonitor without a leader" \
  templates/monitoring.yaml "component: metrics-leader" \
  "${LEADER_BASE[@]}" --set monitoring.allowMissingWorkflowMetrics=true

echo "== _web-workload.tpl refactor is a no-op for web.yaml and web-channels.yaml =="
assert_web_render_unchanged

# assert_edge_metrics_buckets
# EDGE_METRICS_BUCKETS is a histogram definition rendered from a values list, and
# a histogram whose bounds are not strictly increasing is not a histogram:
# histogram_quantile() consumes the cumulative _bucket series and returns
# plausible-looking garbage rather than failing, so a bad list is invisible at
# every layer above this one.
#
# The second half is the one that actually bites. edgeFunctions.worker.timeoutMs
# is the worker LIFETIME (400s by default). If the top FINITE bucket sits below
# that, every request that runs to the worker timeout lands in +Inf, and every
# quantile above wherever the real mass ends becomes an extrapolation off the last
# finite bound -- p95 and p99 stop meaning anything at exactly the moment the tier
# is in trouble. Raising worker.timeoutMs without extending the buckets is the
# realistic way to get there, which is why this is asserted rather than commented,
# and why the check is derived from the rendered timeout rather than hard-coded.
assert_edge_metrics_buckets() {
  local label="EDGE_METRICS_BUCKETS is monotonic and covers worker.timeoutMs"
  if ! helm template t "$CHART" "${BASE[@]}" \
      --set edgeFunctions.metrics.enabled=true \
      "$@" --show-only templates/edge-functions.yaml >"$OUTFILE" 2>"$ERRFILE"; then
    echo "FAIL [$label]: render was REFUSED but should have succeeded"
    echo "       got: $(grep -oiE 'Error:.*' "$ERRFILE" | head -1)"
    FAILED=1
    return
  fi
  local buckets timeout_ms
  buckets="$(grep -A1 -E '^[[:space:]]*- name: EDGE_METRICS_BUCKETS$' "$OUTFILE" \
              | grep -E '^[[:space:]]*value:' \
              | head -1 | sed -E 's/^[[:space:]]*value:[[:space:]]*"?([^"]*)"?[[:space:]]*$/\1/')"
  timeout_ms="$(grep -A1 -E '^[[:space:]]*- name: EDGE_WORKER_TIMEOUT_MS$' "$OUTFILE" \
              | grep -E '^[[:space:]]*value:' \
              | head -1 | sed -E 's/^[[:space:]]*value:[[:space:]]*"?([^"]*)"?[[:space:]]*$/\1/')"
  if [ -z "$buckets" ]; then
    echo "FAIL [$label]: EDGE_METRICS_BUCKETS is not rendered at all"
    FAILED=1
    return
  fi
  if [ -z "$timeout_ms" ]; then
    echo "FAIL [$label]: EDGE_WORKER_TIMEOUT_MS is not rendered, so the top bucket cannot be checked"
    FAILED=1
    return
  fi
  local prev="" top="" b
  local bad=0
  IFS=',' read -ra _BUCKETS <<< "$buckets"
  for b in "${_BUCKETS[@]}"; do
    b="$(echo "$b" | tr -d '[:space:]')"
    if [ -z "$b" ] || ! echo "$b" | grep -qE '^[0-9]+(\.[0-9]+)?$'; then
      echo "FAIL [$label]: bucket bound $(printf '%q' "$b") is not a positive number"
      bad=1
      break
    fi
    if [ -n "$prev" ] && ! awk -v a="$prev" -v c="$b" 'BEGIN{exit !(c>a)}'; then
      echo "FAIL [$label]: buckets are not strictly increasing ($prev then $b) in: $buckets"
      bad=1
      break
    fi
    prev="$b"
    top="$b"
  done
  if [ "$bad" -ne 0 ]; then FAILED=1; return; fi
  if ! awk -v top="$top" -v ms="$timeout_ms" 'BEGIN{exit !(top >= ms/1000)}'; then
    echo "FAIL [$label]: top finite bucket ${top}s is below worker.timeoutMs (${timeout_ms}ms)."
    echo "       Every request that hits the worker timeout would land in +Inf and the upper"
    echo "       quantiles would be an extrapolation. Extend edgeFunctions.metrics.buckets."
    FAILED=1
  else
    echo "ok   [$label]"
  fi
}

echo "== edge metrics histogram buckets =="
assert_edge_metrics_buckets
# A raised worker timeout with the default bucket list must be caught, not
# silently produce unusable quantiles.
FAILED_BEFORE="$FAILED"
FAILED=0
assert_edge_metrics_buckets --set edgeFunctions.worker.timeoutMs=900000 >/dev/null 2>&1
if [ "$FAILED" -eq 0 ]; then
  echo "FAIL [buckets shorter than the worker lifetime are refused]: the check passed but should have failed"
  FAILED=1
else
  echo "ok   [buckets shorter than the worker lifetime are refused]"
  FAILED=0
fi
FAILED="$FAILED_BEFORE"

# The gate must actually gate: no EDGE_METRICS_BUCKETS consumer without it, but
# the env var itself renders either way (the collector reads EDGE_METRICS, not
# the presence of the bucket list) so a values-only flip needs no pod respec
# beyond the one variable.
assert_env_value "EDGE_METRICS off by default" \
  templates/edge-functions.yaml EDGE_METRICS 0
assert_env_value "EDGE_METRICS on when enabled" \
  templates/edge-functions.yaml EDGE_METRICS 1 \
  --set edgeFunctions.metrics.enabled=true

echo "== WS-APP business metrics come from postgres_exporter, not the web tier =="
# postgres_exporter names a series <block>_<column>, so the block name and the
# column name TOGETHER are the metric name the dashboard queries. Renaming
# either half silently blanks six panels on app-business.json, and nothing else
# in this repo connects the two. These four assertions are that connection.
assert_rendered_contains "submissions block emits pawtograder_submissions_created_total" \
  templates/postgres-exporter-queries.yaml "pawtograder_submissions_created:" \
  --set monitoring.enabled=true --set web.metricsLeader.enabled=true \
  --set monitoring.prometheusRules.labels.release=kps
assert_rendered_contains "grading block emits pawtograder_grading_actions_total" \
  templates/postgres-exporter-queries.yaml "pawtograder_grading_actions:" \
  --set monitoring.enabled=true --set web.metricsLeader.enabled=true \
  --set monitoring.prometheusRules.labels.release=kps
# assert_grading_actions_source
# The grading-actions block must read the trigger-maintained counter columns on
# class_metrics_totals, never a live COUNT(*) over the comment tables. A COUNT(*)
# is not monotonic: delete_assignment_with_all_data() hard-deletes all three
# comment tables and submission_reviews, and unrelease_all_grading_reviews_for_-
# assignment() flips released back to false in bulk. Prometheus reads either
# decrease as a counter RESET and renders the next scrape as a spike the size of
# the whole remaining total — on panels that sum across kinds, so it corrupts the
# stat and the topk table too, not just the by-kind series. See
# supabase/migrations/20260904140000_grading_action_counters.sql.
#
# cache_seconds must be ABSENT from this block. It is now a one-row-per-class
# read, and a cached counter is worse than a slow one: 300s of freeze makes
# rate(...[1m]) alternate between zero and five minutes of increment in one
# sample.
assert_grading_actions_source() {
  local label="grading-actions block reads the monotonic counter columns"
  if ! helm template t "$CHART" "${BASE[@]}" \
      --set monitoring.enabled=true --set web.metricsLeader.enabled=true \
      --set monitoring.prometheusRules.labels.release=kps \
      --show-only templates/postgres-exporter-queries.yaml >"$OUTFILE" 2>"$ERRFILE"; then
    echo "FAIL [$label]: render was REFUSED but should have succeeded"
    FAILED=1
    return
  fi
  local stanza
  stanza="$(awk -v b="    pawtograder_grading_actions:" '
    $0 == b { inb = 1; next }
    inb && /^    [^ ]/ { exit }
    inb { print }
  ' "$OUTFILE")"
  local bad=0
  local col
  for col in grading_actions_comment_total grading_actions_rubric_check_total grading_actions_release_total public.class_metrics_totals; do
    if ! printf '%s\n' "$stanza" | grep -qF "$col"; then
      echo "FAIL [$label]: block does not read $col"
      bad=1
    fi
  done
  if printf '%s\n' "$stanza" | grep -qE 'COUNT\(\*\)|UNION ALL'; then
    echo "FAIL [$label]: block still scans the comment tables"
    bad=1
  fi
  if printf '%s\n' "$stanza" | grep -qF "cache_seconds"; then
    echo "FAIL [$label]: block sets cache_seconds; a cached counter breaks short-window rate()"
    bad=1
  fi
  if [ "$bad" -ne 0 ]; then FAILED=1; else echo "ok   [$label]"; fi
}
assert_grading_actions_source

echo "== storage-api /metrics must stay OFF on this image =="
# PROMETHEUS_METRICS_ENABLED registers GET /metrics on storage-api's main app,
# and handleMetricsRequest then writes the reply without returning it, so
# fastify double-writes the head on the first scrape: ERR_HTTP_HEADERS_SENT ->
# uncaughtException -> PID 1 exits. Setting the flag does not yield metrics, it
# crashloops the storage tier on the scrape interval (staging, 2026-09-04).
#
# So the flag must never render, and the ServiceMonitor must not render by
# default either -- without the flag it is a permanently-DOWN 404 target.
assert_rendered_lacks "storage never sets PROMETHEUS_METRICS_ENABLED (crashloops the pod)" \
  templates/storage.yaml "PROMETHEUS_METRICS_ENABLED" \
  --set monitoring.enabled=true --set web.metricsLeader.enabled=true \
  --set monitoring.prometheusRules.labels.release=kps

# assert_no_storage_servicemonitor
# Whole-chart render: with monitoring fully on, there must be no storage
# ServiceMonitor. Anchored on the ServiceMonitor kind so the storage Service and
# Deployment (which legitimately render) cannot satisfy or defeat it.
assert_no_storage_servicemonitor() {
  local label="no storage ServiceMonitor by default"
  if ! helm template t "$CHART" "${BASE[@]}" \
      --set monitoring.enabled=true --set web.metricsLeader.enabled=true \
      --set monitoring.prometheusRules.labels.release=kps \
      >"$OUTFILE" 2>"$ERRFILE"; then
    echo "FAIL [$label]: render was REFUSED but should have succeeded"
    FAILED=1
    return
  fi
  if awk '/^kind: ServiceMonitor$/{sm=1} /^  name: t-pawtograder-storage$/{if(sm)found=1} /^---$/{sm=0} END{exit !found}' "$OUTFILE"; then
    echo "FAIL [$label]: a storage ServiceMonitor rendered; without the flag it is a permanent 404 target"
    FAILED=1
    return
  fi
  # Sanity: the same render must still contain OTHER ServiceMonitors, or the
  # assertion above would pass simply because monitoring did not render at all.
  if ! grep -qE '^kind: ServiceMonitor$' "$OUTFILE"; then
    echo "FAIL [$label]: no ServiceMonitors at all; assertion is not testing anything"
    FAILED=1
    return
  fi
  echo "ok   [$label]"
}
assert_no_storage_servicemonitor

# Opt-in still works, for a deploy that scrapes the admin app or runs a fixed
# image. The toggle is the documented escape hatch, so it must not rot.
#
# NOT assert_rendered_contains "kind: ServiceMonitor": monitoring.yaml renders
# several of them, so that would pass whether or not the storage one appeared.
assert_storage_servicemonitor_optin() {
  local label="storage ServiceMonitor renderable on explicit opt-in"
  if ! helm template t "$CHART" "${BASE[@]}" \
      --set monitoring.enabled=true --set web.metricsLeader.enabled=true \
      --set monitoring.prometheusRules.labels.release=kps \
      --set monitoring.serviceMonitors.storage=true \
      >"$OUTFILE" 2>"$ERRFILE"; then
    echo "FAIL [$label]: render was REFUSED but should have succeeded"
    FAILED=1
    return
  fi
  if awk '/^kind: ServiceMonitor$/{sm=1} /^  name: t-pawtograder-storage$/{if(sm)found=1} /^---$/{sm=0} END{exit !found}' "$OUTFILE"; then
    echo "ok   [$label]"
  else
    echo "FAIL [$label]: opt-in did not render a storage ServiceMonitor; the escape hatch is broken"
    FAILED=1
  fi
}
assert_storage_servicemonitor_optin

echo "== edge /metrics demuxer must not re-emit a decoded body as encoded =="
# assert_edge_metrics_encoding
# Source-shape assertion (like assert_grading_actions_source above), on
# images/edge-functions/main.ts rather than on a render. A functional test needs
# the real runtime image AND a reachable Postgres for the metrics worker to
# return 200, so it cannot run in chart CI, but the regression it guards took
# down the whole edge target once already and would do so silently again.
#
# The bug: the append path did `await res.text()` and reused the worker's
# headers. Prometheus scrapes with `Accept-Encoding: gzip` and the request is
# forwarded verbatim, so the worker's body arrives gzip-encoded; .text() decoded
# DEFLATE bytes as UTF-8 (every bad byte -> U+FFFD) and shipped the mojibake
# under the inherited `content-encoding: gzip`. Prometheus: `gzip: invalid
# header`, target DOWN, and every pawtograder_* queue series off that same
# endpoint went with it. Plain curl sends no Accept-Encoding, so the manual test
# passed.
assert_edge_metrics_encoding() {
  local label="append path handles content-encoding" bad=0
  local src="$CHART/images/edge-functions/main.ts"
  if [ ! -f "$src" ]; then
    echo "FAIL [$label]: $src not found"
    FAILED=1
    return
  fi
  # The rewrite must drop content-encoding, since what it returns is plaintext.
  if ! grep -qE 'headers\.delete\("content-encoding"\)' "$src"; then
    echo "FAIL [$label]: rewrite does not delete content-encoding; a gzip scrape will be corrupted"
    bad=1
  fi
  # ...and it must actually decode a gzip body rather than stringifying it.
  if ! grep -qF 'DecompressionStream("gzip")' "$src"; then
    echo "FAIL [$label]: no gzip decode path; res.text() on an encoded body yields U+FFFD mojibake"
    bad=1
  fi
  # An encoding it cannot decode must pass the response through untouched. Match
  # the CONTROL FLOW, not the log line: a branch that keeps the diagnostic but
  # loses its `return res` would corrupt exactly the bodies this is protecting,
  # and a message-only grep cannot tell the difference. Require `return res`
  # within the few lines following the diagnostic, before the branch closes.
  if ! awk '
      /unsupported content-encoding/ { seen = 1; n = 0; next }
      seen {
        n++
        if ($0 ~ /return res;/) { found = 1; exit }
        if (n > 4 || $0 ~ /^[[:space:]]*}[[:space:]]*$/) { seen = 0 }
      }
      END { exit !found }
    ' "$src"; then
    echo "FAIL [$label]: unsupported-encoding branch does not return res; the response would be corrupted"
    bad=1
  fi
  if [ "$bad" -ne 0 ]; then FAILED=1; else echo "ok   [$label]"; fi
}
assert_edge_metrics_encoding

echo "== the Postgres primary must not roll for unrelated monitoring changes =="
# postgres-statefulset.yaml stamps checksum/config on the PRIMARY's pod template
# so that a change to the postgres_exporter queries actually restarts the sidecar
# that reads them at startup. It used to hash the whole of monitoring.yaml, which
# renders every ServiceMonitor in the chart — so ANY unrelated monitoring object
# moved the hash and rolled the database.
#
# That is not hypothetical. Turning on web.metricsLeader adds a Deployment, a
# Service and a ServiceMonitor, touches nothing Postgres reads, and took auth,
# storage and realtime through a ~60s crash-loop on Khoury prod (2026-09-04)
# because of this annotation.
#
# The invariant, in both directions:
#   1. flipping web.metricsLeader must NOT change the primary's checksum
#   2. a real exporter-query change MUST still change it (or the sidecar would
#      silently serve stale queries, which is the bug the annotation exists for)
assert_primary_checksum_scope() {
  local label="metrics-leader toggle does not roll the Postgres primary"
  local base_sum leader_sum queries_sum
  primary_checksum() {
    helm template t "$CHART" "${BASE[@]}" \
      --set monitoring.enabled=true \
      --set monitoring.prometheusRules.labels.release=kps \
      "$@" --show-only templates/postgres-statefulset.yaml 2>/dev/null \
      | awk '/checksum\/config:/ { print $2; exit }'
  }
  base_sum=$(primary_checksum --set web.metricsLeader.enabled=false)
  leader_sum=$(primary_checksum --set web.metricsLeader.enabled=true)
  if [ -z "$base_sum" ]; then
    echo "FAIL [$label]: could not read checksum/config from the primary StatefulSet"
    FAILED=1
    return
  fi
  if [ "$base_sum" != "$leader_sum" ]; then
    echo "FAIL [$label]: enabling web.metricsLeader changed the primary's checksum/config"
    echo "       leader off: $base_sum"
    echo "       leader on:  $leader_sum"
    echo "       => the annotation is hashing something broader than the exporter queries;"
    echo "          this rolls the DATABASE for a monitoring-only change."
    FAILED=1
    return
  fi
  echo "ok   [$label]"

  # Direction 2: the annotation must still do its actual job.
  local label2="a real exporter-query change still rolls the primary"
  queries_sum=$(primary_checksum --set postgres.exporter.cacheSeconds=97)
  if [ -n "$queries_sum" ] && [ "$queries_sum" = "$base_sum" ]; then
    echo "SKIP [$label2]: no values knob alters queries.yaml; relying on file-content hashing"
  else
    echo "ok   [$label2]"
  fi
}
assert_primary_checksum_scope

echo
if [ "$FAILED" -ne 0 ]; then
  echo "GUARD-RAIL TESTS FAILED"
  exit 1
fi
echo "All guard-rail render tests passed."
