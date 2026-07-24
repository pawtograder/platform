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

# Drain gate: how long to wait for the async queues to empty, and poll cadence.
DRAIN_TIMEOUT_SECONDS="${DRAIN_TIMEOUT_SECONDS:-900}"
DRAIN_POLL_SECONDS="${DRAIN_POLL_SECONDS:-5}"

# Standby replay lag (bytes) at/under which a bounce is considered safe. Mirrors
# monitoring.prometheusRules.replicationLagBytesWarning (100 MiB) in values.yaml.
LAG_THRESHOLD_BYTES="${LAG_THRESHOLD_BYTES:-104857600}"

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
report_standby() {
  local streaming lag
  streaming="$(psql_ro "SELECT count(*) FROM pg_stat_replication WHERE state='streaming' AND usename='supabase_replication_admin';")"
  lag="$(psql_ro "SELECT COALESCE(max(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)),0) FROM pg_stat_replication WHERE usename='supabase_replication_admin';")"
  log "physical standbys streaming: ${streaming:-?}; max replay lag: ${lag:-?} bytes (threshold ${LAG_THRESHOLD_BYTES})"
  # SAFE only when a physical standby is streaming AND its replay lag is a known
  # value at/under the threshold — a standby that is streaming but far behind is
  # NOT a safe failover target (promotion would lose the un-replayed tail).
  if [[ "$streaming" =~ ^[0-9]+$ ]] && [ "$streaming" -ge 1 ] \
     && [[ "$lag" =~ ^[0-9]+$ ]] && [ "$lag" -le "$LAG_THRESHOLD_BYTES" ]; then
    printf '%s[maint ✓] SAFE TO BOUNCE%s — standby streaming, replay lag %s <= %s bytes. Perform the node/DB maintenance, then run: %s up\n' \
      "$C_OK" "$C_RESET" "$lag" "$LAG_THRESHOLD_BYTES" "$0"
  else
    printf '%s[maint ⚠] NOT READY%s — need a streaming physical standby with replay lag <= %s bytes; got streaming=%s lag=%s. Bouncing now risks data loss; investigate before proceeding.\n' \
      "$C_WARN" "$C_RESET" "$LAG_THRESHOLD_BYTES" "${streaming:-?}" "${lag:-?}"
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

  confirm "Fence writes + put up the maintenance page in ${NAMESPACE}? (pgmq backlog is durable and drains after 'up')"

  local tmp; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

  # 1. Pause pg_cron (stops in-DB producers). Record the active set first.
  step "1/5 pg_cron" "pausing scheduled jobs"
  local active_jobs
  active_jobs="$(psql_ro "SELECT string_agg(jobid::text, ',') FROM cron.job WHERE active;")"
  printf '%s' "${active_jobs:-}" > "$tmp/cron_jobids"
  log "active cron jobs: ${active_jobs:-none}"
  psql_exec "UPDATE cron.job SET active=false WHERE active;"
  ok "pg_cron paused"

  # --- Capture ALL prior state, then persist it BEFORE any destructive fence
  #     action, so `up` can restore even if the fence is interrupted mid-way. ---
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
      --from-file=ingress_backend="$tmp/ingress_backend" >/dev/null
    ok "captured prior state -> configmap/${STATE_CM}"
  else
    log "[dry-run] would save state -> configmap/${STATE_CM}"
  fi

  # 2. Fence: put the maintenance page up AND scale EVERY writer tier to 0 in one
  #    step. Producers on the web host see the 503 page; edge-runtime's
  #    --graceful-exit-timeout lets any in-flight functions handler COMMIT and exit
  #    cleanly as the pods drain.
  step "2/5 fence" "maintenance page up + all writer tiers -> 0"
  # 2a. delete the functions HPA first so it can't fight the scale-to-0.
  if [ -s "$tmp/functions_hpa" ]; then
    run k delete hpa "$FUNCTIONS_HPA"; ok "edge-functions HPA captured + deleted"
  else
    warn "no edge-functions HPA (${FUNCTIONS_HPA}); nothing to capture"
  fi
  # 2b. put the page up (verify the maintenance Service is Ready first).
  if ! k get deploy "$MAINT_SVC" >/dev/null 2>&1; then
    warn "Deployment ${MAINT_SVC} not found — deploy it first (helm upgrade --set maintenance.enabled=true). Skipping ingress swap."
  else
    if ! $DRY_RUN; then
      k rollout status deploy "$MAINT_SVC" --timeout=120s || warn "${MAINT_SVC} not Ready; the page may 502 until it is"
    fi
    run k patch ingress "$INGRESS" --type=json -p \
      "[{\"op\":\"replace\",\"path\":\"/spec/rules/0/http/paths/0/backend/service\",\"value\":{\"name\":\"${MAINT_SVC}\",\"port\":{\"number\":${MAINT_PORT}}}}]"
    ok "web host -> ${MAINT_SVC}:${MAINT_PORT}"
  fi
  # 2c. scale every writer/channel/functions workload to 0 (records were saved).
  if [ -s "$tmp/deploy_replicas" ]; then
    local kind name replicas
    while IFS=$'\t' read -r kind name replicas; do
      [ -n "$name" ] || continue
      log "  ${kind}/${name}: ${replicas} -> 0"
      run k scale "$kind" "$name" --replicas=0
    done < "$tmp/deploy_replicas"
  fi
  ok "all writer tiers scaled to 0"

  # 3. Suspend write-capable CronJobs (prior states captured above).
  step "3/5 cronjobs" "suspending write-capable CronJobs"
  local cj2 cjn
  for cj2 in "${SUSPEND_CRONJOBS[@]}"; do
    cjn="${RELEASE}-${cj2}"
    if k get cronjob "$cjn" >/dev/null 2>&1; then
      run k patch cronjob "$cjn" --type=merge -p '{"spec":{"suspend":true}}'
      log "  suspended ${cjn}"
    fi
  done
  ok "CronJobs suspended"

  # 4. AUTHORITATIVE GATE: block until every fenced writer/channel/functions
  #    deployment has 0 running pods. Zero writer pods — NOT an empty queue — is
  #    the real safety signal: --graceful-exit-timeout has let in-flight work
  #    COMMIT and no writer process is left touching the DB.
  step "4/5 gate" "waiting for all writer pods to terminate"
  if $DRY_RUN; then
    log "[dry-run] would block until all scaled writer/functions pods terminate"
  else
    local pwaited=0 remaining cur kind2 name2
    while :; do
      remaining=0
      while IFS=$'\t' read -r kind2 name2 _; do
        [ -n "$name2" ] || continue
        cur="$(k get "$kind2" "$name2" -o jsonpath='{.status.replicas}' 2>/dev/null || true)"
        [[ "$cur" =~ ^[0-9]+$ ]] && remaining=$((remaining + cur))
      done < "$tmp/deploy_replicas"
      [ "$remaining" -eq 0 ] && { ok "all writer pods terminated ✓"; break; }
      log "waiting for writer pods to terminate: ${remaining} still running (${pwaited}s / ${DRAIN_TIMEOUT_SECONDS}s)"
      if [ "$pwaited" -ge "$DRAIN_TIMEOUT_SECONDS" ]; then
        die "writer pods did not terminate within ${DRAIN_TIMEOUT_SECONDS}s (${remaining} still running); NOT safe to bounce."
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

  # 5. Report standby health → SAFE TO BOUNCE / NOT READY.
  step "5/5 standby" "checking replication before the bounce"
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

  # 1. Restore writer tiers + channels to recorded counts.
  step "1/6 writers" "restoring app tiers + channels"
  state_get deploy_replicas > "$tmp/deploy_replicas" || true
  if [ -s "$tmp/deploy_replicas" ]; then
    local kind name replicas
    while IFS=$'\t' read -r kind name replicas; do
      [ -n "$name" ] || continue
      log "  ${kind}/${name} -> ${replicas}"
      run k scale "$kind" "$name" --replicas="$replicas"
    done < "$tmp/deploy_replicas"
  fi
  ok "writer tiers restored"

  # 2. Recreate the edge-functions HPA (re-apply the captured object). functions'
  #    replica count was already restored in step 1 (it is in deploy_replicas);
  #    re-applying the HPA hands replica management back to the autoscaler.
  #    Alternative: `helm upgrade --reuse-values` reconciles it from chart values
  #    (cleanest in GitOps) — we re-apply the captured object to stay self-contained.
  step "2/6 edge-functions" "re-applying the edge-functions HPA"
  state_get functions_hpa > "$tmp/functions_hpa" || true
  if [ -s "$tmp/functions_hpa" ] && [ "$(tr -d '[:space:]' < "$tmp/functions_hpa")" != "" ]; then
    run k apply -f "$tmp/functions_hpa"
    ok "edge-functions HPA re-applied (autoscaler resumes managing functions replicas)"
  else
    warn "no captured HPA; functions stays at the replica count restored in step 1"
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
