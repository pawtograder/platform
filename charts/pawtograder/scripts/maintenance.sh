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
#   maintenance.sh down          # fence + drain + page up, report SAFE TO BOUNCE
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

# Drain gate: how long to wait for the async queues to empty, and poll cadence.
DRAIN_TIMEOUT_SECONDS="${DRAIN_TIMEOUT_SECONDS:-900}"
DRAIN_POLL_SECONDS="${DRAIN_POLL_SECONDS:-5}"

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
MAINT_PORT="8080"
FUNCTIONS_DEPLOY="${RELEASE}-functions"
FUNCTIONS_HPA="${RELEASE}-functions"
STATE_CM="${RELEASE}-maintenance-state"
INSTANCE_LABEL="app.kubernetes.io/instance=${RELEASE}"

# Stable writer Deployments (channels web-*/functions-* are discovered at runtime).
STABLE_WRITERS=(web rest auth storage realtime)

# Write-capable CronJobs to suspend for the window (component suffixes).
SUSPEND_CRONJOBS=(audit-partitions backup-restore-drill backup-pitr-drill backup-verify)

# pgmq queue tables that must drain to 0 before it is safe to bounce.
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
discover_writers() {
  local stable_re; stable_re="$(IFS='|'; echo "${STABLE_WRITERS[*]}")"
  k get deploy -l "$INSTANCE_LABEL" \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.labels.app\.kubernetes\.io/component}{"\t"}{.spec.replicas}{"\n"}{end}' \
  | awk -v OFS='\t' -v stable="^(${stable_re})$" '
      { comp=$2
        channel = (comp ~ /^web-/ || comp ~ /^functions-/)
        if (comp ~ stable || channel) print $1, $3
      }'
}

# ----------------------------------------------------------------------------
# Standby health report
# ----------------------------------------------------------------------------
report_standby() {
  local streaming lag
  streaming="$(psql_ro "SELECT count(*) FROM pg_stat_replication WHERE state='streaming' AND usename='supabase_replication_admin';")"
  lag="$(psql_ro "SELECT COALESCE(max(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)),0) FROM pg_stat_replication WHERE usename='supabase_replication_admin';")"
  streaming="${streaming:-0}"; lag="${lag:-unknown}"
  log "physical standbys streaming: ${streaming}; max replay lag: ${lag} bytes"
  if [ "$streaming" -ge 1 ] 2>/dev/null; then
    printf '%s[maint ✓] SAFE TO BOUNCE%s — standby streaming (lag %s bytes). Perform the node/DB maintenance, then run: %s up\n' \
      "$C_OK" "$C_RESET" "$lag" "$0"
  else
    printf '%s[maint ⚠] NOT READY%s — no physical standby streaming. Bouncing now risks data loss; investigate before proceeding.\n' \
      "$C_WARN" "$C_RESET"
  fi
}

# ----------------------------------------------------------------------------
# State ConfigMap
# ----------------------------------------------------------------------------
state_exists() { k get configmap "$STATE_CM" >/dev/null 2>&1; }

state_get() { k get configmap "$STATE_CM" -o jsonpath="{.data.$1}" 2>/dev/null; }

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

  confirm "Fence writes + drain + put up the maintenance page in ${NAMESPACE}?"

  local tmp; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

  # 1. Pause pg_cron (record the jobids that were active first).
  step "1/7 pg_cron" "pausing scheduled jobs"
  local active_jobs
  active_jobs="$(psql_ro "SELECT string_agg(jobid::text, ',') FROM cron.job WHERE active;")" || true
  printf '%s' "${active_jobs:-}" > "$tmp/cron_jobids"
  log "active cron jobs: ${active_jobs:-none}"
  psql_exec "UPDATE cron.job SET active=false WHERE active;"
  ok "pg_cron paused"

  # 2. Capture + delete the edge-functions HPA; scale functions to 0.
  step "2/7 edge-functions" "capturing HPA and scaling to 0 (in-flight drains via edge-runtime graceful-exit)"
  : > "$tmp/functions_hpa"
  if k get hpa "$FUNCTIONS_HPA" >/dev/null 2>&1; then
    if $DRY_RUN; then
      printf '%s[dry-run]%s capture + delete hpa/%s\n' "$C_WARN" "$C_RESET" "$FUNCTIONS_HPA"
    else
      k get hpa "$FUNCTIONS_HPA" -o json \
        | jq 'del(.status, .metadata.resourceVersion, .metadata.uid, .metadata.creationTimestamp, .metadata.generation, .metadata.managedFields, .metadata.annotations."kubectl.kubernetes.io/last-applied-configuration")' \
        > "$tmp/functions_hpa"
      run k delete hpa "$FUNCTIONS_HPA"
    fi
    ok "edge-functions HPA captured"
  else
    warn "no edge-functions HPA (${FUNCTIONS_HPA}); nothing to capture"
  fi
  run k scale deploy "$FUNCTIONS_DEPLOY" --replicas=0

  # 3. Drain gate: wait for the async queues to empty.
  step "3/7 drain" "waiting for in-flight async work to finish"
  if $DRY_RUN; then
    log "[dry-run] current queue depth: $(queue_depth)"
  else
    local waited=0 depth
    while :; do
      depth="$(queue_depth)"
      if [[ "$depth" =~ ^[0-9]+$ ]]; then
        if [ "$depth" -eq 0 ]; then
          ok "draining in-flight: 0 ✓"
          break
        fi
        log "draining in-flight: ${depth} (waited ${waited}s / ${DRAIN_TIMEOUT_SECONDS}s)"
      else
        # Never treat an unreadable depth as drained — keep waiting until timeout.
        warn "could not read queue depth (got '${depth}'); retrying"
      fi
      if [ "$waited" -ge "$DRAIN_TIMEOUT_SECONDS" ]; then
        die "queues did not drain within ${DRAIN_TIMEOUT_SECONDS}s (last depth '${depth}'); NOT safe to fence. Investigate stuck workers."
      fi
      sleep "$DRAIN_POLL_SECONDS"; waited=$((waited + DRAIN_POLL_SECONDS))
    done
  fi

  # 4. Scale remaining writer tiers + channels to 0 (record counts).
  step "4/7 writers" "scaling app tiers + channels to 0"
  discover_writers > "$tmp/deploy_replicas"
  if [ -s "$tmp/deploy_replicas" ]; then
    local name replicas
    while IFS=$'\t' read -r name replicas; do
      [ -n "$name" ] || continue
      log "  ${name}: ${replicas} -> 0"
      run k scale deploy "$name" --replicas=0
    done < "$tmp/deploy_replicas"
  fi
  ok "writer tiers scaled down"

  # 5. Suspend write-capable CronJobs (record prior suspend state).
  step "5/7 cronjobs" "suspending write-capable CronJobs"
  : > "$tmp/cronjobs_suspend"
  local cj cjname prior
  for cj in "${SUSPEND_CRONJOBS[@]}"; do
    cjname="${RELEASE}-${cj}"
    if k get cronjob "$cjname" >/dev/null 2>&1; then
      prior="$(k get cronjob "$cjname" -o jsonpath='{.spec.suspend}')"; prior="${prior:-false}"
      printf '%s\t%s\n' "$cjname" "$prior" >> "$tmp/cronjobs_suspend"
      run k patch cronjob "$cjname" --type=merge -p '{"spec":{"suspend":true}}'
      log "  suspended ${cjname} (was suspend=${prior})"
    fi
  done
  ok "CronJobs suspended"

  # Record the ingress web-host backend BEFORE swapping (restore it exactly).
  # jsonpath can't emit JSON for the backend object, so capture name+port scalars
  # and reconstruct valid JSON for the later `up` patch.
  local cur_name cur_port rule0_host
  cur_name="$(k get ingress "$INGRESS" -o jsonpath='{.spec.rules[0].http.paths[0].backend.service.name}' 2>/dev/null || true)"
  cur_port="$(k get ingress "$INGRESS" -o jsonpath='{.spec.rules[0].http.paths[0].backend.service.port.number}' 2>/dev/null || true)"
  rule0_host="$(k get ingress "$INGRESS" -o jsonpath='{.spec.rules[0].host}' 2>/dev/null || true)"
  : > "$tmp/ingress_backend"
  if [ -n "$cur_name" ] && [ -n "$cur_port" ]; then
    printf '{"name":"%s","port":{"number":%s}}' "$cur_name" "$cur_port" > "$tmp/ingress_backend"
  fi
  log "ingress rules[0] host=${rule0_host:-?} backend=${cur_name:-?}:${cur_port:-?}"
  if [ "$cur_name" != "$WEB_SVC" ]; then
    warn "rules[0].paths[0] backend is '${cur_name:-?}', not ${WEB_SVC}; verify this is the web host before proceeding"
  fi

  # Persist captured state BEFORE putting the page up, so `up` can always restore.
  if ! $DRY_RUN; then
    k create configmap "$STATE_CM" \
      --from-file=cron_jobids="$tmp/cron_jobids" \
      --from-file=functions_hpa="$tmp/functions_hpa" \
      --from-file=deploy_replicas="$tmp/deploy_replicas" \
      --from-file=cronjobs_suspend="$tmp/cronjobs_suspend" \
      --from-file=ingress_backend="$tmp/ingress_backend" >/dev/null
    ok "captured prior state -> configmap/${STATE_CM}"
  else
    log "[dry-run] would save state -> configmap/${STATE_CM}"
  fi

  # 6. Put up the maintenance page (requires maintenance.enabled already deployed).
  step "6/7 page" "routing the web host to the maintenance page"
  if ! k get deploy "$MAINT_SVC" >/dev/null 2>&1; then
    warn "Deployment ${MAINT_SVC} not found — deploy it first (helm upgrade --set maintenance.enabled=true). Skipping ingress swap."
  else
    if ! $DRY_RUN; then
      k rollout status deploy "$MAINT_SVC" --timeout=120s \
        || warn "${MAINT_SVC} not Ready; the page may 502 until it is"
    fi
    run k patch ingress "$INGRESS" --type=json -p \
      "[{\"op\":\"replace\",\"path\":\"/spec/rules/0/http/paths/0/backend/service\",\"value\":{\"name\":\"${MAINT_SVC}\",\"port\":{\"number\":${MAINT_PORT}}}}]"
    ok "web host -> ${MAINT_SVC}:${MAINT_PORT}"
  fi

  # 7. Report standby health so the operator knows whether it is safe to bounce.
  step "7/7 standby" "checking replication before the bounce"
  report_standby
}

# ----------------------------------------------------------------------------
# up
# ----------------------------------------------------------------------------
cmd_up() {
  need kubectl; need jq
  log "namespace=${NAMESPACE} release=${RELEASE} $($DRY_RUN && echo '(dry-run)')"
  state_exists || die "no state ConfigMap ${STATE_CM} — nothing to restore (was '$0 down' run in this namespace?)"

  confirm "Restore ${NAMESPACE} from ${STATE_CM} and take the maintenance page down?"

  local tmp; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

  # A. Drop the maintenance page FIRST-of-restore is wrong: page comes down LAST.
  #    Restore backends/pods first while the page still shields users.

  # 1. Restore writer tiers + channels to recorded counts.
  step "1/6 writers" "restoring app tiers + channels"
  state_get deploy_replicas > "$tmp/deploy_replicas" || true
  if [ -s "$tmp/deploy_replicas" ]; then
    local name replicas
    while IFS=$'\t' read -r name replicas; do
      [ -n "$name" ] || continue
      log "  ${name} -> ${replicas}"
      run k scale deploy "$name" --replicas="$replicas"
    done < "$tmp/deploy_replicas"
  fi
  ok "writer tiers restored"

  # 2. Recreate the edge-functions HPA (re-apply the captured object). Alternative:
  #    `helm upgrade --reuse-values` reconciles it from chart values (cleanest in a
  #    GitOps flow) — we re-apply the captured object to stay self-contained.
  step "2/6 edge-functions" "restoring HPA + scaling functions back"
  state_get functions_hpa > "$tmp/functions_hpa" || true
  if [ -s "$tmp/functions_hpa" ] && [ "$(tr -d '[:space:]' < "$tmp/functions_hpa")" != "" ]; then
    run k apply -f "$tmp/functions_hpa"
    ok "edge-functions HPA re-applied (autoscaler will manage functions replicas)"
  else
    warn "no captured HPA; leaving functions at its Deployment replica count (restored above or via helm)"
  fi

  # 3. Unsuspend CronJobs to their recorded prior state.
  step "3/6 cronjobs" "restoring CronJob suspend state"
  state_get cronjobs_suspend > "$tmp/cronjobs_suspend" || true
  if [ -s "$tmp/cronjobs_suspend" ]; then
    local cjname prior
    while IFS=$'\t' read -r cjname prior; do
      [ -n "$cjname" ] || continue
      log "  ${cjname} -> suspend=${prior}"
      run k patch cronjob "$cjname" --type=merge -p "{\"spec\":{\"suspend\":${prior}}}"
    done < "$tmp/cronjobs_suspend"
  fi
  ok "CronJobs restored"

  # 4. Resume pg_cron for exactly the jobs that were active.
  step "4/6 pg_cron" "resuming scheduled jobs"
  local jobids; jobids="$(state_get cron_jobids || true)"
  if [ -n "$jobids" ]; then
    psql_exec "UPDATE cron.job SET active=true WHERE jobid = ANY(ARRAY[${jobids}]::bigint[]);"
    ok "resumed cron jobs: ${jobids}"
  else
    log "no cron jobs were active at down time; nothing to resume"
  fi

  # 5. Verify functions healthy (best-effort) before dropping the page.
  step "5/6 verify" "waiting for edge-functions to be available"
  if ! $DRY_RUN; then
    k rollout status deploy "$FUNCTIONS_DEPLOY" --timeout=180s \
      || warn "${FUNCTIONS_DEPLOY} not Ready yet; check before announcing the window closed"
  fi

  # 6. Point the web host back to the app, then delete state LAST. Page down last.
  step "6/6 page" "restoring the web host to the app"
  local backend; backend="$(state_get ingress_backend || true)"
  if [ -n "$backend" ]; then
    run k patch ingress "$INGRESS" --type=json -p \
      "[{\"op\":\"replace\",\"path\":\"/spec/rules/0/http/paths/0/backend/service\",\"value\":${backend}}]"
    ok "web host -> restored recorded backend"
  else
    warn "no recorded ingress backend; restoring to ${WEB_SVC}:${WEB_PORT}"
    run k patch ingress "$INGRESS" --type=json -p \
      "[{\"op\":\"replace\",\"path\":\"/spec/rules/0/http/paths/0/backend/service\",\"value\":{\"name\":\"${WEB_SVC}\",\"port\":{\"number\":${WEB_PORT}}}}]"
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
  discover_writers | while IFS=$'\t' read -r name replicas; do
    [ -n "$name" ] && printf '    %s = %s\n' "$name" "$replicas"
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

  down     Fence writes, drain in-flight async work, put up the maintenance page,
           and report whether it is SAFE TO BOUNCE. Captures prior state.
  up       Restore everything from the captured state; drop the page LAST.
  status   Read-only maintenance-posture report.

Options:
  -n, --namespace NS   Namespace   (default: ${NAMESPACE}, env NAMESPACE)
  -r, --release NAME   Helm release (default: ${RELEASE}, env RELEASE)
      --dry-run        Print intended mutations without executing (reads still run)
      --yes            Skip the confirmation prompt
  -h, --help           This help

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
      -h | --help)      usage; exit 0 ;;
      *) die "unknown option: $1 (see --help)" ;;
    esac
  done
  # Re-derive names that depend on NAMESPACE/RELEASE flags parsed above.
  PG_POD="${RELEASE}-postgres-0"
  INGRESS="${RELEASE}"; WEB_SVC="${RELEASE}-web"; MAINT_SVC="${RELEASE}-maintenance"
  FUNCTIONS_DEPLOY="${RELEASE}-functions"; FUNCTIONS_HPA="${RELEASE}-functions"
  STATE_CM="${RELEASE}-maintenance-state"; INSTANCE_LABEL="app.kubernetes.io/instance=${RELEASE}"

  case "$cmd" in
    down)   cmd_down ;;
    up)     cmd_up ;;
    status) cmd_status ;;
    -h | --help | "") usage; [ -z "$cmd" ] && exit 1 || exit 0 ;;
    *) usage; die "unknown command: $cmd" ;;
  esac
}

main "$@"
