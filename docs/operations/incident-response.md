# Incident Response

A starting on-call runbook for production Pawtograder: severity definitions,
first-response steps, and per-component triage. It ties together the specific
runbooks ([disaster-recovery](./disaster-recovery.md),
[rollback](./rollback.md), [secrets-rotation](./secrets-rotation.md),
[monitoring-alerting](./monitoring-alerting.md)) with a common entry point.

This assumes a Rancher-managed cluster. `NS` is the release namespace, `<release>`
the Helm release name.

---

## Severity

| Sev      | Definition                         | Examples                                                                                    | Response                                                      |
| -------- | ---------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **SEV1** | Platform down or data at risk      | App unreachable, Postgres down, backups failing near a deadline, suspected data loss/breach | Page immediately; all-hands; status update to stakeholders    |
| **SEV2** | Major feature broken, no data risk | Grading/autograder stalled, realtime dead, LTI/roster sync failing, one tier crash-looping  | Page during hours / next-business-day off-hours; single owner |
| **SEV3** | Degraded or cosmetic               | Elevated latency, a dashboard/alert gap, single non-critical integration down               | Ticket; batch with normal work                                |

Map `severity: critical` alerts ([monitoring-alerting.md](./monitoring-alerting.md))
to SEV1/2 paging and `severity: warning` to a chat channel, in Alertmanager.

## Timing matters

Pawtograder's load is **deadline-driven**, not steady-state: the risk window is
the minutes around an assignment due time (submission spike, autograder queue,
gradebook recalculation). An incident during a deadline is more severe than the
same incident at 3am. Know the course deadlines when triaging.

---

## First response (any incident)

1. **Confirm scope.** Is the whole app down or one feature? Check
   `https://<hostname>` and run the [smoke checklist](./production-install.md#smoke-test).
2. **Look at the pods.** `kubectl -n "$NS" get pods` (or the Rancher Workloads
   view). Note anything not `Running`/`Ready`, `CrashLoopBackOff`, or `OOMKilled`.
3. **Recent change?** Almost every incident follows a deploy. Check what
   changed:
   ```bash
   helm -n "$NS" history <release>
   ```
   If the incident started right after a release and the fix isn't obvious,
   **[roll back](./rollback.md)** first, diagnose after. Rollback is the fastest
   mitigation for a bad release.
4. **Data safe?** If Postgres is involved or data looks wrong, confirm the last
   backup is good **before** any destructive action — see
   [disaster-recovery.md](./disaster-recovery.md). Never `--clean` restore or
   drop anything without a verified backup in hand.
5. **Communicate.** Post the sev, the blast radius, and what you're doing. Update
   on a cadence until resolved.

---

## Per-component triage

Reading logs depends on the workload backing the component:

- **Deployments** (web, auth, storage, functions, realtime, Kong, …):
  `kubectl -n "$NS" logs deploy/<release>-<component>` (add `--previous` for a
  crash-looped pod). The edge-functions tier's Deployment is `<release>-functions`
  (chart component `functions`), not `<release>-edge-functions`.
- **StatefulSet** (Postgres): `kubectl -n "$NS" logs <release>-postgres-0`
  (append `-c <container>` for a sidecar, e.g. `base-backup` or
  `postgres-exporter`).
- **Jobs / CronJobs** (backup, backup-verify, restore-drill, migrations):
  `kubectl -n "$NS" logs job/<job-name>`; list them with
  `kubectl -n "$NS" get jobs`.

Components:

### Web (`<release>-web`)

- Symptom: sign-in page won't load, 5xx, or blank app.
- Check: pod Ready + logs; is it a bad image? (`helm history` → [rollback](./rollback.md)).
- CSP / mixed-content errors in the browser console point at a build/env
  mismatch, not a pod crash.

### Postgres (`<release>-postgres-0`)

- Symptom: everything 5xx at once (every tier depends on it).
- Check: pod status, PVC bound, disk not full (`df` via `kubectl exec`),
  connection count near `max_connections`.
- **Never** delete the PVC or the pod's data. If a healthy standby exists,
  follow [point-in-time-recovery.md](./point-in-time-recovery.md) to promote it
  manually; if you need a point-in-time restore or only the dump is usable, go to
  [disaster-recovery.md](./disaster-recovery.md). Automatic failover is still
  deferred, so promotion is an operator decision.

#### Postgres /dev/shm exhaustion (SQLSTATE 53100)

- **Symptom:** scattered 503s from PostgREST, often `GET /submissions`, while
  every database-side alert stays green. The rest pod logs show
  `could not resize shared memory segment "/PostgreSQL.NNN" to N bytes: No space left on device`,
  followed by `Connection Pool initialized`. PostgREST treats the error as fatal
  and rebuilds its whole pool, which 503s everything in flight on that pod. The
  database itself logs nothing.
- **Not every 53100 is this.** SQLSTATE 53100 is `disk_full` in general. The
  "could not resize shared memory segment" message is what points at
  `/dev/shm`. Without it, check the data volume (`df` on
  `/var/lib/postgresql/data`) first; the workaround below does nothing for a
  full PVC.
- **Cause:** until chart 0.4.0 the primary runs on the container default 64Mi
  `/dev/shm`. Parallel queries put their dynamic shared memory segments there.
- **Check:**
  ```bash
  kubectl -n $NS exec <release>-postgres-0 -c postgres -- df -h /dev/shm
  # Every rest replica: `logs deploy/...` reads only one pod, and the errors
  # are scattered across them.
  kubectl -n $NS logs -l app.kubernetes.io/instance=<release>,app.kubernetes.io/component=rest \
    --since=1h --prefix --max-log-requests=10 | grep 'could not resize shared memory segment' | cut -d' ' -f1 | sort | uniq -c
  ```
- **Permanent fix:** chart 0.4.0 (`postgres.shm.sizeLimit`, 1Gi) plus shm
  occupancy alerts. It restarts the primary, so it needs a
  [maintenance window](./planned-maintenance.md#chart-versions-and-postgres-restarts).
- **Online workaround (no restart):** stop the planner from choosing parallel
  plans. `postgres` is not a superuser on this image, so use `supabase_admin`:
  ```bash
  kubectl -n $NS exec <release>-postgres-0 -c postgres -- \
    psql -U supabase_admin -d postgres \
      -c "ALTER SYSTEM SET max_parallel_workers_per_gather = 0;" \
      -c "ALTER SYSTEM SET max_parallel_maintenance_workers = 0;" \
      -c "SELECT pg_reload_conf();"
  ```
  It has to be set server-wide. `/dev/shm` is shared by every backend, so
  scoping it to the `authenticator` role would not protect PostgREST from other
  clients.
- **What to expect after the workaround:** new connections stop allocating
  segments, and the 53100 errors stop. `/dev/shm` does not drain right away:
  PostgREST connections opened before the change keep about 3MB of segments
  each for as long as they live. On 2026-09-23 they aged out over about 25
  minutes, followed by a `pgrst` schema-reload NOTIFY that rebuilt the pools.
  `/dev/shm` went from 97% to 2%, with no 503s. If it has to drain faster,
  `kubectl -n $NS rollout restart deploy/<release>-rest` rolls the pools without
  touching Postgres.
- **Confirming who holds the segments:** don't read file mtimes in `/dev/shm`.
  They change on writes, not only on creation. Map each segment to its owners
  instead:
  ```bash
  kubectl -n $NS exec <release>-postgres-0 -c postgres -- sh -c \
    'for p in /proc/[0-9]*; do n=$(grep -c /dev/shm/PostgreSQL $p/maps 2>/dev/null); [ "${n:-0}" -gt 2 ] && echo ${p#/proc/}; done'
  ```
  Then look those pids up in `pg_stat_activity`. Two segments are global and
  mapped by every process. Anything a single backend holds on top of those is
  per-connection.
- **Afterwards:** `ALTER SYSTEM` writes `postgresql.auto.conf`, which overrides
  the chart's `postgresql.conf` and does not show up in any values file. Record
  it as a **comment** in the environment's values file. Do **not** add the
  settings under `postgres.config`: that changes `postgres-config.yaml`, which
  is hashed into the StatefulSet's `checksum/config`, so the next routine
  `helm upgrade` would restart the primary. That is the outage the workaround
  exists to avoid, and a production values file sits outside the CI gate's
  checks. Move them into `postgres.config` only as part of a planned
  restart, such as the 0.4.0 window. After the 0.4.0 deploy, either keep them
  on purpose or undo them:
  `ALTER SYSTEM RESET max_parallel_workers_per_gather; ALTER SYSTEM RESET max_parallel_maintenance_workers; SELECT pg_reload_conf();`

### PostgREST / Realtime / Storage / Auth (`<release>-rest|realtime|storage|auth`)

- Symptom: data reads fail (rest), live updates dead (realtime), files 404
  (storage), can't log in (auth).
- Check: logs for DB connection errors (→ Postgres or a rotated password, see
  [secrets-rotation.md](./secrets-rotation.md)) vs. app errors.
- A wedged-but-listening service should self-heal via its liveness probe (§2.4);
  if not, `rollout restart`.

### Edge Functions (`<release>-functions`)

- Symptom: GitHub webhooks not processing, autograder not enqueuing, notifications
  silent, gradebook cells not recalculating.
- Check: HPA scaled up? (deadline load) logs for the failing function.
- **Gradebook not recalculating** specifically: the vault edge-callback wiring
  may be wrong — the migrations job's Phase 4 sets `supabase_project_url` /
  `edge-function-secret` to the in-cluster Kong host. Re-run migrations if a
  restore or fresh DB skipped it (see [rollback.md](./rollback.md) / DR notes).

### Kong (`<release>-kong`)

- Symptom: everything behind the gateway 5xx even though upstreams are healthy.
- Check: Kong pod + config; the smoke test's `/auth/v1/health` through Kong is a
  quick gateway probe.

### Backups (`<release>-backup*`)

- Symptom: `PawtograderBackupJobFailed` / `PawtograderBackupMissing`.
- Go straight to [disaster-recovery.md](./disaster-recovery.md) — "When
  backup-verify goes red" triages by log line.

### Secrets / ESO

- Symptom: `PawtograderExternalSecretNotReady`, or a pod crash-looping on a
  missing/stale secret after a restart.
- Go to [secrets-rotation.md](./secrets-rotation.md); check the ExternalSecret
  status and the OpenBao path/role.

---

## After the incident

- **Restore any temporary changes.** Scaled a tier to zero for a restore? Bumped
  a limit? Put it back and reconcile the values file so the cluster matches
  committed state.
- **Write it up.** What happened, blast radius, root cause, timeline, and the
  follow-ups. Deadline-driven load means the same failure will recur at the next
  deadline if the cause isn't fixed.
- **Feed it back.** If a runbook was wrong or missing a step, fix the runbook. If
  a failure mode had no alert, add one (see
  [monitoring-alerting.md](./monitoring-alerting.md) "Suggested additions").
