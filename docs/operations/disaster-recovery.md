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

     # Discover the write tiers by LABEL rather than naming them. A fixed list is
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
     # Realtime is enumerated BY NAME rather than scaled with `-l`, which is the
     # other silent hole this block used to have: `kubectl scale statefulset -l
     # <selector>` prints "No resources found" and exits 0 when the selector
     # matches nothing, so a realtime rename or a label change skipped the one
     # StatefulSet in the fence without failing anything.
     jp='{range .items[*]}{.metadata.labels.app\.kubernetes\.io/component}{" "}{.metadata.name}{"\n"}{end}'
     WRITE_DEPLOY="$(kubectl -n "$NS" get deploy -l "app.kubernetes.io/instance=<release>" -o jsonpath="$jp" \
       | awk '$1 ~ /^(web|rest|auth|storage|functions)(-.+)?$/ { print "deploy/" $2 }')"
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

     # Then WAIT, and wait LONG ENOUGH. `kubectl scale` only writes
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
       | awk '$1 ~ /^(web|rest|auth|storage|functions|realtime)(-.+)?$/ { print "pod/" $2 }')"
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
     echo "FENCED: every web/rest/auth/storage/edge/realtime pod is gone."
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
     local jp pods left
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
     left="$(printf '%s\n' "$pods" \
       | awk '$1 ~ /^(web|rest|auth|storage|functions|realtime)(-.+)?$/ { n++ } END { print n+0 }')"
     if [ "$left" -ne 0 ]; then
       echo "NOT FENCED: $left writer pod(s) still present -- refusing to continue." >&2
       return 1
     fi
     echo "fence verified: no writer pods present"
   }

   fenced && pg_restore --clean --if-exists --no-owner --no-acl \
     -d postgres /tmp/latest.dump
   ```

   Expect noisy `does not exist, skipping` notices on the first `--clean` pass;
   those are benign. A non-zero exit that is **not** just those notices is a
   real failure — stop and investigate before bringing traffic back.

3. **Bring writers back** by scaling the tiers to their prod replica counts
   (re-run `helm upgrade` with the prod values, or `kubectl scale` back up).
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
