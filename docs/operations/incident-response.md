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

- **Deployments** (web, auth, storage, edge-functions, realtime, Kong, …):
  `kubectl -n "$NS" logs deploy/<release>-<component>` (add `--previous` for a
  crash-looped pod).
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
- **Never** delete the PVC or the pod's data. On corruption/loss go to
  [disaster-recovery.md](./disaster-recovery.md). Single-primary has no failover
  (§1.1) — recovery is restore, not promote.

### PostgREST / Realtime / Storage / Auth (`<release>-rest|realtime|storage|auth`)

- Symptom: data reads fail (rest), live updates dead (realtime), files 404
  (storage), can't log in (auth).
- Check: logs for DB connection errors (→ Postgres or a rotated password, see
  [secrets-rotation.md](./secrets-rotation.md)) vs. app errors.
- A wedged-but-listening service should self-heal via its liveness probe (§2.4);
  if not, `rollout restart`.

### Edge Functions (`<release>-edge-functions`)

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
