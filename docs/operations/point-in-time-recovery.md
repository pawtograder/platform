# Point-in-Time Recovery & Standby Failover

WAL-G continuous archiving gives Pawtograder **point-in-time recovery (PITR)** —
restore the database to any moment within the retention window, not just the
last nightly dump — plus a **streaming standby** to fail over to. This runbook
covers configuring it, recovering to a point in time, and promoting the standby.

It builds on and supersedes the RPO floor in
[disaster-recovery.md](./disaster-recovery.md) (the plain `pg_dump`), which stays
as an independent second scheme. This closes PRODUCTION-READINESS §1.2
(WAL/PITR) and provides the manual standby-promotion path for §1.1; automatic
leader election/failover remains deferred.

Scope: the `supabase/postgres` StatefulSet deployed by `charts/pawtograder`.
`NS` is the release namespace, `<release>` the Helm release. Cluster access is a
kubeconfig from the Rancher project.

---

## How it works

The image ships the `wal-g` binary (its cloud-only `admin-mgr` wrapper is
absent), so the chart calls wal-g directly, configured by `WALG_*`/`AWS_*` env
sourced from the `pawtograder-s3` secret and `postgres.walg.*` values:

| Piece          | Mechanism                                                                | Where                                             |
| -------------- | ------------------------------------------------------------------------ | ------------------------------------------------- |
| WAL archiving  | `archive_command = wal-g wal-push %p` (+ `archive_timeout`)              | primary postgres, via generated `postgresql.conf` |
| Base backups   | `wal-g backup-push` on an interval, `wal-g delete retain` for retention  | `base-backup` sidecar in the primary pod          |
| Restore (PITR) | `wal-g backup-fetch` + WAL replay to a target                            | manual, this runbook                              |
| Standby stream | `pg_basebackup -R` bootstrap → WAL streaming, `wal-g wal-fetch` fallback | `postgres-replica` StatefulSet                    |

`WALG_S3_PREFIX` is kept **distinct** from the nightly-dump prefix (`backup.s3`)
so the two schemes never mix in one bucket path.

### Recovery objectives

- **RPO:** seconds to `archive_timeout` (default 60s). Continuously streamed WAL
  and a warm standby mean loss is bounded by the last archived/streamed segment,
  not a 24h dump cycle.
- **RTO:** a **standby promotion** is seconds to a couple of minutes (the standby
  is already warm). A **full PITR restore** from S3 scales with DB size + how
  much WAL must replay to reach the target — budget more than a promotion.

---

## Enabling it

In the environment's values overlay (e.g. `values-staging.yaml`):

```yaml
postgres:
  walg:
    enabled: true
    s3Prefix: s3://pawtograder-staging-backups/walg # DISTINCT from backup.s3
    s3Endpoint: https://s3.talos.ripley.cloud # blank = real AWS
    region: us-east-1
    forcePathStyle: true
    baseBackup:
      intervalHours: 24
      keepBackups: 8 # retention ≈ intervalHours × keepBackups
  replica:
    enabled: true # requires walg.enabled (render guard enforces)
    replicas: 1
    persistence:
      storageClass: local-path # own volume on another node
      size: 100Gi
```

After deploy, verify (below) before trusting it.

### Verifying archiving & replication

```bash
# 1. WAL is landing in S3 (from inside the primary or a wal-g-configured pod):
kubectl -n "$NS" exec -it <release>-postgres-0 -c postgres -- \
  bash -lc 'wal-g backup-list && wal-g wal-show | tail'

# 2. A base backup exists (the sidecar logs each run):
kubectl -n "$NS" logs <release>-postgres-0 -c base-backup | tail

# 3. The standby is streaming (run on the PRIMARY):
kubectl -n "$NS" exec -it <release>-postgres-0 -c postgres -- \
  psql -U supabase_admin -d postgres -c "SELECT application_name, state, sync_state,
    write_lag, replay_lag FROM pg_stat_replication;"

# 4. The standby is in recovery and caught up (run on the STANDBY):
kubectl -n "$NS" exec -it <release>-postgres-replica-0 -c postgres -- \
  psql -U supabase_admin -d postgres -c "SELECT pg_is_in_recovery(),
    now() - pg_last_xact_replay_timestamp() AS replay_delay;"
```

`pg_stat_replication` showing the standby `streaming`, and a small `replay_lag`,
means both halves work. Rehearse the promote path before you need it in anger —
see [Promotion drill](#promotion-drill-rehearsing-failover) below.

---

## Manual failover (promote the standby)

When the primary is lost and the standby is healthy, promote the standby to
become the new primary. This is faster than a full restore because the standby
is already warm.

1. **Confirm the primary is really down** and will not come back writing — a
   split brain (two primaries archiving to the same `WALG_S3_PREFIX`) corrupts
   the archive. If the primary pod is merely pending/rescheduling, wait; only
   promote when the old primary is gone for good.
2. **Stop app writers** so nothing writes to the dead primary path:

   ```bash
   # RUN THE WHOLE FENCE AS ONE COMMAND. The subshell's `set -euo pipefail` is the
   # point: every step below has a failure mode that used to be advisory -- an
   # empty selector, a partial scale, a wait that timed out -- and an operator
   # reading a runbook does not reliably notice a non-zero exit three lines up.
   # Inside `set -e` the sequence STOPS at the first failure and the whole block
   # exits non-zero, so "the fence printed an error" and "the fence completed"
   # cannot look the same.
   (
     set -euo pipefail

     # 0. Pause pg_cron FIRST, and VERIFY the pause took. ~20 scheduled jobs
     #    write in-DB every minute, independent of every app pod, so scaling
     #    Deployments does NOT fence them -- and after the standby is promoted, every
     #    commit the OLD primary's pg_cron makes lands on a timeline the new
     #    primary will never have, and is lost silently. Only reachable when the
     #    old primary is still up -- which is exactly the planned major-version
     #    upgrade planned-maintenance.md routes to this procedure. If the primary
     #    is genuinely gone, these three execs fail; that failure IS step 1's
     #    precondition, so record it and move on rather than forcing the fence.
     #    This step did not exist here until 2026-09-03. planned-maintenance.md
     #    has had it since the write-fence audit, and its comment is the one that
     #    matters here too: a fence that silently skipped its in-database writers
     #    is the WORST version of this failure, because the app pods are all gone
     #    and so everything looks quiet. Executed against a namespace with the
     #    pods gone and 3 cron jobs active, this procedure's gate printed
     #    "fence verified: no writer pods present" and ran `pg_ctl promote`.
     #
     #    Record the active jobids first: step 5 resumes exactly those, and an
     #    `UPDATE cron.job SET active=true` with no WHERE would also enable jobs
     #    that were disabled on purpose.
     #
     #    Then VERIFY, because this psql can fail in ways that leave the jobs
     #    running (wrong pod name after a rename, RBAC on exec, a primary that is
     #    not `-0`). The count is read WITHOUT a `| tr` pipeline: `set -o
     #    pipefail` is in force here so a pipeline would in fact abort, but the
     #    same line copied into `fenced()` below -- where it is not -- is how the
     #    swallowed-exit-status bug got in, so both forms are written the same way.
     if kubectl -n "$NS" get pod <release>-postgres-0 >/dev/null 2>&1; then
       kubectl -n "$NS" exec <release>-postgres-0 -c postgres -- psql -U supabase_admin \
         -d postgres -tAc "SELECT string_agg(jobid::text,',') FROM cron.job WHERE active;"
       kubectl -n "$NS" exec <release>-postgres-0 -c postgres -- psql -U supabase_admin \
         -d postgres -c "UPDATE cron.job SET active=false WHERE active;"
       still_active="$(kubectl -n "$NS" exec <release>-postgres-0 -c postgres -- psql -U supabase_admin \
         -d postgres -tAc "SELECT count(*) FROM cron.job WHERE active;")"
       still_active="${still_active//[[:space:]]/}"
     else
       # GUARDED, because `set -e` would otherwise abort this fence on the most
       # common promote of all -- the one where the primary is already gone. A
       # step that fails when everything is correct is a step that gets skipped
       # next time.
       still_active=0
       echo "no <release>-postgres-0 pod: the old primary is gone, so its pg_cron cannot fire."
       echo "Confirm that in step 1 deliberately; do not infer it from this line."
     fi
     if [ "$still_active" != "0" ]; then
       echo "STOP: $still_active pg_cron job(s) are still active -- in-database writers are NOT fenced." >&2
       exit 1
     fi

     # 1. Record what to restore, and record it BEFORE anything is mutated:
     #    writer Deployments + the realtime StatefulSet (name, kind and desired
     #    replicas -- a `-o wide` snapshot is not machine-readable) and the
     #    edge-functions HPA's YAML. Step 5 (“Scale writers back up (step 2 in reverse)”) said "step 2 in reverse" and had nothing to
     #    reverse: this block captured no replica counts and no HPA.
     #    `-l app.kubernetes.io/instance=<release>` scopes it to THIS release, so
     #    an unrelated workload sharing the namespace is neither recorded nor
     #    "restored".
     STATE_DIR="/tmp/pitr-fence-$(date +%s)"; mkdir -p "$STATE_DIR"
     kubectl -n "$NS" get deploy,statefulset -l "app.kubernetes.io/instance=<release>" \
       -o jsonpath='{range .items[*]}{.kind}{"\t"}{.metadata.name}{"\t"}{.spec.replicas}{"\n"}{end}' \
       > "$STATE_DIR/replicas.txt"
     kubectl -n "$NS" get hpa -l "app.kubernetes.io/instance=<release>" -o yaml > "$STATE_DIR/hpa.yaml"
     echo "prior state recorded in $STATE_DIR -- step 5 reads it back. Note the path down."

     # 2. Delete the edge-functions HPA, now that it is recorded. NOT because
     #    `kubectl scale --replicas=0` gets undone -- it does not: with
     #    `spec.replicas: 0` and `minReplicas` non-zero the HPA controller reports
     #    `ScalingActive=False` / `ScalingDisabled` and stops acting on the target
     #    (scaling a workload back OFF zero needs the `HPAScaleToZero` gate, still
     #    alpha; prod runs v1.32.13 without it). Delete it because the instant
     #    anything sets `spec.replicas` off zero -- a partial restore, a deploy
     #    run, a controller reconcile -- the HPA re-arms and drives the tier back
     #    toward `minReplicas`, un-fencing it with no operator action. Reasoned
     #    from the controller's documented scale-to-zero behaviour, not measured,
     #    because measuring it means scaling prod.
     #    `--ignore-not-found` because an install with autoscaling off has no HPA
     #    and a NotFound would abort a fence that is otherwise fine; unlike
     #    `scale`, `delete` really does take that flag.
     kubectl -n "$NS" delete hpa <release>-functions --ignore-not-found

     # 3. Discover the write tiers by LABEL rather than naming them. A fixed list is
     # wrong here in three separate ways, and each one leaves a writer running
     # through a window this step exists to close:
     #   * `edgeFunctions.workerTier` adds a SECOND edge Deployment
     #     (`<release>-functions-workers`), and it is the one that drains pgmq.
     #   * deployment channels add `<release>-functions-<channel>` and
     #     `<release>-web-<channel>`, which share this Postgres.
     #   * `auth` and `storage` write too (GoTrue's user tables, storage's object
     #     rows); an earlier version of this step named neither.
     # Select on `app.kubernetes.io/instance`, which is the RELEASE NAME. Do not
     # select on `app.kubernetes.io/name`: `pawtograder.name` stamps `nameOverride`
     # into it, so `-l app.kubernetes.io/name=pawtograder` matches nothing at all on
     # an install that sets one -- and a selector that matches nothing scales
     # nothing, exits 0, and prints nothing, so the failure is silent. The component
     # regex is what keeps this from being a whole-release selector: `postgres`,
     # `kong`, `supavisor` and the maintenance page do not match it.
     #
     # `meta` and `studio` ARE matched, and were not until 2026-09-03: both hold a
     # direct Postgres connection as the `postgres` superuser (meta's PG_META_DB_*,
     # studio's POSTGRES_HOST/POSTGRES_PASSWORD) to serve Studio's Database and
     # SQL-editor pages, so an operator with a Studio tab open could commit DDL
     # through a fence that counted only app tiers.
     #
     # `supavisor` stays out deliberately -- it originates no writes, it proxies
     # them -- but note the consequence: its pooled Postgres port
     # (`<release>-supavisor` :6543) stays reachable for the whole window, so an
     # in-cluster client holding a pooled connection can still write.
     #
     # Realtime is enumerated BY NAME rather than scaled with `-l`, which is the
     # other silent hole this block used to have: `kubectl scale statefulset -l
     # <selector>` prints "No resources found" and exits 0 when the selector
     # matches nothing, so a realtime rename or a label change skipped the one
     # StatefulSet in the fence without failing anything.
     jp='{range .items[*]}{.metadata.labels.app\.kubernetes\.io/component}{" "}{.metadata.name}{"\n"}{end}'
     WRITE_DEPLOY="$(kubectl -n "$NS" get deploy -l "app.kubernetes.io/instance=<release>" -o jsonpath="$jp" \
       | awk '$1 ~ /^(web|rest|auth|storage|functions|meta|studio)(-.+)?$/ { print "deploy/" $2 }')"
     WRITE_STS="$(kubectl -n "$NS" get statefulset -l "app.kubernetes.io/instance=<release>" -o jsonpath="$jp" \
       | awk '$1 ~ /^realtime(-.+)?$/ { print "statefulset/" $2 }')"
     WRITERS="$(printf '%s\n%s\n' "$WRITE_DEPLOY" "$WRITE_STS" | awk 'NF')"

     printf '%s\n' "$WRITERS"   # eyeball it first: this list IS the fence
     if [ -z "$WRITERS" ]; then
       echo "NOTHING MATCHED -- wrong release name or namespace. NOT fenced; do not proceed." >&2
       exit 1
     fi
     # shellcheck disable=SC2086  # deliberate word-splitting: one kubectl call, N targets
     kubectl -n "$NS" scale $WRITERS --replicas=0

     # 4. Suspend the write-capable CronJobs before the long wait below, so none
     #    FIRES during it or during the work that follows.
     #    `audit-partitions` runs at 03:00 and writes DDL; the backup drills
     #    restore into scratch databases on this same server. The `backup`
     #    CronJob itself is left alone: pg_dump only reads. Suspending does not
     #    stop a Job that is ALREADY running -- `fenced()` below refuses on that
     #    separately, which is the half a suspend cannot cover.
     #    Record each prior `suspend` value: some may be suspended on purpose.
     for cj in audit-partitions backup-verify backup-restore-drill backup-pitr-drill; do
       name="<release>-$cj"
       if kubectl -n "$NS" get cronjob "$name" >/dev/null 2>&1; then
         prior="$(kubectl -n "$NS" get cronjob "$name" -o jsonpath='{.spec.suspend}')"
         printf '%s\t%s\n' "$name" "${prior:-false}" >> "$STATE_DIR/cronjobs.txt"
         kubectl -n "$NS" patch cronjob "$name" --type=merge -p '{"spec":{"suspend":true}}'
       fi
     done
     # 5. Then WAIT, and wait LONG ENOUGH. `kubectl scale` only writes
     # `.spec.replicas`; termination is asynchronous, so between the scale
     # returning and the last pod exiting there is a window in which a "fenced"
     # writer is still committing -- including a worker still draining pgmq into
     # the database you are about to overwrite.
     #
     # 480s is DERIVED from the chart, not chosen for looking generous. The edge
     # tier dominates every other fenced component (realtime is next at 60s):
     #     preStopSleepSeconds        10s   endpoint-drop delay before SIGTERM
     #   + gracefulExitTimeoutSeconds 410s  in-flight drain (>= worker.timeoutMs 400s)
     #   = 420s of intended drain
     #     terminationGracePeriodSeconds 430s  kubelet SIGKILL backstop, and so the
     #                                         hard ceiling on a pod's life after
     #                                         deletion
     #   + ~50s  container teardown and the pod object leaving the API
     #   = 480s
     # An earlier version of this step waited 300s, which was below the graceful
     # window ALONE: a worker running a long batch legitimately outlived the wait,
     # and the timeout read as "taking a while" rather than "still writing".
     # If your overlay raises any of those three values, re-derive this: they are
     # in `charts/pawtograder/values.yaml` under `edgeFunctions`.
     PODS="$(kubectl -n "$NS" get pod -l "app.kubernetes.io/instance=<release>" -o jsonpath="$jp" \
       | awk '$1 ~ /^(web|rest|auth|storage|functions|realtime|meta|studio)(-.+)?$/ { print "pod/" $2 }')"
     # By NAME, not `-l`: `kubectl wait -l <selector>` exits non-zero with "no
     # matching resources found" when nothing matches, which is the NORMAL state
     # here once the pods are already gone -- and a step that fails when everything
     # is correct is a step that gets skipped next time.
     if [ -n "$PODS" ]; then
       # shellcheck disable=SC2086
       if ! kubectl -n "$NS" wait --for=delete $PODS --timeout=480s; then
         echo "STOP: writer pods are STILL PRESENT after the full 480s drain window." >&2
         echo "They can still be committing. Do NOT run the next step. Investigate with" >&2
         echo "  kubectl -n \"$NS\" get pod -l app.kubernetes.io/instance=<release>" >&2
         exit 1
       fi
     fi

     echo "FENCED: pg_cron paused, write CronJobs suspended, every web/rest/auth/storage/edge/realtime/meta/studio pod gone."
   )
   ```

3. **Promote the standby:**

   ```bash
   # HARD GATE, and it is chained with `&&` on purpose: the destructive command
   # below CANNOT run unless the assertion exits 0. A writer still committing to the OLD primary
   # after the standby is promoted is a split brain: those commits are on a
   # timeline the new primary will never have, and they are lost silently.
   #
   # This is deliberately a re-check rather than trust in the previous step. The
   # gap between the two steps is however long the operator takes, and a
   # `helm upgrade`, an HPA, or a controller reconcile can put pods back in it.
   fenced() {
     local jp pods seen pg primary left active_jobs running_jobs crons
     jp='{range .items[*]}{.metadata.labels.app\.kubernetes\.io/component}{" "}{.metadata.name}{"\n"}{end}'
     # Take kubectl's EXIT STATUS, not just its output. A failed `get pod` -- an
     # expired token, the wrong context, a `get`-scoped role, a transient API 5xx --
     # writes nothing to stdout, so `awk ... END { print n+0 }` still prints 0 and
     # this gate reported "fence verified" and ran the command below. It failed
     # OPEN, onto a destructive step, which is the one direction a fence must never
     # fail. "I could not tell" is not "nothing is running".
     if ! pods="$(kubectl -n "$NS" get pod -l "app.kubernetes.io/instance=<release>" -o jsonpath="$jp")"; then
       echo "NOT FENCED: could not list pods (RBAC, expired credentials, or an API error) -- refusing to continue." >&2
       return 1
     fi
     # ASSERT WE ARE LOOKING AT THE RELEASE before concluding "no writers". An
     # EMPTY pod list satisfies every check below, so a namespace typo or a wrong
     # `<release>` substituted into this block read as `fence verified: no writer
     # pods present` and ran the destructive command. Step 1's fence guards this
     # (`if [ -z "$WRITERS" ] ... NOTHING MATCHED`) but THIS is a separate code
     # block with its own `<release>` placeholder, filled in independently, so
     # that guard does not cover it -- and unlike the `nameOverride` selector bug
     # this reproduces from a plain namespace typo. A postgres pod is the assertion
     # to make: it is the thing being protected, it is deliberately still running
     # here, and on the promote path the standby (`postgres-replica`) stands in for
     # a dead primary. Zero pods, or pods but no postgres, means the SELECTOR is
     # empty -- not the cluster.
     seen="$(printf '%s\n' "$pods" | awk 'NF { n++ } END { print n+0 }')"
     pg="$(printf '%s\n' "$pods" | awk '$1 ~ /^postgres(-replica)?$/ { n++ } END { print n+0 }')"
     if [ "$seen" -eq 0 ] || [ "$pg" -eq 0 ]; then
       echo "NOT FENCED: the selector matched $seen pod(s) and $pg postgres pod(s)." >&2
       echo "  An empty match is a wrong namespace or a wrong <release>, NOT a quiet cluster." >&2
       return 1
     fi
     left="$(printf '%s\n' "$pods" \
       | awk '$1 ~ /^(web|rest|auth|storage|functions|realtime|meta|studio)(-.+)?$/ { n++ } END { print n+0 }')"
     if [ "$left" -ne 0 ]; then
       echo "NOT FENCED: $left writer pod(s) still present -- refusing to continue." >&2
       return 1
     fi
     # Suspending a CronJob does NOT stop a Job that is already running, and this
     # gate has to cover the one that started a second before the suspend landed.
     # `audit-partitions` (03:00) writes DDL; the backup drills restore into
     # scratch databases on this same server. `.status.active` is absent rather
     # than 0 when nothing is running, so the awk test is on a possibly-empty
     # field -- which is why it is `$3 > 0` and not `$3 != 0`.
     if ! active_jobs="$(kubectl -n "$NS" get job -l "app.kubernetes.io/instance=<release>" \
       -o jsonpath='{range .items[*]}{.metadata.labels.app\.kubernetes\.io/component}{" "}{.metadata.name}{" "}{.status.active}{"\n"}{end}')"; then
       echo "NOT FENCED: could not list Jobs (RBAC or an API error) -- refusing to continue." >&2
       return 1
     fi
     running_jobs="$(printf '%s\n' "$active_jobs" \
       | awk '$3 > 0 && $1 ~ /^(audit-partitions|backup-verify|backup-restore-drill|backup-pitr-drill)$/ { print $2 }')"
     if [ -n "$running_jobs" ]; then
       echo "NOT FENCED: write-capable Job(s) still active -- refusing to continue:" >&2
       printf '  %s\n' $running_jobs >&2
       return 1
     fi
     # pg_cron is checked HERE, and until 2026-09-03 this procedure checked it
     # nowhere. ~20 scheduled jobs commit in-DB every minute with no pod to
     # scale, so the writer-pod count above cannot see them: with the app pods
     # gone and 3 cron jobs active this gate printed `fence verified: no writer
     # pods present` and ran `pg_ctl promote`.
     #
     # WHICH server to check is the whole subtlety, and it is why this is not a
     # copy of the disaster-recovery check. `cron.job` rows live in the primary's
     # database, and pg_cron's worker does not launch jobs while
     # `pg_is_in_recovery()`, so the standby's replicated copy of that table
     # proves nothing about what is RUNNING. So branch on the primary's presence,
     # decided from the POD LIST above rather than from an exec that could fail
     # for unrelated reasons:
     #   * No `postgres` pod -> the old primary is gone, which is step 1's
     #     precondition for promoting at all, so nothing can be firing its cron
     #     jobs. Satisfied, and said out loud rather than silently skipped.
     #   * `postgres` pod still present -> this is the planned major-version
     #     upgrade that planned-maintenance.md routes here. The old primary is
     #     ALIVE and its pg_cron keeps committing on the OLD timeline after the
     #     promote -- commits on a timeline the new primary will never have, lost
     #     silently. That is the split brain step 1 exists to prevent, so the
     #     pause must be verified on the PRIMARY, not on the node being promoted.
     primary="$(printf '%s\n' "$pods" | awk '$1 == "postgres" { n++ } END { print n+0 }')"
     if [ "$primary" -eq 0 ]; then
       echo "note: no primary pod present, so pg_cron cannot be firing -- which is the precondition for promoting."
     else
       # Take the exec's EXIT STATUS, and no pipeline, for the reason `get pod`
       # above does: `crons="$(kubectl exec ... | tr -d '[:space:]')"` reports
       # only `tr`'s status, and there is no `set -o pipefail` in a function
       # pasted into an interactive shell, so an exec that printed a count and
       # THEN failed (SPDY reset, API-server timeout) left `crons="0"` and passed.
       if ! crons="$(kubectl -n "$NS" exec <release>-postgres-0 -c postgres -- psql -U supabase_admin \
         -d postgres -tAc "SELECT count(*) FROM cron.job WHERE active;")"; then
         echo "NOT FENCED: the old primary is STILL RUNNING and its cron.job could not be read -- refusing to promote." >&2
         return 1
       fi
       crons="${crons//[[:space:]]/}"
       if [ "$crons" != "0" ]; then
         echo "NOT FENCED: $crons pg_cron job(s) active on the OLD primary -- promoting now strands their commits on the abandoned timeline. Refusing." >&2
         return 1
       fi
     fi
     echo "fence verified: postgres present, no writer pods, no active write Jobs, no active pg_cron jobs"
   }

   # Promote and VERIFY as one sequence under `set -e`. The two loose commands
   # this replaces had three separate defects:
   #   * The `pg_is_in_recovery()` result was printed and never checked, so a
   #     FAILED promote led straight into step 4 repointing every service at a
   #     standby still in recovery -- a read-only server, with all writers at 0.
   #   * The trailing psql MASKED the gate. Executed with `fenced` refusing, the
   #     promote was correctly skipped and the block still exited 0, because a
   #     block's status is its last command's. The refusal was invisible.
   #   * That psql had no `-d postgres`, so it connected to a database named
   #     after the role: `FATAL: database "supabase_admin" does not exist`. Every
   #     other psql in these runbooks passes `-d postgres`.
   # And `pg_is_in_recovery() = f` is necessary but NOT sufficient -- the same
   # argument planned-maintenance.md makes for its post-bounce check. Also
   # confirm the node is not read-only and can allocate an xid: `txid_current()`
   # errors on a read-only or in-recovery server and succeeds on a writable
   # primary, so it is the check that fails when a promote silently did not take.
   #
   # `pg_ctl promote` runs BARE here, with no `su postgres`, and that is correct
   # for this overlay -- see the note at the promotion drill's step 3(b), which
   # needs the opposite.
   (
     set -euo pipefail
     fenced
     kubectl -n "$NS" exec <release>-postgres-replica-0 -c postgres -- \
       pg_ctl promote -D /var/lib/postgresql/data/pgdata
     # POLL: pg_ctl returns once the trigger is written, not once the node is
     # out of recovery, so asking once races the promotion.
     for _ in $(seq 1 30); do
       if out="$(kubectl -n "$NS" exec <release>-postgres-replica-0 -c postgres -- \
           psql -U supabase_admin -d postgres -tAc \
             "SELECT pg_is_in_recovery(), current_setting('transaction_read_only'), txid_current();")" \
          && [ "${out#f|off|}" != "$out" ]; then
         echo "PROMOTED: out of recovery, writable, xid allocated -- $out"
         exit 0
       fi
       sleep 2
     done
     echo "PROMOTE UNVERIFIED after 60s: not confirmed out of recovery AND writable." >&2
     echo "Do NOT repoint services in step 4 -- they would land on a read-only server." >&2
     exit 1
   )
   ```

   On promotion the node leaves recovery and (because `archive_mode=on` is in
   the shared config) **starts archiving** to `WALG_S3_PREFIX` on a new
   timeline — so the archive continues from the new primary.

4. **Repoint services at the new primary.** The services address the primary by
   the `<release>-postgres` Service name. Fastest cutover: scale the old primary
   StatefulSet to 0 and point the `<release>-postgres` Service selector at the
   promoted pod, **or** (cleaner, GitOps) promote the standby's data into a
   rebuilt primary. For an emergency, editing the `<release>-postgres` Service
   selector to match the replica pod's labels is the quickest redirect; record
   it so the values file is reconciled afterward.
5. **Scale writers back up — step 2 in reverse, from what step 2 recorded.**
   Note the pg_cron resume runs against the **new** primary (the promoted pod),
   which is what `<release>-postgres` now selects after step 4; the jobids are
   the ones step 2 printed, replicated across with the rest of the table:

   ```bash
   # $STATE_DIR did NOT survive step 2 -- it was assigned inside that step's
   # `( set -euo pipefail )` subshell. Use the path that step printed; `ls -t`
   # picks the newest if you did not note it down.
   STATE_DIR="$(ls -dt /tmp/pitr-fence-* | head -1)"
   [ -s "$STATE_DIR/replicas.txt" ] || { echo "no recorded state in $STATE_DIR -- do NOT guess replica counts" >&2; exit 1; }
   echo "restoring from $STATE_DIR"

   # 1. Resume pg_cron for exactly the jobids step 2 printed. `WHERE active`
   #    with no id list would also enable jobs that were disabled on purpose.
   kubectl -n "$NS" exec <release>-postgres-0 -c postgres -- psql -U supabase_admin \
     -d postgres -c "UPDATE cron.job SET active=true WHERE jobid = ANY(ARRAY[<recorded-jobids>]::bigint[]);"

   # 2. Restore each writer to its RECORDED replica count, by the recorded kind
   #    so the realtime StatefulSet comes back too. Read it from the file; do not
   #    hardcode.
   while IFS=$'\t' read -r kind name replicas; do
     kubectl -n "$NS" scale "${kind,,}" "$name" --replicas="$replicas"
   done < "$STATE_DIR/replicas.txt"

   # 3. Unsuspend the CronJobs to their PRIOR values (not blindly to false).
   if [ -s "$STATE_DIR/cronjobs.txt" ]; then
     while IFS=$'\t' read -r name prior; do
       kubectl -n "$NS" patch cronjob "$name" --type=merge -p "{\"spec\":{\"suspend\":${prior}}}"
     done < "$STATE_DIR/cronjobs.txt"
   fi
   ```

   Then **recreate the deleted edge HPA by reconciling the Helm release**
   (`helm upgrade` with the same values), not `kubectl autoscale`: the chart's
   `edge-functions-hpa.yaml` is an `autoscaling/v2` HPA with **both** CPU and
   memory Resource metrics plus custom scale-up/down behavior, none of which a
   `kubectl autoscale` (CPU-target, v1-style) HPA reproduces. `$STATE_DIR/hpa.yaml`
   is the record of what was there, for checking the reconcile put it back.

   Then run the [smoke checklist](./production-install.md#smoke-test).

6. **Rebuild a new standby.** After failover you have a single primary again.
   Delete the old primary's PVC and re-create the standby (it re-bootstraps from
   the new primary via `pg_basebackup`) so you are protected against the next
   failure.

> **Failing back to the old primary?** Promotion branches a new timeline (e.g.
> timeline 2), and its `.history` file plus WAL land in the archive. Do **not**
> delete the abandoned timeline's objects from the shared archive: that history
> is part of the archive's recovery lineage, and removing it can break later
> point-in-time restores. Instead, keep the promoted node as the primary and
> rebuild the old primary as a fresh standby of it. Run `pg_rewind` (fast, when
> the old primary shut down cleanly and has data checksums or `wal_log_hints`);
> failing that, wipe its PGDATA and re-bootstrap with `pg_basebackup`. Either way
> the rebuilt standby follows the new timeline via
> `recovery_target_timeline = 'latest'`, the same rebuild-the-standby step as any
> post-failover recovery, with no archive surgery.
>
> Failover is deliberately **manual** (no automatic leader election). That
> avoids the split-brain risk an unsupervised promoter carries against a shared
> WAL archive. If automatic failover becomes a requirement, the tracked path is
> Patroni/CloudNativePG (PRODUCTION-READINESS §1.1).

---

## Promotion drill (rehearsing failover)

The [manual failover](#manual-failover-promote-the-standby) above is only
trustworthy if you have run it before the day the primary dies. But you cannot
rehearse it against production: promoting the real standby branches a new
timeline and, worse, a rehearsal that touched the live `WALG_S3_PREFIX` risks the
split brain step 1 exists to prevent. **Rehearse in a throwaway release with its
own isolated archive**, never against prod.

The drill exercises the operator muscle memory — promote, confirm the node left
recovery, repoint, rebuild — in a scratch namespace you can delete afterward.

1. **Stand up a scratch release** (primary + standby) in a fresh namespace. Use
   the **self-contained preview overlay** (`secrets.autogenerate: true`, no ESO/
   OpenBao, no `tier=prod-staging` placement) — the staging overlay is _not_
   self-contained (`secrets.create: false` + fixed secret names) and its pods
   would never start in a fresh namespace. Set `fullnameOverride=drill` so
   resources are named `drill-postgres*` (without it the chart's `fullname`
   helper renders `drill-pawtograder-postgres*`), and a WAL-G prefix **distinct
   from every real environment's** so nothing the drill does can reach a
   production archive:

   ```bash
   DRILL_NS=pg-promote-drill
   DRILL_PREFIX="s3://pawtograder-drill/$(uuidgen)"   # exact, collision-resistant
   kubectl create namespace "$DRILL_NS"

   # The replica render-guard requires walg.enabled, and both WAL-G and the
   # storage API read S3 creds from the `pawtograder-s3` Secret — which the
   # preview overlay's autogenerate path does NOT create. Create it by hand,
   # pointing at a SCRATCH bucket you can wipe (never a real WALG_S3_PREFIX):
   kubectl -n "$DRILL_NS" create secret generic pawtograder-s3 \
     --from-literal=AWS_ACCESS_KEY_ID="$DRILL_S3_KEY" \
     --from-literal=AWS_SECRET_ACCESS_KEY="$DRILL_S3_SECRET"

   helm install drill charts/pawtograder -n "$DRILL_NS" \
     -f charts/pawtograder/examples/values-preview.yaml \
     --set fullnameOverride=drill \
     --set global.hostname="drill.invalid" \
     --set postgres.replica.enabled=true \
     --set postgres.walg.enabled=true \
     --set postgres.walg.s3Endpoint="$DRILL_S3_ENDPOINT" \
     --set postgres.walg.s3Prefix="$DRILL_PREFIX/walg"
   # Wait for drill-postgres-0 and drill-postgres-replica-0 Ready, then run the
   # "Verifying" queries above to confirm the standby is streaming.
   ```

   > The unique, throwaway prefix is the whole safety story: two primaries (the
   > drill's promoted standby + its restarted old primary, or a real cluster) must
   > never archive to one prefix. A per-run UUID prefix guarantees isolation;
   > teardown deletes exactly `$DRILL_PREFIX`, never a broad `*` glob that could
   > hit a concurrent drill.

2. **Write a marker** so you can prove the promoted node carries the data:

   ```bash
   kubectl -n "$DRILL_NS" exec -it drill-postgres-0 -c postgres -- \
     psql -U supabase_admin -d postgres -c "CREATE TABLE IF NOT EXISTS drill_marker(t timestamptz);
       INSERT INTO drill_marker VALUES (now());"
   ```

3. **Fence the primary, promote, and repoint** — the real
   [manual failover](#manual-failover-promote-the-standby) steps, run against the
   `drill-` release so the failure-prone parts are actually rehearsed (do not
   shortcut them):

   ```bash
   # (a0) Wait for the marker (step 2) to replay on the standby before promoting.
   #      Replication is async, so promoting while the standby still lags drops the
   #      very row the drill asserts. Proceed only when the byte gap is ~0 (run on
   #      the primary); repeat until it reads 0.
   kubectl -n "$DRILL_NS" exec drill-postgres-0 -c postgres -- psql -U supabase_admin \
     -d postgres -tAc "SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)
       FROM pg_stat_replication WHERE usename='supabase_replication_admin';"
   # (a) Fence the old primary, and WAIT for it to actually exit — scaling the
   #     StatefulSet to 0 does not prove drill-postgres-0 has stopped, and promoting
   #     while it is still up risks a split brain.
   kubectl -n "$DRILL_NS" scale statefulset drill-postgres --replicas=0
   kubectl -n "$DRILL_NS" wait --for=delete pod/drill-postgres-0 --timeout=120s
   # (b) Promote the standby. pg_ctl refuses to run as root, and in THIS overlay
   #     `kubectl exec` enters as root, so drop to the postgres user. That is a
   #     property of the overlay, not of the image: the preview overlay used by
   #     this drill sets no `runAsUser`, while prod's postgres pods run
   #     `runAsUser: 101, runAsNonRoot: true` -- exec there already enters AS
   #     postgres and bare `pg_ctl promote` is correct, which is why the real
   #     failover above runs it bare. Check `securityContext` in your overlay
   #     before copying either form: getting it backwards in a real failover
   #     means the promote errors out with every writer already at 0.
   kubectl -n "$DRILL_NS" exec drill-postgres-replica-0 -c postgres -- \
     su postgres -c "pg_ctl promote -D /var/lib/postgresql/data/pgdata"
   # (c) Repoint the write Service at the promoted pod (edit the selector to the
   #     replica's component label, or scale the old primary sts to 0 as above).
   kubectl -n "$DRILL_NS" patch svc drill-postgres --type=merge -p \
     '{"spec":{"selector":{"app.kubernetes.io/component":"postgres-replica"}}}'
   ```

4. **Verify the promotion held:** the promoted node left recovery, accepts
   writes, and has the marker row:

   ```bash
   kubectl -n "$DRILL_NS" exec -it drill-postgres-replica-0 -c postgres -- \
     psql -U supabase_admin -d postgres -tAc "SELECT pg_is_in_recovery();"   # f
   kubectl -n "$DRILL_NS" exec -it drill-postgres-replica-0 -c postgres -- \
     psql -U supabase_admin -d postgres -c "INSERT INTO drill_marker VALUES (now());
       SELECT count(*) FROM drill_marker;"                                   # >= 2
   ```

5. **Understand the role-reversal limit (do not create a split brain).** After
   step 3 the promoted node is `drill-postgres-replica-0`; the `drill-postgres`
   StatefulSet (scaled to 0) still holds the stale old-primary data. This chart
   has **no in-place role reversal** — `postgres-statefulset.yaml` always renders
   a _primary_ and `postgres-replica.yaml` always renders a _standby that
   bootstraps from the `drill-postgres` Service_. So:

   > **Never scale `drill-postgres` back up as-is.** It returns as an independent
   > primary on divergent data — exactly the split brain the failover runbook
   > exists to prevent. (Rehearsing this footgun _safely_ in the scratch namespace
   > is a legitimate part of the drill: confirm you recognize it.)

   A clean "rebuild a standby of the new primary" is therefore a **redeploy /
   values reconcile**, not an in-place command: in a real incident you promote the
   recovered data into a rebuilt primary and let a fresh standby bootstrap from it
   (the [manual failover](#manual-failover-promote-the-standby) rebuild note), and
   automatic role reversal is the deferred Patroni/CloudNativePG work
   (PRODUCTION-READINESS §1.1). For the drill, the rehearsal ends at a verified
   promotion; the standby rebuild is exercised by tearing down and reinstalling.

6. **Tear down** — the namespace and its throwaway archive prefix go together, so
   nothing lingers:

   ```bash
   helm uninstall drill -n "$DRILL_NS"
   kubectl delete namespace "$DRILL_NS"
   # delete ONLY this drill's prefix from the object store (not a *-drill-* glob):
   #   aws s3 rm --recursive "$DRILL_PREFIX"
   ```

Run it before each term (and after any change to the postgres/replica templates
or the WAL-G config). It never touches prod, so it is safe to run any time.

---

## Point-in-time restore (recover to a target time/LSN)

Use this to recover from a logical disaster — a bad migration, an accidental
mass delete — where you want the database **as it was just before** the event,
not the current (corrupted) state. This restores from S3 and replays WAL up to a
target, so it can hit a moment the nightly dump can't.

Do it into a **scratch** postgres first when the situation allows (validate the
target), then in place.

### 1. Pick the target

Identify the timestamp (UTC) or LSN just before the bad event — e.g. from
`pg_stat_activity` logs, the migration start time, or `wal-g wal-show`.

### 2. Restore into a scratch data dir

Run a throwaway pod with the postgres image and the same `WALG_*`/`AWS_*` env
(copy from the `postgres` StatefulSet + `pawtograder-s3` secret):

```bash
kubectl -n "$NS" run pitr-shell --rm -it --restart=Never \
  --image=supabase/postgres:17.4.1.075 \
  --env="WALG_S3_PREFIX=..." --env="AWS_ENDPOINT=..." \
  --env="AWS_REGION=us-east-1" --env="AWS_S3_FORCE_PATH_STYLE=true" \
  --env="AWS_ACCESS_KEY_ID=..." --env="AWS_SECRET_ACCESS_KEY=..." -- bash
```

Inside:

```bash
export PGDATA=/tmp/pitr
mkdir -p "$PGDATA" && chmod 700 "$PGDATA"

# Fetch the base backup taken BEFORE the target time. LATEST is usually right;
# pick an explicit backup name from `wal-g backup-list` if the target predates it.
wal-g backup-fetch "$PGDATA" LATEST

# Tell postgres to replay archived WAL up to the target, then stop.
cat >> "$PGDATA/postgresql.conf" <<EOF
restore_command = 'wal-g wal-fetch %f %p'
recovery_target_time = '2026-07-07 15:42:00+00'   # ← target (UTC)
recovery_target_action = 'promote'
EOF
touch "$PGDATA/recovery.signal"

# Start postgres against the scratch dir on a spare port; it replays to target.
pg_ctl -D "$PGDATA" -o "-p 5433" -w start
# Verify you recovered the right state:
psql -p 5433 -U supabase_admin -d postgres -c "SELECT count(*) FROM public.submissions;"
pg_ctl -D "$PGDATA" stop
```

`recovery_target_lsn` or `recovery_target_name` work in place of
`recovery_target_time` if you have a more precise marker.

### 3. Promote it into production

Once you have confirmed the scratch restore holds the state you want, make it
the live database. The lowest-risk path is to treat the recovered data dir as a
**new primary**:

1. Take the app offline (scale writers to 0, as in failover).
2. Replace the primary's PVC contents with the recovered `$PGDATA` (restore into
   a fresh PVC and cut the StatefulSet over to it), **or** run the PITR
   `backup-fetch` + replay directly against the primary's data dir with the app
   stopped.
3. **Re-run migrations** so `migrate.sh` Phase 4 re-asserts the vault
   `supabase_project_url` / `edge-function-secret` for in-cluster edge callbacks
   (a restored/rebuilt DB otherwise leaves gradebook recalculation silently
   no-op — see [rollback.md](./rollback.md)).
4. Rebuild the standby (it re-bootstraps from the new primary).
5. Smoke test.

> A destructive in-place PITR discards every write **after** the target time —
> that is the point, but confirm the target with the scratch restore first.

---

## Automated PITR drill (`backup.pitrDrill`)

`backup-verify` and the dump `restoreDrill` (see [disaster-recovery.md](./disaster-recovery.md))
exercise the **logical dump** path — they never replay WAL, so neither proves
PITR. The `pitrDrill` CronJob is the only check that does: it fetches the newest
wal-g base backup into a **throwaway generic-ephemeral volume** (never the live
`PGDATA`), replays archived WAL to a target `targetLagMinutes` in the past,
promotes, asserts `assertTable` has ≥ `assertMinRows`, then tears down (the
ephemeral PVC dies with the pod).

Off by default. Enable in prod:

```yaml
backup:
  pitrDrill:
    enabled: true
    schedule: "0 9 * * 1" # weekly, after the dump restoreDrill (08:00)
    scratchSize: 60Gi # ≥ physical PGDATA size (all DBs + WAL)
    # Optional point-in-time precision assertion: a busy timestamptz column.
    # When set, asserts ZERO rows newer than the target (replay stopped AT it).
    # recencyTable: "public.audit"
    # recencyColumn: "created_at"
```

Run on demand:

```bash
kubectl -n "$NS" create job pitr-adhoc --from=cronjob/<release>-backup-pitr-drill
kubectl -n "$NS" logs -f job/pitr-adhoc   # want: "PITR DRILL PASSED"
```

**Safety:** the scratch cluster starts `archive_mode=off` with a no-op
`archive_command`, so it can never `wal-push` into the live `WALG_S3_PREFIX`; it
only `wal-fetch`es (reads). It binds `127.0.0.1:5433` and is torn down with its
volume.

**Why it reads params from the control file.** Hot-standby recovery requires
`max_connections` (and `max_worker_processes`, `max_wal_senders`,
`max_prepared_transactions`, `max_locks_per_transaction`) be **≥ the primary's
values at backup time**, else postgres FATALs with _"recovery aborted because of
insufficient parameter settings"_. The primary sets these via a mounted config
the drill doesn't use, so the drill reads the recorded values from
`pg_controldata "$PGDATA"` and writes them into `postgresql.auto.conf` — no
hardcoding, always matches the backup.

Validated on prod: recovers to the target commit, promotes to a new timeline,
asserts row count, cleans up — no orphan scratch DB or volume.

---

## Operational notes

- **Retention window ≈ `baseBackup.intervalHours × keepBackups`.** WAL older than
  the oldest retained base backup is pruned with it, so a PITR target must fall
  inside that window. Size `keepBackups` to the recovery window you need.
- **No physical replication slot for the standby.** The chart creates none, so
  the primary never retains WAL on the standby's behalf. A standby that lags past
  the WAL still in the primary's `pg_wal` falls back to `wal-g wal-fetch` from the
  archive (`postgres-replica.yaml` writes the `restore_command`). This is
  deliberate: with no slot, a dead or slow standby cannot pin WAL on the primary
  and fill its disk. Because there is no slot, standby health is tracked from the
  **primary side** via `pg_stat_replication`, not `pg_replication_slots` (which
  is empty here) — that is what the `PawtograderReplicaNotStreaming` /
  `PawtograderReplicaLagHigh` alerts read (see
  [monitoring-alerting.md](./monitoring-alerting.md)).
- **`archive_command` must keep succeeding** or WAL accumulates in `pg_wal` and
  can fill the primary's disk. Alert on it (add a rule alongside the backup
  alerts in [monitoring-alerting.md](./monitoring-alerting.md)); `wal-g wal-show`
  surfaces gaps.
- **Never point two primaries at one `WALG_S3_PREFIX`.** That is why failover is
  manual and step 1 insists the old primary is truly gone.
- **The nightly `pg_dump` (backup.yaml) stays on** as an independent scheme — a
  logical dump survives classes of WAL/base-backup corruption that PITR does not.

## Related

- [planned-maintenance.md](./planned-maintenance.md) — the _planned_ node/DB
  bounce (short full-downtime window, no promotion); when to promote instead.
- [disaster-recovery.md](./disaster-recovery.md) — the `pg_dump` scheme + restore.
- [rollback.md](./rollback.md) — app rollback; the migrations re-run note.
- [monitoring-alerting.md](./monitoring-alerting.md) — archiving/backup alerts.
- [incident-response.md](./incident-response.md) — when to reach for which.
