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
  psql -U supabase_admin -c "SELECT application_name, state, sync_state,
    write_lag, replay_lag FROM pg_stat_replication;"

# 4. The standby is in recovery and caught up (run on the STANDBY):
kubectl -n "$NS" exec -it <release>-postgres-replica-0 -c postgres -- \
  psql -U supabase_admin -c "SELECT pg_is_in_recovery(),
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
   kubectl -n "$NS" scale deploy \
     <release>-web <release>-rest <release>-functions <release>-realtime \
     --replicas=0
   # When edgeFunctions.workerTier is enabled there is a SECOND edge Deployment,
   # and it is the one that drains pgmq — leaving it up means writes continue
   # through a window this step exists to close. It is absent on installs that
   # have the tier off, so ignore-not-found:
   kubectl -n "$NS" scale deploy <release>-functions-workers --replicas=0 \
     --ignore-not-found
   ```
3. **Promote the standby:**
   ```bash
   kubectl -n "$NS" exec -it <release>-postgres-replica-0 -c postgres -- \
     pg_ctl promote -D /var/lib/postgresql/data/pgdata
   # Confirm it left recovery (returns f):
   kubectl -n "$NS" exec -it <release>-postgres-replica-0 -c postgres -- \
     psql -U supabase_admin -tAc "SELECT pg_is_in_recovery();"
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
5. **Scale writers back up** (step 2 in reverse) and run the
   [smoke checklist](./production-install.md#smoke-test).
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
   # (b) Promote the standby. pg_ctl refuses to run as root, and `kubectl exec`
   #     enters as the image's root user, so drop to the postgres user.
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
