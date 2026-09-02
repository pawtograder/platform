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

**First question: which tier?** When `edgeFunctions.workerTier.enabled` is set
there are **two** edge Deployments, and they fail differently:

| Deployment                    | serves                                                                                                        | scaling                | when it is down                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<release>-functions`         | every function except the routed workers                                                                      | HPA                    | user-facing 502s                                                                                                                                              |
| `<release>-functions-workers` | `notification-queue-processor`, `github-async-worker`, `discord-async-worker`, `gradebook-column-recalculate` | fixed replicas, no HPA | those four **502** (same code as the request tier — the tier is in the pod name, not the status); pgmq stops draining, nothing user-facing breaks immediately |

The status code does **not** discriminate: a Deployment with zero ready pods
leaves a Service with no endpoints, kube-proxy refuses the connection and Kong
reports that upstream failure as **502** on either tier. Use the failing **path**
(`/functions/v1/<one of the four>` vs anything else) or the **pod name** in the
alert, not the code.

Kong routes by **path**, not by health, so the request tier does **not** absorb
worker traffic when the worker tier is down — and it has no HPA, so
"HPA scaled up?" is not a useful question there. `PawtograderEdgeWorkerTierUnavailable`
is the alert that names it; queue depth on the queues-and-workers dashboard is
the blast radius. pg_cron pokes are idempotent and pgmq's per-message visibility
timeout is the mutual exclusion, so work resumes on the next tick rather than
being lost.

Two consequences worth knowing before you start pulling threads:

- **Each tier has its OWN memory budget.** `edgeFunctions.*` for the request
  tier, `edgeFunctions.workerTier.*` for the worker tier. The OOM and
  memory-high alerts select on the _container_ name, which both tiers share, so
  they cover both — read the knobs off the tier the **pod name** identifies, not
  off `edgeFunctions.*` reflexively.
- **Fastest mitigation is to un-split.** `--set edgeFunctions.workerTier.enabled=false`
  and `helm upgrade` returns all four functions to the request tier: no DB
  change, no client change, no image rebuild. It does roll Kong.

**Expected once, on the first upgrade that enables the tier:** the Kong config
checksum rolls Kong in the same release that creates the worker Deployment, so a
new Kong pod can serve the four worker paths before that Deployment has ready
endpoints — they return 502 until it does. Bounded by pod startup, and nothing is
lost: those paths are reached only by pg_cron, which retries every minute, and
pgmq's per-message visibility timeout means an undelivered poke drops no work.
Kong readiness is deliberately NOT coupled to worker endpoints — that would take
the entire API down whenever this one tier was unhealthy, which is the failure
`PawtograderEdgeWorkerTierUnavailable` exists to report while everything else
keeps serving. There is no way to stage this across two releases:
`edgeFunctions.workerTier.enabled` gates the Deployment and the Kong routes
together, and both ways you would try to decouple them are render errors (an
empty `functions` list, and `kong.enabled: false`). Enable it in a window where a
minute of 502s on those four paths is acceptable, which — because pg_cron retries
every minute and pgmq holds the message — is any window at all.

**Manual pre-flight when enabling the tier from a DOWNSTREAM values repo.** The
chart checks the routed names it can see: `tests/render-guardrails.sh`'s
`shadow_check` renders the chart's own `values.yaml` and asserts every name in
`edgeFunctions.workerTier.functions` has a matching `supabase/functions/<name>/`
directory. That check cannot see an overlay in another repository, and production
is deployed from one (`prod-charts`). A typo there is the quietest failure this
tier has: the name passes the chart's format guard (it is a legal DNS-1123
label), Kong loads the route cleanly, the demuxer 404s on it, and the real
function keeps being served by the request tier. Nothing looks broken — two pods
run and serve nothing, and the split silently does not exist.

So before enabling the tier in a downstream repo, hand-check the list against the
image's inventory:

```bash
# From a platform checkout at the SHA the target environment runs.
for fn in notification-queue-processor github-async-worker \
          discord-async-worker gradebook-column-recalculate; do
  [ -f "supabase/functions/$fn/index.ts" ] && echo "ok   $fn" || echo "MISSING $fn"
done
```

`PawtograderEdgeWorkerTierNoTraffic` is the backstop if this is missed — a typo
in all four names produces exactly its firing condition — but it takes 30m and
tells you the split is not in effect, not which name is wrong.

`scripts/edge-logs.sh` covers both tiers (it selects
`component=~"functions|functions-workers"`), so `--function <name>` works
regardless of which tier serves it. Deployment channels are deliberately outside
that selector — they run their own image tag and the output is unlabelled, so
mixing them in would answer a triage question with lines from another build; set
`EDGE_LOG_COMPONENTS` to read one on purpose.

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
