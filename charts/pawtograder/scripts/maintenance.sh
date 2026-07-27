#!/usr/bin/env bash
#
# maintenance.sh — orchestrate a Pawtograder planned-maintenance window.
#
# Fences writes, drains in-flight async work, and puts up the styled maintenance
# page, reporting standby health so the operator knows it is SAFE TO BOUNCE. It
# does NOT drain/reboot the node itself — after `down` reports safe, the operator
# performs the node/DB maintenance and then runs `up` to restore everything to
# exactly the state that was captured.
#
# See docs/operations/planned-maintenance.md for the manual reference sequence.
#
#   maintenance.sh down          # page up + fence writers, report SAFE TO BOUNCE
#   ...operator does the node/DB maintenance...
#   maintenance.sh up            # restore everything, page down LAST
#   maintenance.sh status        # read-only posture report
#
# Prior state is captured into an in-cluster ConfigMap (<release>-maintenance-state)
# so `up` restores exact replica counts / HPA / cron jobs / ingress backend.
#
# Requires: kubectl (context already pointed at the target cluster) and jq. DB
# access is via `kubectl exec` into the primary pod — no local psql needed.
#
# Dry-run note: --dry-run performs NO mutations. Read-only queries (status/gates)
# still run so the preview reflects real cluster state; every mutating action is
# printed with a [dry-run] prefix and skipped.
set -euo pipefail

# ----------------------------------------------------------------------------
# Config (override via env or flags)
# ----------------------------------------------------------------------------
NAMESPACE="${NAMESPACE:-pawtograder-prod}"
RELEASE="${RELEASE:-pawtograder}"
DRY_RUN=false
ASSUME_YES=false

# Custom maintenance-page text (set via --title/--message/--eta on `down`).
# When set, `down` patches the maintenance ConfigMap's index.html for THIS window
# and rolls the maintenance pod (subPath mounts don't hot-reload). Unset fields
# keep the deployed maintenance.title/message/eta chart defaults. A later
# `helm upgrade` reconciles the ConfigMap back to the chart values — which only
# holds because the patch is attributed to Helm's field manager (see HELM_FM);
# with kubectl's default manager the upgrade FAILS on the field instead.
MAINT_TITLE="";   MAINT_TITLE_SET=false
MAINT_MESSAGE=""; MAINT_MESSAGE_SET=false
MAINT_ETA="";     MAINT_ETA_SET=false

# Drain gate: how long to wait for the async queues to empty, and poll cadence.
DRAIN_TIMEOUT_SECONDS="${DRAIN_TIMEOUT_SECONDS:-900}"
DRAIN_POLL_SECONDS="${DRAIN_POLL_SECONDS:-5}"

# Standby replay lag (bytes) at/under which a bounce is considered safe. Mirrors
# monitoring.prometheusRules.replicationLagBytesWarning (100 MiB) in values.yaml.
LAG_THRESHOLD_BYTES="${LAG_THRESHOLD_BYTES:-104857600}"

# How long `up` waits for each restored tier to become Ready before dropping the
# maintenance page. Flipping the ingress back to web while its pods are still
# booting leaves the controller with no ready endpoints → it serves its OWN
# default 503 until they come up. We drop the page only once the app can serve.
READY_TIMEOUT_SECONDS="${READY_TIMEOUT_SECONDS:-300}"

# ----------------------------------------------------------------------------
# Derived resource names / labels (verified against the chart + migrations)
# ----------------------------------------------------------------------------
PG_POD="${RELEASE}-postgres-0"
PG_CONTAINER="postgres"
PG_SUPERUSER="supabase_admin"
PG_DB="postgres"

INGRESS="${RELEASE}"                       # Helm fullname
WEB_SVC="${RELEASE}-web"
WEB_PORT="3000"
MAINT_SVC="${RELEASE}-maintenance"
MAINT_CM="${RELEASE}-maintenance"          # ConfigMap holding index.html
MAINT_PORT="8080"
FUNCTIONS_HPA="${RELEASE}-functions"
STATE_CM="${RELEASE}-maintenance-state"
INSTANCE_LABEL="app.kubernetes.io/instance=${RELEASE}"

# Writer Deployments fenced (scaled to 0) in one step (channels web-*/functions-*
# are discovered at runtime). `functions` is included here so it is captured,
# scaled, gated, and restored uniformly with the rest.
STABLE_WRITERS=(functions web rest auth storage realtime)

# Write-capable CronJobs to suspend for the window (component suffixes).
SUSPEND_CRONJOBS=(audit-partitions backup-restore-drill backup-pitr-drill backup-verify)

# pgmq queue tables reported as informational backlog (durable; not a gate).
DRAIN_QUEUES=(q_async_calls q_async_calls_low_priority q_gradebook_row_recalculate q_discord_async_calls)

# ----------------------------------------------------------------------------
# Output helpers
# ----------------------------------------------------------------------------
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_INFO=$'\033[36m'; C_OK=$'\033[32m'; C_WARN=$'\033[33m'
  C_ERR=$'\033[31m'; C_STEP=$'\033[1;35m'
else
  C_RESET=""; C_INFO=""; C_OK=""; C_WARN=""; C_ERR=""; C_STEP=""
fi

log()  { printf '%s[maint]%s %s\n' "$C_INFO" "$C_RESET" "$*"; }
step() { printf '\n%s[maint ▸ %s]%s %s\n' "$C_STEP" "$1" "$C_RESET" "$2"; }
ok()   { printf '%s[maint ✓]%s %s\n' "$C_OK" "$C_RESET" "$*"; }
warn() { printf '%s[maint ⚠]%s %s\n' "$C_WARN" "$C_RESET" "$*" >&2; }
die()  { printf '%s[maint ✗]%s %s\n' "$C_ERR" "$C_RESET" "$*" >&2; exit 1; }

# Print then run, unless dry-run (used for MUTATING commands).
run() {
  if $DRY_RUN; then
    printf '%s[dry-run]%s %s\n' "$C_WARN" "$C_RESET" "$*"
    return 0
  fi
  "$@"
}

confirm() {
  $ASSUME_YES && return 0
  $DRY_RUN && return 0
  local reply
  printf '%s%s%s [y/N] ' "$C_WARN" "$1" "$C_RESET" > /dev/tty
  read -r reply < /dev/tty || true
  case "$reply" in
    [yY] | [yY][eE][sS]) return 0 ;;
    *) die "aborted by operator" ;;
  esac
}

need() { command -v "$1" >/dev/null 2>&1 || die "required tool not found: $1"; }

# ----------------------------------------------------------------------------
# kubectl / psql wrappers
# ----------------------------------------------------------------------------
k() { kubectl -n "$NAMESPACE" "$@"; }

# Field manager for mutations to objects the CHART owns (the maintenance
# ConfigMap, ingresses, writer workloads, CronJobs, the functions HPA).
#
# Under server-side apply, kubectl's default managers (`kubectl-patch`,
# `kubectl-scale`, `kubectl-client-side-apply`) take OWNERSHIP of every field
# they touch, and reverting the change does not release the claim — the record
# persists on the object. A later `helm upgrade` then fails on a field it no
# longer owns:
#
#   UPGRADE FAILED: conflict occurred while applying object ...
#     Apply failed with 1 conflict: conflict with "kubectl-patch" using v1: .data.index.html
#
# i.e. a maintenance window taken weeks ago breaks an unrelated deploy today.
# Attributing these writes to Helm's own manager keeps ownership where the chart
# expects it. If a conflict slips through anyway, re-run the deploy with
# --force-conflicts after confirming the live value matches the chart's.
#
# Deliberately NOT used on $STATE_CM: that ConfigMap is created and owned by this
# script, not by the chart, so it should keep its own field manager.
readonly HELM_FM="--field-manager=helm"

# Read-only SQL (tuples-only). Runs even under --dry-run (no side effects).
psql_ro() {
  # `|| true`: a read must never abort the caller (status/gates handle empties).
  kubectl -n "$NAMESPACE" exec "$PG_POD" -c "$PG_CONTAINER" -- \
    psql -U "$PG_SUPERUSER" -d "$PG_DB" -tAc "$1" 2>/dev/null | tr -d '[:space:]' || true
}

# Mutating SQL — respects --dry-run.
psql_exec() {
  if $DRY_RUN; then
    printf '%s[dry-run]%s psql: %s\n' "$C_WARN" "$C_RESET" "$1"
    return 0
  fi
  kubectl -n "$NAMESPACE" exec "$PG_POD" -c "$PG_CONTAINER" -- \
    psql -U "$PG_SUPERUSER" -d "$PG_DB" -v ON_ERROR_STOP=1 -tAc "$1"
}

# Sum of pending+in-flight messages across the drain queues.
queue_depth() {
  local sql="SELECT COALESCE("
  local first=true q
  for q in "${DRAIN_QUEUES[@]}"; do
    $first || sql+=" + "
    sql+="(SELECT count(*) FROM pgmq.${q})"
    first=false
  done
  sql+=", 0);"
  psql_ro "$sql"
}

# ----------------------------------------------------------------------------
# Discovery
# ----------------------------------------------------------------------------
# Emits "<deploy-name>\t<replicas>" for every writer tier + channel Deployment.
# Stable writers by exact component; channels by component prefix web-/functions-.
# Emits "<kind>\t<name>\t<replicas>" (kind = deployment|statefulset) for every
# writer tier + channel. Both kinds are queried because `realtime` is a
# StatefulSet (the rest are Deployments); postgres/postgres-replica are also
# StatefulSets but their component labels aren't in the writer set, so they are
# never matched — the DB is never scaled.
discover_writers() {
  local stable_re; stable_re="$(IFS='|'; echo "${STABLE_WRITERS[*]}")"
  {
    k get deploy -l "$INSTANCE_LABEL" \
      -o jsonpath='{range .items[*]}deployment{"\t"}{.metadata.name}{"\t"}{.metadata.labels.app\.kubernetes\.io/component}{"\t"}{.spec.replicas}{"\n"}{end}'
    k get statefulset -l "$INSTANCE_LABEL" \
      -o jsonpath='{range .items[*]}statefulset{"\t"}{.metadata.name}{"\t"}{.metadata.labels.app\.kubernetes\.io/component}{"\t"}{.spec.replicas}{"\n"}{end}'
  } | awk -F'\t' -v OFS='\t' -v stable="^(${stable_re})$" '
      { kind=$1; nm=$2; comp=$3; rep=$4
        channel = (comp ~ /^web-/ || comp ~ /^functions-/)
        if (comp ~ stable || channel) print kind, nm, rep
      }'
}

# ----------------------------------------------------------------------------
# Standby health report
# ----------------------------------------------------------------------------
# mode "fenced" (from `down`, AFTER the write fence + pods-terminated gate) issues
# an actual bounce clearance. Any other mode (e.g. `status`) reports standby
# viability ONLY — it must NOT print "SAFE TO BOUNCE", because writers are still
# live there and an operator could otherwise bounce an un-fenced primary.
report_standby() {
  local mode="${1:-status}" streaming lag standby_ok=false
  streaming="$(psql_ro "SELECT count(*) FROM pg_stat_replication WHERE state='streaming' AND usename='supabase_replication_admin';")"
  lag="$(psql_ro "SELECT COALESCE(max(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)),0) FROM pg_stat_replication WHERE usename='supabase_replication_admin';")"
  log "physical standbys streaming: ${streaming:-?}; max replay lag: ${lag:-?} bytes (threshold ${LAG_THRESHOLD_BYTES})"
  # Viable safety net only when a physical standby is streaming AND its replay lag
  # is a known value at/under the threshold — streaming-but-far-behind is NOT a
  # safe failover target (promotion would lose the un-replayed tail).
  if [[ "$streaming" =~ ^[0-9]+$ ]] && [ "$streaming" -ge 1 ] \
     && [[ "$lag" =~ ^[0-9]+$ ]] && [ "$lag" -le "$LAG_THRESHOLD_BYTES" ]; then
    standby_ok=true
  fi
  if [ "$mode" = "fenced" ]; then
    if $standby_ok; then
      printf '%s[maint ✓] SAFE TO BOUNCE%s — writers fenced and standby streaming, replay lag %s <= %s bytes. Perform the node/DB maintenance, then run: %s up\n' \
        "$C_OK" "$C_RESET" "$lag" "$LAG_THRESHOLD_BYTES" "$0"
    else
      printf '%s[maint ⚠] NOT READY%s — need a streaming physical standby with replay lag <= %s bytes; got streaming=%s lag=%s. Bouncing now risks data loss; investigate before proceeding.\n' \
        "$C_WARN" "$C_RESET" "$LAG_THRESHOLD_BYTES" "${streaming:-?}" "${lag:-?}"
    fi
  else
    # Informational (status): report standby viability, NOT a bounce clearance —
    # "SAFE TO BOUNCE" is issued only by `down`, once the fence is complete.
    if $standby_ok; then
      log "standby: healthy failover target (streaming, lag within threshold). NOT a bounce clearance — run 'down' to fence writers first."
    else
      warn "standby: NOT a safe failover target (streaming=${streaming:-?}, lag=${lag:-?}). Investigate before any bounce."
    fi
  fi
}

# ----------------------------------------------------------------------------
# State ConfigMap
# ----------------------------------------------------------------------------
state_exists() { k get configmap "$STATE_CM" >/dev/null 2>&1; }


# ----------------------------------------------------------------------------
# Custom maintenance-page text (--title/--message/--eta)
# ----------------------------------------------------------------------------
# Minimal HTML-escaping so an operator message can't break the markup. & first.
html_escape() {
  local s="$1"
  s="${s//&/&amp;}"; s="${s//</&lt;}"; s="${s//>/&gt;}"; s="${s//\"/&quot;}"
  printf '%s' "$s"
}

# If any of --title/--message/--eta was given, rewrite the marked spans in the
# maintenance ConfigMap's index.html and roll the maintenance pod so it serves
# the new text. Called during `down` BEFORE the ingress is repointed, so the
# page is already showing the window-specific message when traffic arrives (and
# the roll can't cause a gap — the ingress still points at web at this point).
apply_custom_message() {
  $MAINT_TITLE_SET || $MAINT_MESSAGE_SET || $MAINT_ETA_SET || return 0
  if $DRY_RUN; then
    log "[dry-run] would patch ${MAINT_CM} index.html (title/message/eta) + roll ${MAINT_SVC}"
    return 0
  fi
  need perl
  k get configmap "$MAINT_CM" >/dev/null 2>&1 \
    || { warn "ConfigMap ${MAINT_CM} not found; cannot set a custom message"; return 0; }
  local html
  html="$(k get configmap "$MAINT_CM" -o jsonpath='{.data.index\.html}')"
  [ -n "$html" ] || { warn "${MAINT_CM} has no index.html; skipping custom message"; return 0; }
  # The template must carry the <!--maint:*--> markers this substitutes between.
  case "$html" in
    *"<!--maint:message-->"*) : ;;
    *) warn "maintenance page has no <!--maint:*--> markers (older image?); skipping custom message"; return 0 ;;
  esac

  # Save the pre-override page into the state ConfigMap so `up` can restore it.
  # Without this, once staged, a later window run WITHOUT flags would keep serving
  # this window's title/message/eta until a helm upgrade reconciles the ConfigMap.
  k patch configmap "$STATE_CM" --type merge \
    -p "$(jq -n --arg h "$html" '{data:{maint_index_html_orig:$h}}')" >/dev/null

  if $MAINT_TITLE_SET; then
    html="$(T="$(html_escape "$MAINT_TITLE")" perl -0777 -pe \
      's/(<!--maint:title-->).*?(<!--\/maint:title-->)/$1.$ENV{T}.$2/gse' <<<"$html")"
  fi
  if $MAINT_MESSAGE_SET; then
    html="$(M="$(html_escape "$MAINT_MESSAGE")" perl -0777 -pe \
      's/(<!--maint:message-->).*?(<!--\/maint:message-->)/$1.$ENV{M}.$2/se' <<<"$html")"
  fi
  if $MAINT_ETA_SET; then
    local inner=""
    [ -n "$MAINT_ETA" ] && inner="$(printf '\n      <p class="eta">Expected back by %s</p>' "$(html_escape "$MAINT_ETA")")"
    html="$(E="$inner" perl -0777 -pe \
      's/(<!--maint:eta-->).*?(<!--\/maint:eta-->)/$1.$ENV{E}.$2/se' <<<"$html")"
  fi

  # jq builds the strategic-merge patch (handles newline/quote escaping in the
  # multiline HTML value). Then roll the pod: index.html is a subPath mount, so
  # a ConfigMap edit alone does NOT reach the running container.
  k patch configmap "$MAINT_CM" "$HELM_FM" --type merge -p "$(jq -n --arg h "$html" '{data:{"index.html":$h}}')" >/dev/null
  k rollout restart deploy "$MAINT_SVC" >/dev/null
  k rollout status deploy "$MAINT_SVC" --timeout="${READY_TIMEOUT_SECONDS}s" \
    || warn "${MAINT_SVC} not Ready after the message update; the page may lag briefly"
  ok "custom maintenance message applied + ${MAINT_SVC} rolled"
}

# ----------------------------------------------------------------------------
# down
# ----------------------------------------------------------------------------
cmd_down() {
  need kubectl; need jq
  log "namespace=${NAMESPACE} release=${RELEASE} $($DRY_RUN && echo '(dry-run)')"

  if state_exists; then
    die "state ConfigMap ${STATE_CM} already exists — a window is already open. Run '$0 up' to restore, or '$0 status' to inspect."
  fi
  k get pod "$PG_POD" >/dev/null 2>&1 || die "primary pod ${PG_POD} not found"

  # Precondition: the maintenance page must already be deployed AND Ready. The
  # fence scales the web tier to 0, so if the page can't serve, users get the
  # ingress controller's bare 5xx instead of the styled page. Fail fast, before
  # any mutation, rather than fencing into a void.
  k get deploy "$MAINT_SVC" >/dev/null 2>&1 \
    || die "maintenance Deployment ${MAINT_SVC} not found — deploy the page first (helm upgrade --set maintenance.enabled=true) before running 'down'."
  if ! $DRY_RUN; then
    k rollout status deploy "$MAINT_SVC" --timeout=120s \
      || die "maintenance page ${MAINT_SVC} is not Ready — fix it before fencing (users would otherwise see a bare 5xx, not the styled page)."
  fi

  confirm "Fence writes + put up the maintenance page in ${NAMESPACE}? (pgmq backlog is durable and drains after 'up')"

  tmp="$(mktemp -d)"; trap 'rm -rf "${tmp:-}" 2>/dev/null || true' EXIT

  # 1. Capture + persist ALL prior state BEFORE any destructive action, so an
  #    interrupted fence is always recoverable by `up`. pg_cron is PAUSED only
  #    after the state ConfigMap exists (step 2) — pausing before we persist the
  #    active set would, if a later capture failed, leave every job disabled with
  #    nothing recorded to resume.
  step "1/6 capture" "recording prior state before fencing"
  # Read the active cron set with a sentinel so a TRANSIENT read failure (psql_ro
  # swallows errors and returns "") can't be mistaken for "no active jobs" — abort
  # if we can't positively read it.
  local cron_read active_jobs
  cron_read="$(psql_ro "SELECT 'MARK:' || COALESCE(string_agg(jobid::text, ','), '') FROM cron.job WHERE active;")"
  case "$cron_read" in
    MARK:*) active_jobs="${cron_read#MARK:}" ;;
    *) die "could not read the pg_cron active-job set from ${PG_POD} (got '${cron_read:-<empty>}'). Aborting before any change. Check the DB and retry." ;;
  esac
  printf '%s' "$active_jobs" > "$tmp/cron_jobids"
  log "active cron jobs: ${active_jobs:-none}"

  # --- Capture the rest of prior state, then persist it BEFORE any destructive
  #     fence action, so `up` can restore even if the fence is interrupted. ---
  # ingress web-host backend (name+port scalars → JSON; jsonpath can't emit the
  # backend object as JSON).
  local cur_name cur_port rule0_host
  cur_name="$(k get ingress "$INGRESS" -o jsonpath='{.spec.rules[0].http.paths[0].backend.service.name}' 2>/dev/null || true)"
  cur_port="$(k get ingress "$INGRESS" -o jsonpath='{.spec.rules[0].http.paths[0].backend.service.port.number}' 2>/dev/null || true)"
  rule0_host="$(k get ingress "$INGRESS" -o jsonpath='{.spec.rules[0].host}' 2>/dev/null || true)"
  : > "$tmp/ingress_backend"
  if [ -n "$cur_name" ] && [ -n "$cur_port" ]; then
    printf '{"name":"%s","port":{"number":%s}}' "$cur_name" "$cur_port" > "$tmp/ingress_backend"
  fi
  log "ingress rules[0] host=${rule0_host:-?} backend=${cur_name:-?}:${cur_port:-?}"
  [ "$cur_name" != "$WEB_SVC" ] && warn "rules[0].paths[0] backend is '${cur_name:-?}', not ${WEB_SVC}; verify this is the web host"
  # Per-course A/B channel web Ingresses: each has its OWN host whose "/" path
  # routes to that channel's web-<channel> Deployment (which we also fence to 0),
  # so the page must front them too or channel users get errors instead of the
  # page. The "/" path is NOT index 0 (the API paths precede it), so record each
  # ingress name + the index of its "/" path + that path's backend — to repoint on
  # the fence and restore on `up`.
  : > "$tmp/channel_ingresses"
  k get ingress -l "$INSTANCE_LABEL" -o json 2>/dev/null | jq -c '
    [ .items[]
      | select(((.metadata.labels["app.kubernetes.io/component"]) // "") | startswith("web-"))
      | .metadata.name as $n
      | (.spec.rules[0].http.paths | to_entries[] | select(.value.path == "/")) as $p
      | {ingress: $n, index: $p.key, backend: $p.value.backend.service} ]' \
    > "$tmp/channel_ingresses" || printf '[]' > "$tmp/channel_ingresses"
  [ -s "$tmp/channel_ingresses" ] || printf '[]' > "$tmp/channel_ingresses"
  log "channel web ingresses to repoint: $(jq -r 'length' "$tmp/channel_ingresses" 2>/dev/null || echo 0)"
  # edge-functions HPA (re-applied on `up`).
  : > "$tmp/functions_hpa"
  if k get hpa "$FUNCTIONS_HPA" >/dev/null 2>&1; then
    if $DRY_RUN; then
      log "[dry-run] would capture hpa/${FUNCTIONS_HPA}"
    else
      k get hpa "$FUNCTIONS_HPA" -o json \
        | jq 'del(.status, .metadata.resourceVersion, .metadata.uid, .metadata.creationTimestamp, .metadata.generation, .metadata.managedFields, .metadata.annotations."kubectl.kubernetes.io/last-applied-configuration")' \
        > "$tmp/functions_hpa"
    fi
  fi
  # writer/channel/functions replica counts (functions is in STABLE_WRITERS).
  discover_writers > "$tmp/deploy_replicas"
  # CronJob prior suspend states (suspended in step 3; captured now so state is
  # complete before we persist and mutate).
  : > "$tmp/cronjobs_suspend"
  local cj cjname prior
  for cj in "${SUSPEND_CRONJOBS[@]}"; do
    cjname="${RELEASE}-${cj}"
    if k get cronjob "$cjname" >/dev/null 2>&1; then
      prior="$(k get cronjob "$cjname" -o jsonpath='{.spec.suspend}')"; prior="${prior:-false}"
      printf '%s\t%s\n' "$cjname" "$prior" >> "$tmp/cronjobs_suspend"
    fi
  done
  if ! $DRY_RUN; then
    k create configmap "$STATE_CM" \
      --from-file=cron_jobids="$tmp/cron_jobids" \
      --from-file=functions_hpa="$tmp/functions_hpa" \
      --from-file=deploy_replicas="$tmp/deploy_replicas" \
      --from-file=cronjobs_suspend="$tmp/cronjobs_suspend" \
      --from-file=ingress_backend="$tmp/ingress_backend" \
      --from-file=channel_ingresses="$tmp/channel_ingresses" >/dev/null
    ok "captured prior state -> configmap/${STATE_CM}"
  else
    log "[dry-run] would save state -> configmap/${STATE_CM}"
  fi

  # 2. Pause pg_cron now that prior state is safely persisted (state ConfigMap
  #    exists), so a failure here can never strand cron in the disabled state.
  step "2/6 pg_cron" "pausing scheduled jobs"
  psql_exec "UPDATE cron.job SET active=false WHERE active;"
  ok "pg_cron paused"

  # 3. Fence: put the maintenance page up AND scale EVERY writer tier to 0 in one
  #    step. Producers on the web host see the 503 page; edge-runtime's
  #    --graceful-exit-timeout lets any in-flight functions handler COMMIT and exit
  #    cleanly as the pods drain.
  step "3/6 fence" "maintenance page up + all writer tiers -> 0"
  # 3a. delete the functions HPA first so it can't fight the scale-to-0.
  if [ -s "$tmp/functions_hpa" ]; then
    run k delete hpa "$FUNCTIONS_HPA"; ok "edge-functions HPA captured + deleted"
  else
    warn "no edge-functions HPA (${FUNCTIONS_HPA}); nothing to capture"
  fi
  # 3a½. apply a window-specific message BEFORE repointing the ingress, so the
  #      page is already showing it when traffic arrives (and the maintenance
  #      pod roll happens while the ingress still points at web → no gap).
  apply_custom_message
  # 3b. put the page up. Existence + readiness were verified as a precondition
  #     above, so this just repoints the web host at the maintenance Service.
  run k patch ingress "$INGRESS" "$HELM_FM" --type=json -p \
    "[{\"op\":\"replace\",\"path\":\"/spec/rules/0/http/paths/0/backend/service\",\"value\":{\"name\":\"${MAINT_SVC}\",\"port\":{\"number\":${MAINT_PORT}}}}]"
  ok "web host -> ${MAINT_SVC}:${MAINT_PORT}"
  # 3b′. repoint each per-course channel web host's "/" to the page too (their
  #      web-<channel> Deployments are fenced to 0 below; without this, channel
  #      users would get errors instead of the maintenance page).
  if [ "$(jq -r 'length' "$tmp/channel_ingresses" 2>/dev/null || echo 0)" -gt 0 ]; then
    local crow cing cidx
    while IFS= read -r crow; do
      [ -n "$crow" ] || continue
      cing="$(jq -r '.ingress' <<<"$crow")"; cidx="$(jq -r '.index' <<<"$crow")"
      run k patch ingress "$cing" "$HELM_FM" --type=json -p \
        "[{\"op\":\"replace\",\"path\":\"/spec/rules/0/http/paths/${cidx}/backend/service\",\"value\":{\"name\":\"${MAINT_SVC}\",\"port\":{\"number\":${MAINT_PORT}}}}]"
      log "  channel ingress ${cing} path[${cidx}] -> ${MAINT_SVC}:${MAINT_PORT}"
    done < <(jq -c '.[]' "$tmp/channel_ingresses")
    ok "channel web hosts -> ${MAINT_SVC}:${MAINT_PORT}"
  fi
  # 3c. scale every writer/channel/functions workload to 0 (records were saved).
  if [ -s "$tmp/deploy_replicas" ]; then
    local kind name replicas
    while IFS=$'\t' read -r kind name replicas; do
      [ -n "$name" ] || continue
      log "  ${kind}/${name}: ${replicas} -> 0"
      run k scale "$kind" "$name" "$HELM_FM" --replicas=0
    done < "$tmp/deploy_replicas"
  fi
  ok "all writer tiers scaled to 0"

  # 4. Suspend write-capable CronJobs (prior states captured above).
  step "4/6 cronjobs" "suspending write-capable CronJobs"
  local cj2 cjn
  for cj2 in "${SUSPEND_CRONJOBS[@]}"; do
    cjn="${RELEASE}-${cj2}"
    if k get cronjob "$cjn" >/dev/null 2>&1; then
      run k patch cronjob "$cjn" "$HELM_FM" --type=merge -p '{"spec":{"suspend":true}}'
      log "  suspended ${cjn}"
    fi
  done
  ok "CronJobs suspended"

  # 4. AUTHORITATIVE GATE: block until every fenced writer/channel/functions
  #    deployment has 0 running pods. Zero writer pods — NOT an empty queue — is
  #    the real safety signal: --graceful-exit-timeout has let in-flight work
  #    COMMIT and no writer process is left touching the DB.
  step "5/6 gate" "waiting for all writer pods to terminate"
  if $DRY_RUN; then
    log "[dry-run] would block until all scaled writer/functions pods terminate"
  else
    local pwaited=0 remaining unreadable cur kind2 name2
    while :; do
      remaining=0; unreadable=0
      while IFS=$'\t' read -r kind2 name2 _; do
        [ -n "$name2" ] || continue
        # `.status.replicas` counts pods the controller still owns; it is empty
        # once all are gone. A FAILED `kubectl get`, though, must NOT be read as
        # 0 — a transient API blip would otherwise let the gate falsely declare
        # "terminated" and SAFE TO BOUNCE while writers are still running.
        if ! cur="$(k get "$kind2" "$name2" -o jsonpath='{.status.replicas}' 2>/dev/null)"; then
          unreadable=$((unreadable + 1)); continue
        fi
        [ -z "$cur" ] && cur=0
        if [[ "$cur" =~ ^[0-9]+$ ]]; then remaining=$((remaining + cur)); else unreadable=$((unreadable + 1)); fi
      done < "$tmp/deploy_replicas"
      # Safe only when every writer read succeeded AND reported 0 running pods.
      if [ "$remaining" -eq 0 ] && [ "$unreadable" -eq 0 ]; then
        ok "all writer pods terminated ✓"; break
      fi
      log "waiting for writer pods to terminate: ${remaining} running, ${unreadable} unreadable (${pwaited}s / ${DRAIN_TIMEOUT_SECONDS}s)"
      if [ "$pwaited" -ge "$DRAIN_TIMEOUT_SECONDS" ]; then
        die "writer pods not confirmed terminated within ${DRAIN_TIMEOUT_SECONDS}s (${remaining} running, ${unreadable} unreadable); NOT safe to bounce."
      fi
      sleep "$DRAIN_POLL_SECONDS"; pwaited=$((pwaited + DRAIN_POLL_SECONDS))
    done
  fi

  # Informational only: the pgmq queues are Postgres tables, so the backlog is
  # DURABLE across the bounce and drains after `up` when functions resumes. We do
  # NOT block on it — safety is graceful-exit + zero writer pods above. Blocking
  # would also never converge: the api/kong host stays open and webhooks (e.g.
  # github-repo-webhook) keep writing directly, holding the count above zero.
  local buffered; buffered="$(queue_depth)"
  log "pgmq backlog: ${buffered:-?} message(s) buffered — durable, drains after 'up' (informational, not a gate)"

  # 6. Report standby health → SAFE TO BOUNCE / NOT READY (writers are now fenced).
  step "6/6 standby" "checking replication before the bounce"
  report_standby fenced
}

# ----------------------------------------------------------------------------
# up
# ----------------------------------------------------------------------------
cmd_up() {
  need kubectl; need jq
  log "namespace=${NAMESPACE} release=${RELEASE} $($DRY_RUN && echo '(dry-run)')"
  state_exists || die "no state ConfigMap ${STATE_CM} — nothing to restore (was '$0 down' run in this namespace?)"

  confirm "Restore ${NAMESPACE} from ${STATE_CM} and take the maintenance page down?"

  tmp="$(mktemp -d)"; trap 'rm -rf "${tmp:-}" 2>/dev/null || true' EXIT

  # Read the ENTIRE state ConfigMap ONCE, and fail if THAT read fails — so a
  # transient API/ConfigMap read can never be misread per-key as "empty" and
  # silently skip restoring CronJobs / cron / HPA / ingress before the state is
  # deleted. Every key read below comes from this one verified snapshot.
  k get configmap "$STATE_CM" -o json > "$tmp/state.json" 2>/dev/null \
    || die "could not read state ConfigMap ${STATE_CM}. Restore aborted (retry is safe; do NOT delete it — it holds everything 'up' needs)."
  sget() { jq -r --arg k "$1" '.data[$k] // ""' "$tmp/state.json"; }

  # A. Drop the maintenance page FIRST-of-restore is wrong: page comes down LAST.
  #    Restore backends/pods first while the page still shields users.

  # 0. Preflight: the primary MUST accept writes before we restore any writer
  #    tier — otherwise (e.g. the bounce left it in recovery, or a promotion was
  #    needed and not done) every restored writer would fail writes immediately.
  #    Confirm not-in-recovery AND not read-only, then a real write probe
  #    (txid_current allocates an xid — errors on a read-only / in-recovery server).
  step "0/6 preflight" "verifying the primary accepts writes"
  if $DRY_RUN; then
    log "[dry-run] would verify ${PG_POD} is writable (pg_is_in_recovery / transaction_read_only / txid_current)"
  else
    local writable
    writable="$(psql_ro "SELECT (NOT pg_is_in_recovery()) AND NOT current_setting('transaction_read_only')::bool;")"
    [ "$writable" = "t" ] || die "primary ${PG_POD} is not writable (in recovery or read-only: got '${writable:-?}'). Restore aborted — promote/verify the DB first, then re-run 'up'."
    psql_exec "SELECT txid_current();" >/dev/null 2>&1 || die "write probe (txid_current) failed on ${PG_POD}; not writable. Restore aborted."
    ok "primary accepts writes"
  fi

  # 1. Restore writer tiers + channels to recorded counts. The state ConfigMap
  #    was confirmed present above and `down` always records writers, so an EMPTY
  #    read here means a transient API/ConfigMap read failure — NOT "nothing to
  #    restore". Abort rather than silently leave every writer scaled to 0.
  step "1/6 writers" "restoring app tiers + channels"
  sget deploy_replicas > "$tmp/deploy_replicas"
  [ -s "$tmp/deploy_replicas" ] \
    || die "could not read recorded writer replicas from ${STATE_CM} (empty). Restore aborted so the app isn't left scaled to 0. Retry 'up'; if it persists, restore manually from the ConfigMap."
  local kind name replicas
  while IFS=$'\t' read -r kind name replicas; do
    [ -n "$name" ] || continue
    log "  ${kind}/${name} -> ${replicas}"
    run k scale "$kind" "$name" "$HELM_FM" --replicas="$replicas"
  done < "$tmp/deploy_replicas"
  ok "writer tiers restored"

  # 2. Recreate the edge-functions HPA (re-apply the captured object). functions'
  #    replica count was already restored in step 1 (it is in deploy_replicas);
  #    re-applying the HPA hands replica management back to the autoscaler.
  #    Alternative: `helm upgrade --reuse-values` reconciles it from chart values
  #    (cleanest in GitOps) — we re-apply the captured object to stay self-contained.
  step "2/6 edge-functions" "re-applying the edge-functions HPA"
  sget functions_hpa > "$tmp/functions_hpa"
  if [ -s "$tmp/functions_hpa" ] && [ "$(tr -d '[:space:]' < "$tmp/functions_hpa")" != "" ]; then
    run k apply "$HELM_FM" -f "$tmp/functions_hpa"
    ok "edge-functions HPA re-applied (autoscaler resumes managing functions replicas)"
  else
    warn "no captured HPA; functions stays at the replica count restored in step 1"
  fi

  # 3. Unsuspend CronJobs to their recorded prior state.
  step "3/6 cronjobs" "restoring CronJob suspend state"
  sget cronjobs_suspend > "$tmp/cronjobs_suspend"
  if [ -s "$tmp/cronjobs_suspend" ]; then
    local cjname prior
    while IFS=$'\t' read -r cjname prior; do
      [ -n "$cjname" ] || continue
      log "  ${cjname} -> suspend=${prior}"
      run k patch cronjob "$cjname" "$HELM_FM" --type=merge -p "{\"spec\":{\"suspend\":${prior}}}"
    done < "$tmp/cronjobs_suspend"
  fi
  ok "CronJobs restored"

  # 4. Resume pg_cron for exactly the jobs that were active.
  step "4/6 pg_cron" "resuming scheduled jobs"
  local jobids; jobids="$(sget cron_jobids)"
  if [ -n "$jobids" ]; then
    psql_exec "UPDATE cron.job SET active=true WHERE jobid = ANY(ARRAY[${jobids}]::bigint[]);"
    ok "resumed cron jobs: ${jobids}"
  else
    log "no cron jobs were active at down time; nothing to resume"
  fi

  # 5. Wait for the restored tiers to be READY before dropping the page. Flipping
  #    the ingress back to pawtograder-web while its pods are still booting leaves
  #    the NGINX-Inc controller with no ready endpoints → it serves its OWN
  #    default 503 (a bare "503 Service Temporarily Unavailable", not our styled
  #    page) until web comes up. Waiting here makes "page down last" mean "page
  #    down only once the app can actually serve" — no default-503 flash.
  step "5/6 verify" "waiting for restored tiers to be Ready before dropping the page"
  if $DRY_RUN; then
    log "[dry-run] would wait for restored writer tiers (web, functions, realtime, ...) to be Ready"
  else
    local rk rn rr
    while IFS=$'\t' read -r rk rn rr; do
      [ -n "$rn" ] || continue
      [[ "$rr" =~ ^[0-9]+$ ]] && [ "$rr" -eq 0 ] && continue   # nothing to wait for at 0
      log "  waiting for ${rk}/${rn} (${rr} replica(s))"
      k rollout status "$rk" "$rn" --timeout="${READY_TIMEOUT_SECONDS}s" \
        || die "${rk}/${rn} not Ready within ${READY_TIMEOUT_SECONDS}s — leaving the maintenance page UP to avoid a broken cutover (users keep seeing the styled page, not errors). Investigate, then re-run '$0 up' to finish."
    done < "$tmp/deploy_replicas"
    ok "all restored tiers Ready"
  fi

  # 6. Point the web host back to the app, then delete state LAST. Page down last.
  step "6/6 page" "restoring the web host to the app"
  local backend; backend="$(sget ingress_backend)"
  if [ -n "$backend" ]; then
    run k patch ingress "$INGRESS" "$HELM_FM" --type=json -p \
      "[{\"op\":\"replace\",\"path\":\"/spec/rules/0/http/paths/0/backend/service\",\"value\":${backend}}]"
    ok "web host -> restored recorded backend"
  else
    warn "no recorded ingress backend; restoring to ${WEB_SVC}:${WEB_PORT}"
    run k patch ingress "$INGRESS" "$HELM_FM" --type=json -p \
      "[{\"op\":\"replace\",\"path\":\"/spec/rules/0/http/paths/0/backend/service\",\"value\":{\"name\":\"${WEB_SVC}\",\"port\":{\"number\":${WEB_PORT}}}}]"
  fi
  # Restore each channel web host's "/" backend from the recorded snapshot.
  local chan; chan="$(sget channel_ingresses)"
  if [ -n "$chan" ] && [ "$(jq -r 'length' <<<"$chan" 2>/dev/null || echo 0)" -gt 0 ]; then
    local crow cing cidx cbackend
    while IFS= read -r crow; do
      [ -n "$crow" ] || continue
      cing="$(jq -r '.ingress' <<<"$crow")"; cidx="$(jq -r '.index' <<<"$crow")"
      cbackend="$(jq -c '.backend' <<<"$crow")"
      run k patch ingress "$cing" "$HELM_FM" --type=json -p \
        "[{\"op\":\"replace\",\"path\":\"/spec/rules/0/http/paths/${cidx}/backend/service\",\"value\":${cbackend}}]"
      log "  channel ingress ${cing} path[${cidx}] -> restored"
    done < <(jq -c '.[]' <<<"$chan")
    ok "channel web hosts restored"
  fi

  # Restore the maintenance page's pre-window text if `down --title/--message/--eta`
  # overrode it — otherwise the next flag-less window serves this window's text.
  # Safe here: the ingress already points at web, so rolling the maintenance pod
  # (single replica) has no user impact.
  local orig_html; orig_html="$(sget maint_index_html_orig)"
  if [ -n "$orig_html" ]; then
    run k patch configmap "$MAINT_CM" "$HELM_FM" --type merge \
      -p "$(jq -n --arg h "$orig_html" '{data:{"index.html":$h}}')"
    run k rollout restart deploy "$MAINT_SVC"
    ok "maintenance page text restored to its pre-window default"
  fi

  run k delete configmap "$STATE_CM"
  ok "restore complete; maintenance state cleared"
}

# ----------------------------------------------------------------------------
# status (read-only)
# ----------------------------------------------------------------------------
cmd_status() {
  need kubectl
  log "namespace=${NAMESPACE} release=${RELEASE}"

  if state_exists; then
    warn "maintenance window OPEN (state ConfigMap ${STATE_CM} present)"
  else
    ok "no maintenance state ConfigMap — normal posture"
  fi

  local paused total
  paused="$(psql_ro "SELECT count(*) FROM cron.job WHERE NOT active;")" || paused="?"
  total="$(psql_ro "SELECT count(*) FROM cron.job;")" || total="?"
  log "pg_cron: ${paused}/${total} jobs paused (active=false)"

  log "queue depth (in-flight async): $(queue_depth)"

  if k get hpa "$FUNCTIONS_HPA" >/dev/null 2>&1; then
    log "edge-functions HPA: present"
  else
    log "edge-functions HPA: ABSENT"
  fi

  log "writer replica counts:"
  discover_writers | while IFS=$'\t' read -r kind name replicas; do
    [ -n "$name" ] && printf '    %s/%s = %s\n' "$kind" "$name" "$replicas"
  done

  local backend host
  host="$(k get ingress "$INGRESS" -o jsonpath='{.spec.rules[0].host}' 2>/dev/null)"
  backend="$(k get ingress "$INGRESS" -o jsonpath='{.spec.rules[0].http.paths[0].backend.service.name}' 2>/dev/null)"
  if [ "$backend" = "$MAINT_SVC" ]; then
    warn "ingress web host (${host}) -> ${backend} (MAINTENANCE PAGE UP)"
  else
    log "ingress web host (${host}) -> ${backend:-?} (app)"
  fi

  report_standby
}

# ----------------------------------------------------------------------------
# args + dispatch
# ----------------------------------------------------------------------------
usage() {
  cat <<USAGE
Usage: $0 <down|up|status> [options]

  down     Put up the maintenance page and fence all writer tiers to 0, wait for
           their pods to terminate, and report whether it is SAFE TO BOUNCE.
           Captures prior state. (pgmq backlog is durable and drains after 'up'.)
  up       Restore everything from the captured state; drop the page LAST.
  status   Read-only maintenance-posture report.

Options:
  -n, --namespace NS   Namespace   (default: ${NAMESPACE}, env NAMESPACE)
  -r, --release NAME   Helm release (default: ${RELEASE}, env RELEASE)
      --title TEXT     (down) window-specific page heading   (default: chart value)
      --message TEXT   (down) window-specific page body text (default: chart value)
      --eta TEXT       (down) "Expected back by <TEXT>" line; "" clears it
      --dry-run        Print intended mutations without executing (reads still run)
      --yes            Skip the confirmation prompt
  -h, --help           This help

  --title/--message/--eta patch the deployed maintenance page for this window and
  roll the maintenance pod; a later 'helm upgrade' reconciles it to chart values.
  Requires perl (only when one of these is used).

Requires kubectl (context set) and jq. DB access is via kubectl exec into
${PG_POD} — no local psql needed.
USAGE
}

main() {
  local cmd="${1:-}"; shift || true
  while [ $# -gt 0 ]; do
    case "$1" in
      -n | --namespace) NAMESPACE="$2"; shift 2 ;;
      -r | --release)   RELEASE="$2"; shift 2 ;;
      --dry-run)        DRY_RUN=true; shift ;;
      --yes)            ASSUME_YES=true; shift ;;
      --title)          MAINT_TITLE="$2";   MAINT_TITLE_SET=true;   shift 2 ;;
      --message)        MAINT_MESSAGE="$2"; MAINT_MESSAGE_SET=true; shift 2 ;;
      --eta)            MAINT_ETA="$2";     MAINT_ETA_SET=true;     shift 2 ;;
      -h | --help)      usage; exit 0 ;;
      *) die "unknown option: $1 (see --help)" ;;
    esac
  done
  # Re-derive names that depend on NAMESPACE/RELEASE flags parsed above.
  PG_POD="${RELEASE}-postgres-0"
  INGRESS="${RELEASE}"; WEB_SVC="${RELEASE}-web"; MAINT_SVC="${RELEASE}-maintenance"
  MAINT_CM="${RELEASE}-maintenance"
  FUNCTIONS_HPA="${RELEASE}-functions"
  STATE_CM="${RELEASE}-maintenance-state"; INSTANCE_LABEL="app.kubernetes.io/instance=${RELEASE}"

  if { $MAINT_TITLE_SET || $MAINT_MESSAGE_SET || $MAINT_ETA_SET; } && [ "$cmd" != "down" ]; then
    warn "--title/--message/--eta only apply to 'down'; ignoring for '${cmd}'"
  fi

  case "$cmd" in
    down)   cmd_down ;;
    up)     cmd_up ;;
    status) cmd_status ;;
    -h | --help | "") usage; [ -z "$cmd" ] && exit 1 || exit 0 ;;
    *) usage; die "unknown command: $cmd" ;;
  esac
}

main "$@"
