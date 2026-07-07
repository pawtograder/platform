# Point-in-Time Recovery & Standby Failover

WAL-G continuous archiving gives Pawtograder **point-in-time recovery (PITR)** —
restore the database to any moment within the retention window, not just the
last nightly dump — plus a **streaming standby** to fail over to. This runbook
covers configuring it, recovering to a point in time, and promoting the standby.

It builds on and supersedes the RPO floor in
[disaster-recovery.md](./disaster-recovery.md) (the plain `pg_dump`), which stays
as an independent second scheme. Closes PRODUCTION-READINESS §1.1 (HA) and §1.2
(WAL/PITR) for environments that enable it.

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
means both halves work. Do a promotion drill in a scratch namespace before term.

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
     <release>-web <release>-rest <release>-edge-functions <release>-realtime \
     --replicas=0
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

> Failover is deliberately **manual** (no automatic leader election). That
> avoids the split-brain risk an unsupervised promoter carries against a shared
> WAL archive. If automatic failover becomes a requirement, the tracked path is
> Patroni/CloudNativePG (PRODUCTION-READINESS §1.1).

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

## Operational notes

- **Retention window ≈ `baseBackup.intervalHours × keepBackups`.** WAL older than
  the oldest retained base backup is pruned with it, so a PITR target must fall
  inside that window. Size `keepBackups` to the recovery window you need.
- **`archive_command` must keep succeeding** or WAL accumulates in `pg_wal` and
  can fill the primary's disk. Alert on it (add a rule alongside the backup
  alerts in [monitoring-alerting.md](./monitoring-alerting.md)); `wal-g wal-show`
  surfaces gaps.
- **Never point two primaries at one `WALG_S3_PREFIX`.** That is why failover is
  manual and step 1 insists the old primary is truly gone.
- **The nightly `pg_dump` (backup.yaml) stays on** as an independent scheme — a
  logical dump survives classes of WAL/base-backup corruption that PITR does not.

## Related

- [disaster-recovery.md](./disaster-recovery.md) — the `pg_dump` scheme + restore.
- [rollback.md](./rollback.md) — app rollback; the migrations re-run note.
- [monitoring-alerting.md](./monitoring-alerting.md) — archiving/backup alerts.
- [incident-response.md](./incident-response.md) — when to reach for which.
