# Disaster Recovery (backup & restore)

How Pawtograder's Postgres backups are produced, how to restore one, and what
to do when the automated verification goes red. This is the restore procedure
the `values-prod.yaml` operator checklist tells you to rehearse before term
start.

Scope: the nightly **`pg_dump` scheme** for the Postgres deployed by
`charts/pawtograder` (`postgres-statefulset.yaml`). This logical dump runs
independently and is always on — the coarse-grained fallback that survives
classes of corruption WAL replay does not. When WAL-G continuous archiving + a
streaming standby are enabled (`postgres.walg` / `postgres.replica`), those are
the **primary** recovery paths (seconds-level RPO, warm failover) — see
[point-in-time-recovery.md](./point-in-time-recovery.md); this dump is then the
second, independent scheme. Everything below assumes cluster access through the
prod Rancher project (a downloaded kubeconfig, or the Rancher UI's shell where
noted).

**Which recovery path?**

- Primary lost and a standby is running → **promote the standby** (fastest); see
  [point-in-time-recovery.md](./point-in-time-recovery.md).
- Recover to a point in time (bad migration, mass delete) with WAL-G enabled →
  **PITR restore**; see [point-in-time-recovery.md](./point-in-time-recovery.md).
- No WAL-G/standby, or the nightly dump is the only good artifact → **this doc**.

---

## What a backup is

The `backup` CronJob (`charts/pawtograder/templates/backup.yaml`, default
`0 4 * * *` UTC) runs inside the `supabase/postgres` image and:

1. `pg_dump -Fc` (custom format: compressed, and offline-verifiable via
   `pg_restore --list`) to `/tmp/pawtograder-<TS>.dump`, where `<TS>` is
   `YYYYMMDDTHHMMSSZ`.
2. Parses the archive TOC (`pg_restore --list`) **before** upload, so a
   truncated dump fails at backup time, not on restore day.
3. Uploads to `s3://<backup.s3.bucket>/pawtograder-<TS>.dump` via `mc`, then
   re-`stat`s the object and fails on any size mismatch.
4. Ensures a bucket ILM expiry rule exists (`backup.retentionDays`, default 14).

Object naming is timestamped so lexical sort equals chronological sort; the
newest object is always `... | sort | tail -1`.

| Fact                           | Value / source                                                              |
| ------------------------------ | --------------------------------------------------------------------------- |
| Backup objects                 | `s3://<bucket>/pawtograder-*.dump` (custom format)                          |
| Bucket / endpoint              | `backup.s3.bucket` / `backup.s3.endpoint` in the prod values                |
| S3 credentials                 | Secret `pawtograder-s3`, keys `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` |
| Postgres StatefulSet + Service | `<release>-postgres`; pod `<release>-postgres-0`                            |
| DB name                        | `postgres` (`postgres.database`)                                            |
| Superuser for restore          | `supabase_admin` (see below)                                                |
| DB password                    | Secret `pawtograder-postgres`, key `POSTGRES_PASSWORD`                      |
| Retention                      | `backup.retentionDays` days, enforced by an S3 ILM rule                     |

> Use `supabase_admin`, not `postgres`, for restore. The chart demotes the
> `postgres` role, and the schema owns objects created by the superuser
> (pgsodium extension, vault). Restoring as `supabase_admin` avoids ownership
> and `CREATE EXTENSION` permission errors. `--no-owner --no-acl` further
> decouples the dump from role-name specifics.
>
> The nightly dump runs as the demoted `postgres` role (`backup.yaml`), which
> does not own the pgsodium/vault objects the superuser created, so those sit
> outside the dump role's ownership. Restores use `supabase_admin` to put them
> back, and the weekly restore-drill CronJob (`backup-restore-drill.yaml`)
> restores as `supabase_admin` for the same reason, exercising that path before
> you need it.

## Recovery objectives (what "recovered" means here)

- **RPO (data loss ceiling):** up to one backup interval for _this_ scheme —
  with the default daily schedule, worst case ~24 h of writes since the last
  successful dump. (With WAL-G enabled the deployment's RPO is seconds; this
  dump's coarser RPO is the fallback, not the ceiling for the deployment.)
- **RTO (time to restore):** dominated by dump size and the drop/recreate of
  the schema. For a small-to-mid course DB, budget 15–45 min end to end once
  you have the object in hand; larger DBs scale roughly with `pg_restore`
  throughput. Rehearse before term starts so the number is known, not guessed.

---

## Restore procedure

There are two shapes: **restore in place** (production is down or corrupt, you
are accepting the RPO data loss) and **restore into a scratch DB** (validate a
backup, or extract specific rows without touching production). Do the scratch
restore first whenever the situation allows it — it is non-destructive and
tells you the backup is good before you drop anything.

### 0. Get the object

Run a throwaway pod in the release namespace so `mc` and `pg_restore` are on
the same network as Postgres and the S3 endpoint:

```bash
# NS = the release namespace (e.g. pawtograder-prod)
kubectl -n "$NS" run dr-shell --rm -it --restart=Never \
  --image=supabase/postgres:17.4.1.075 -- bash
```

Inside that pod, install the SHA-pinned `mc` (same source the CronJobs use —
copy `backup.mc.url` / `backup.mc.sha256` from the prod values) and pull the
newest dump:

```bash
curl -fsSL "$MC_URL" -o /usr/local/bin/mc
echo "$MC_SHA256  /usr/local/bin/mc" | sha256sum -c -
chmod +x /usr/local/bin/mc

mc alias set s3 "$S3_ENDPOINT" "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY"
LATEST=$(mc ls "s3/$S3_BUCKET/" | awk '{print $NF}' \
  | grep '^pawtograder-.*\.dump$' | sort | tail -1)
echo "restoring from: $LATEST"
mc cp "s3/$S3_BUCKET/$LATEST" /tmp/latest.dump
pg_restore --list /tmp/latest.dump >/dev/null   # sanity: TOC parses (preserves exit status)
```

Set `S3_ENDPOINT`, `S3_BUCKET`, and the AWS keys from the `pawtograder-s3`
secret and prod values before running. To restore an **older** object (e.g. the
newest is the one that got corrupted), list all and pick by timestamp instead
of `tail -1`.

### A. Restore into a scratch database (non-destructive)

Validates the dump end to end and lets you diff against production.

```bash
export PGHOST=<release>-postgres PGPORT=5432 PGUSER=supabase_admin
export PGPASSWORD=<from pawtograder-postgres/POSTGRES_PASSWORD>

psql -d postgres -c "CREATE DATABASE dr_scratch;"
pg_restore --no-owner --no-acl -d dr_scratch /tmp/latest.dump

# Spot-check row counts against live before trusting the backup:
psql -d dr_scratch -c "SELECT count(*) FROM public.submissions;"
psql -d postgres   -c "SELECT count(*) FROM public.submissions;"

# Clean up when done:
psql -d postgres -c "DROP DATABASE dr_scratch;"
```

### B. Restore in place (destructive: production data loss)

Only after confirming (via A, or the `--list` check) that the object is good,
and after you have accepted the RPO gap. **Take the app offline first** so
nothing writes during the restore and no half-restored state is served.

1. **Stop writers.** Scale the write tiers to zero so PostgREST/edge/realtime
   stop issuing writes:

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
     #    Deployments does NOT fence them -- and `pg_restore --clean` drops and
     #    recreates every object from the dump while they keep committing into
     #    the same database, with nothing downstream to tell you which rows lost.
     #    This step did not exist here until 2026-09-03. planned-maintenance.md
     #    has had it since the write-fence audit, and its comment is the one that
     #    matters here too: a fence that silently skipped its in-database writers
     #    is the WORST version of this failure, because the app pods are all gone
     #    and so everything looks quiet. Executed against a namespace with the
     #    pods gone and 3 cron jobs active, this procedure's gate printed
     #    "fence verified: no writer pods present" and ran `pg_restore --clean --if-exists`.
     #
     #    Record the active jobids first: step 3 resumes exactly those, and an
     #    `UPDATE cron.job SET active=true` with no WHERE would also enable jobs
     #    that were disabled on purpose.
     #
     #    Then VERIFY, because this psql can fail in ways that leave the jobs
     #    running (wrong pod name after a rename, RBAC on exec, a primary that is
     #    not `-0`). The count is read WITHOUT a `| tr` pipeline: `set -o
     #    pipefail` is in force here so a pipeline would in fact abort, but the
     #    same line copied into `fenced()` below -- where it is not -- is how the
     #    swallowed-exit-status bug got in, so both forms are written the same way.
     kubectl -n "$NS" exec <release>-postgres-0 -c postgres -- psql -U supabase_admin \
       -d postgres -tAc "SELECT string_agg(jobid::text,',') FROM cron.job WHERE active;"
     kubectl -n "$NS" exec <release>-postgres-0 -c postgres -- psql -U supabase_admin \
       -d postgres -c "UPDATE cron.job SET active=false WHERE active;"
     still_active="$(kubectl -n "$NS" exec <release>-postgres-0 -c postgres -- psql -U supabase_admin \
       -d postgres -tAc "SELECT count(*) FROM cron.job WHERE active;")"
     still_active="${still_active//[[:space:]]/}"
     if [ "$still_active" != "0" ]; then
       echo "STOP: $still_active pg_cron job(s) are still active -- in-database writers are NOT fenced." >&2
       exit 1
     fi

     # 1. Record what to restore, and record it BEFORE anything is mutated:
     #    writer Deployments + the realtime StatefulSet (kind, name, component
     #    and desired replicas -- a `-o wide` snapshot is not machine-readable,
     #    and the component column is what lets the restore loop re-check this
     #    file against the same allowlist) and the
     #    edge-functions HPA. Step 3 said "scaling the tiers to their prod
     #    replica counts" and had nothing to work from: this block captured no
     #    replica counts and no HPA at all.
     #
     #    FILTER THE CAPTURE THROUGH THE SAME ALLOWLIST THE FENCE USES. It was
     #    `get deploy,statefulset -l instance=<release>` with no component
     #    filter, which is release-wide -- so it recorded `postgres`,
     #    `postgres-replica`, `kong`, `supavisor`, `maintenance`, `imgproxy`,
     #    `smtp-relay` and `redis` too, and the restore step then set every one
     #    of them to its fence-time replica count. Three lines of comment above
     #    claimed it recorded "writer Deployments + the realtime StatefulSet";
     #    the code did something else. Postgres deliberately STAYS UP through a
     #    restore-in-place, so re-setting it to 1 is a no-op here -- but the
     #    identical capture on the promote path in point-in-time-recovery.md
     #    restarted the abandoned old primary onto a dead timeline.
     #    Recording only what the fence scales makes the restore structurally
     #    incapable of touching anything else.
     #
     #    `-l app.kubernetes.io/instance=<release>` still scopes it to THIS
     #    release, so an unrelated workload sharing the namespace is neither
     #    recorded nor "restored".
     #
     #    `mktemp -d`, not `/tmp/dr-fence-$(date +%s)`: two runs started in the
     #    same second shared one directory, and the restore step's `ls -dt |
     #    head -1` could then hand you an EARLIER run's state. The META file is
     #    how the restore step proves it is reading the right run's directory
     #    rather than trusting mtime.
     STATE_DIR="$(mktemp -d "/tmp/dr-fence-XXXXXXXX")"
     {
       echo "procedure: disaster-recovery (restore in place)"
       echo "release: <release>"
       echo "namespace: $NS"
       echo "started: $(date -Is)"
       echo "operator: ${USER:-unknown}@$(hostname)"
     } > "$STATE_DIR/META"
     jpr='{range .items[*]}{.kind}{"\t"}{.metadata.name}{"\t"}{.metadata.labels.app\.kubernetes\.io/component}{"\t"}{.spec.replicas}{"\n"}{end}'
     # NOTE the redirect stays on the awk line. A continuation line that STARTS
     # with `>` is a shell redirect to markdown and a blockquote marker to
     # anything that strips prefixes -- including this repo's own block-extraction
     # harness, which ate it and silently verified a pipeline with no output file.
     kubectl -n "$NS" get deploy,statefulset -l "app.kubernetes.io/instance=<release>" -o jsonpath="$jpr" \
       | awk -F'\t' -v OFS='\t' '$3 ~ /^(web|rest|auth|storage|functions|realtime|meta|studio)(-.+)?$/ { print $1, $2, $3, $4 }' > "$STATE_DIR/replicas.txt"
     # awk exits 0 on no matches, so the empty case needs its own guard -- the
     # same "matched nothing" shape as the fence's NOTHING MATCHED below.
     if [ ! -s "$STATE_DIR/replicas.txt" ]; then
       echo "STOP: recorded ZERO writer workloads -- wrong release name or namespace. Nothing to restore later; do not proceed." >&2
       exit 1
     fi
     kubectl -n "$NS" get hpa -l "app.kubernetes.io/instance=<release>" -o yaml > "$STATE_DIR/hpa.yaml"
     printf '\n>>> STATE_DIR=%s <<<  step 3 needs this EXACT path. Write it down.\n\n' "$STATE_DIR"

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

   Leave Postgres running. (Rancher UI: set each workload's scale to 0 from the
   Workloads view if you prefer.)

2. **Restore over the live DB.** `--clean --if-exists` drops and recreates each
   object from the dump:

   ```bash
   # HARD GATE, and it is chained with `&&` on purpose: the destructive command
   # below CANNOT run unless the assertion exits 0. A `pg_restore --clean` over a database that a
   # worker is still writing to interleaves the restore with live commits, and
   # nothing downstream will tell you which rows lost.
   #
   # This is deliberately a re-check rather than trust in the previous step. The
   # gap between the two steps is however long the operator takes, and a
   # `helm upgrade`, an HPA, or a controller reconcile can put pods back in it.
   fenced() {
     local jp pods seen pg left active_jobs running_jobs crons
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
     # pg_cron is checked HERE and not only in step 1, and until 2026-09-03 it was
     # checked in neither. ~20 scheduled jobs commit in-DB every minute with no
     # pod to scale, so the writer-pod count above cannot see them: with the app
     # pods gone and the cron jobs running, this gate printed `fence verified: no
     # writer pods present` and ran `pg_restore --clean`, which drops and recreates every
     # object from the dump while the cron jobs commit into the same database. That is the worst shape of the failure --
     # everything LOOKS quiet precisely because the visible writers are the ones
     # that stopped.
     #
     # Take the exec's EXIT STATUS, and no pipeline, for the reason `get pod`
     # above does: `crons="$(kubectl exec ... | tr -d '[:space:]')"` reports only
     # `tr`'s status, and there is no `set -o pipefail` in a function pasted into
     # an interactive shell, so an exec that printed a count and then failed
     # (SPDY reset, API-server timeout) would leave `crons="0"` and pass.
     if ! crons="$(kubectl -n "$NS" exec <release>-postgres-0 -c postgres -- psql -U supabase_admin \
       -d postgres -tAc "SELECT count(*) FROM cron.job WHERE active;")"; then
       echo "NOT FENCED: could not read cron.job (the exec failed) -- refusing to continue." >&2
       return 1
     fi
     crons="${crons//[[:space:]]/}"
     if [ "$crons" != "0" ]; then
       echo "NOT FENCED: $crons pg_cron job(s) active -- in-database writers are NOT fenced. Refusing to continue." >&2
       return 1
     fi
     echo "fence verified: postgres present, no writer pods, no active write Jobs, no active pg_cron jobs"
   }

   fenced && pg_restore --clean --if-exists --no-owner --no-acl \
     -d postgres /tmp/latest.dump
   ```

   Expect noisy `does not exist, skipping` notices on the first `--clean` pass;
   those are benign. A non-zero exit that is **not** just those notices is a
   real failure — stop and investigate before bringing traffic back.

3. **Bring writers back — reverse step 1, from what step 1 recorded.** Resume
   pg_cron, restore each tier to its recorded replica count, unsuspend the
   CronJobs, and reconcile the release to recreate the HPA:

   ```bash
   # PASS THE PATH IN -- do not rediscover it. Step 1 printed
   # `>>> STATE_DIR=... <<<`; export it or paste it here. `$STATE_DIR` does not
   # survive step 1, which assigned it inside a `( set -euo pipefail )`
   # subshell.
   #
   # This was `STATE_DIR="$(ls -dt /tmp/dr-fence-* | head -1)"`, and before that
   # `done < /tmp/dr-fence-replicas-*.txt` -- a glob in a redirect, which on a
   # second run refused with `ambiguous redirect` and restored NOTHING. `ls -dt`
   # fixed that and left a subtler one: the directory name was
   # `$(date +%s)`-suffixed, so two runs started in the SAME SECOND shared one
   # directory, and mtime ordering can hand you an earlier run's state either
   # way. `mktemp -d` makes the collision impossible; requiring the path makes
   # choosing the wrong directory impossible; the META check below makes acting
   # on someone else's run impossible.
   : "${STATE_DIR:?set STATE_DIR to the exact path step 1 printed}"
   [ -s "$STATE_DIR/replicas.txt" ] || { echo "no recorded writer state in $STATE_DIR -- do NOT guess replica counts" >&2; exit 1; }
   cat "$STATE_DIR/META"        # confirm procedure/release/namespace/time before acting
   grep -qx "namespace: $NS" "$STATE_DIR/META" || { echo "STOP: $STATE_DIR was recorded for a DIFFERENT namespace" >&2; exit 1; }
   grep -qx "release: <release>" "$STATE_DIR/META" || { echo "STOP: $STATE_DIR was recorded for a DIFFERENT release" >&2; exit 1; }

   # 1. Resume pg_cron for exactly the jobids step 1 printed. `WHERE active`
   #    with no id list would also enable jobs that were disabled on purpose.
   kubectl -n "$NS" exec <release>-postgres-0 -c postgres -- psql -U supabase_admin \
     -d postgres -c "UPDATE cron.job SET active=true WHERE jobid = ANY(ARRAY[<recorded-jobids>]::bigint[]);"

   # 2. Restore each writer to its RECORDED replica count, by the recorded kind
   #    so the realtime StatefulSet comes back too. Read it from the file; do not
   #    hardcode.
     # VALIDATE THE WHOLE FILE BEFORE SCALING ANYTHING, against the SAME allowlist
   # the capture uses. The capture filters, so a file this runbook wrote cannot
   # contain a non-writer -- but one hand-edited, copied from an older run, or
   # written before the capture was filtered can, and this loop is the
   # destructive end. Executed against a file carrying
   # `StatefulSet pawtograder-postgres postgres 1`, the unguarded loop scaled
   # Postgres back to 1. A PRE-PASS rather than a check inside the loop, so a
   # bad row cannot be reached after some rows have already been scaled.
   bad="$(awk -F'\t' '$3 !~ /^(web|rest|auth|storage|functions|realtime|meta|studio)(-.+)?$/ { print $1 "/" $2 " (component=" $3 ")" }' "$STATE_DIR/replicas.txt")"
   if [ -n "$bad" ]; then
     echo "STOP: $STATE_DIR/replicas.txt lists non-writer workloads. Scaling NOTHING:" >&2
     echo "$bad" | sed 's/^/  /' >&2
     echo "  Restoring Postgres from a state file is how the promote path restarted an" >&2
     echo "  abandoned primary onto a dead timeline. Fix the file; do not run past this." >&2
     exit 1
   fi
   # `component` is read only to consume the third field; the pre-pass above
   # is what validates it. Named rather than `_` so the file format stays
   # legible to whoever reads this next.
   # shellcheck disable=SC2034  # positional field, checked in the pre-pass
   while IFS=$'\t' read -r kind name component replicas; do
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

4. **Smoke test** before announcing recovery: run
   `helm test <release> -n "$NS"`, then sign in, open a course, load the
   gradebook, and confirm a recent submission renders. See
   [production-install.md](./production-install.md) for the full checklist.

> The application's edge callbacks (`SUPABASE_PROJECT_URL`, vault
> `edge-function-secret`) are set by the migrations job, not by the dump. A
> restore of the `postgres` database preserves them. If you restored into a
> brand-new DB or a different cluster, re-run migrations so Phase 4 rewrites the
> vault URL to the in-cluster Kong host (otherwise gradebook recalculation and
> other DB-driven edge calls silently no-op).

---

## When `backup-verify` goes red

The `backup-verify` CronJob (`backup-verify.yaml`, weekly by default) downloads
the newest object and fails loudly on three conditions. Triage by the log line:

| Log line                                  | Meaning                          | Action                                                                                                                                                                                                            |
| ----------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `no pawtograder-*.dump objects in s3/...` | Backups are not landing at all   | Check the `backup` CronJob: `kubectl -n "$NS" get cronjob,job -l app.kubernetes.io/component=backup`; read the newest backup job's logs. Common causes: bad S3 creds, wrong `backup.s3.endpoint`, bucket missing. |
| `suspiciously small TOC (<10 entries)`    | Newest dump is empty/corrupt     | The dump ran against an empty or wrong DB, or was truncated. Restore from an **older** object (procedure A, pick by timestamp) and fix the backup source before relying on new dumps.                             |
| `newest backup is older than 48h`         | Backups stopped producing output | The CronJob isn't running or its jobs are failing. Check for suspended CronJob, failed jobs, or the ARC/`dind` runner-style infra issues that stall scheduled work.                                               |

`backup-verify` is a **structural** check (TOC parse + freshness); it does not
prove the data restores. **When enabled** (`backup.restoreDrill.enabled`, off by
default), the weekly `restoreDrill` CronJob does the real rehearsal
automatically (full restore into a scratch DB, asserts `assertTable` has ≥
`assertMinRows`). In a default install it is **not** running, so recoverability
is not being continuously tested — enable it in prod, and either way run
procedure A by hand before each term.

## Restore-drill: expected errors and the FK-integrity caveat

The `restoreDrill` judges recoverability by the **row-count assertion**, not by
`pg_restore`'s exit code, because a logical restore into a _renamed_ scratch DB
always emits some benign errors. Two classes are expected and ignored:

- **pg_cron** — the extension can only be created in the DB named by
  `cron.database_name` (`postgres`), so restoring into `restore_drill_*` errors
  on `CREATE EXTENSION pg_cron` and its `cron.*` COPYs. Always benign.
- **FK violations on constraint re-add** — if production holds rows that violate
  a constraint that is nonetheless marked `VALID`, re-adding it during a clean
  rebuild re-validates and fails. This is the signature of data loaded with
  triggers bypassed (`session_replication_role = replica`, as a `pg_restore` or
  logical-replication import does) — the orphan rows were inserted, or their
  parents deleted, without the FK trigger firing, yet the constraint stayed
  `convalidated=t`. **This is a real production data-integrity signal, not a
  drill bug** — but note the drill does **not** fail on it: because success is
  gated on the row-count assertion (above), an FK error is logged while the Job
  still succeeds, so `PawtograderBackupVerifyJobFailed` does **not** fire. Treat
  FK errors as a **manual log-review signal** — scan the drill's logs
  (`kubectl -n "$NS" logs job/<restore-drill-job>`) for `violates foreign key
constraint`; the alert will not surface them. Clean the orphans at the source
  per the FK's own `ON DELETE` semantics, then the next dump restores clean:

  ```sql
  -- find them (VALID constraint + violating rows):
  SELECT conname, convalidated FROM pg_constraint WHERE conname = '<fkey>';
  -- fix per ON DELETE: CASCADE -> DELETE the orphans; SET NULL -> NULL the column.
  ```

  Two such orphans were found and cleaned in July 2026
  (`auth.mfa_amr_claims.session_id`, ON DELETE CASCADE → deleted;
  `public.assignment_leaderboard.submission_id`, ON DELETE SET NULL → nulled),
  from the initial trigger-bypassed load into this instance.

Two safety properties of the drill: it sets `session_replication_role = replica`
on the scratch DB **before** restoring, so no app triggers (audit, notifications,
`pg_net` webhooks) fire against live infrastructure; and it drops the scratch DB
`WITH (FORCE)`, so a run killed mid-restore never orphans a full-size copy on the
primary's PVC (a prior no-FORCE run left a 27 GB orphan until the next reap).

## Alerting

The failure signal is a failed Kubernetes Job. Prod must alert on it. The chart
ships `PawtograderBackupJobFailed` and `PawtograderBackupMissing` for the nightly
dump Job, and `PawtograderBackupVerifyJobFailed` for the verify/restore-drill
Jobs. Their exact selectors distinguish the dump Job from the verify/drill
siblings, so a slow drill never masks a stale real backup; see
[monitoring-alerting.md](./monitoring-alerting.md) for the expressions. Without
that alert a silently broken backup looks identical to a healthy one until you
need it.

## Known gaps (tracked)

- **This dump scheme has no PITR** (RPO is one backup interval). For sub-day RPO,
  enable WAL-G continuous archiving + a streaming standby — see
  [point-in-time-recovery.md](./point-in-time-recovery.md). The `pg_dump` scheme
  here stays on as an independent second scheme even when PITR is enabled.
- **`mc` downloaded at runtime.** Backup, verify, and this runbook all fetch a
  SHA-pinned `mc`. Baking it into the image is tracked (PRODUCTION-READINESS
  §1.7). The pin means a tampered download is rejected, not that the download
  is removed.
- **Single-primary storage (no standby).** With no standby running, a
  node/volume loss means the StatefulSet's PVC must come from a **replicated**
  storage class in prod (not `local-path`), or this restore is your only
  recourse. A running standby (`postgres.replica`) plus a replicated class
  removes that single point of failure — promote instead of restore.
