# Planned Maintenance (Postgres)

How to take Pawtograder down for **planned** work that touches the database node
— a Kubernetes node drain, a kernel/host reboot, a storage migration, or any
maintenance where the primary Postgres pod must move or restart. The standing
guidance is a **short, scheduled, full-downtime window**, not a read-only or a
failover dance. This runbook says why, and gives the procedure.

Scope: the `supabase/postgres` StatefulSet deployed by `charts/pawtograder`. `NS`
is the release namespace, `<release>` the Helm release. For an **unplanned**
primary loss (the primary is gone and not coming back) use the promote path in
[point-in-time-recovery.md](./point-in-time-recovery.md#manual-failover-promote-the-standby)
instead — this doc is the _planned_ case.

---

## Why a full-downtime window, not read-only

The tempting move is to keep the app up read-only against the standby while the
primary bounces. For Pawtograder that is a trap: **read-only Postgres is
effectively "system unavailable", but unpredictably so.** The core user actions
— submitting, autograder result writes, grade and regrade saves, help-queue
updates, and even auth/session writes — are all writes. Under a read-only
database they fail _scattered across the UI_: some pages load, then an action
500s with `cannot execute INSERT in a read-only transaction`. That is a worse,
more confusing experience than a clean maintenance page, and it generates more
support load, not less.

So we prefer honest downtime: put up a maintenance page that says when we'll be
back, take the short hit, and come back whole. Reads _and_ writes resume
together, with no half-working surface in between.

The standby stays **out of the planned path entirely.** Its job is unplanned
failover and PITR (see [point-in-time-recovery.md](./point-in-time-recovery.md)),
not planned maintenance — a planned bounce needs no promotion, no service
repoint, and no post-failover rebuild.

---

## What makes the bounce safe and cheap

Two chart features turn a node drain into a clean primary bounce rather than a
wedge or a corruption risk:

- **`postgres.pdb.enabled` → a `maxUnavailable: 1` PodDisruptionBudget**
  (`templates/pdb.yaml`). Over a single replica, `minAvailable: 1` would allow
  _zero_ voluntary disruptions and `kubectl drain` would hang on the primary
  forever; `maxUnavailable: 1` allows exactly one, so the eviction API lets the
  primary move.
- **The postgres preStop fast-shutdown** (`templates/postgres-statefulset.yaml`),
  which issues a fast Postgres shutdown on SIGTERM so the pod stops promptly and
  cleanly instead of being SIGKILLed at the end of the grace period.

Together, a node drain **evicts the primary, and the StatefulSet reschedules it
onto another node, reattaches its PVC, and it comes back _as itself_** — same
StatefulSet identity, same data volume, same primary. No promotion, no timeline
branch, no rebuild. The standby simply reconnects and resumes streaming from
where it left off (or `wal-g wal-fetch`es the gap from the archive if it fell
behind the primary's retained `pg_wal`).

> Enable the PDB in the environment overlay. It is off by default (single-replica
> components skip PDBs unless an install explicitly wants drains to stop at the
> database):
>
> ```yaml
> postgres:
>   pdb:
>     enabled: true
> ```

---

## Scheduling

Pawtograder is a course tool: an outage during an assignment deadline or an exam
is a real incident, not an inconvenience. Before scheduling:

- **Avoid deadlines and exam windows.** Check the active courses' due dates and
  in-class assessment times; a couple of minutes of downtime at the wrong minute
  is a lot of students at once.
- Prefer **early morning** in the courses' primary time zone, when submission and
  help-queue traffic is lowest.
- **Announce it** to course staff ahead of time with the window and expected
  duration.

---

## Procedure

The window is dominated by the primary pod reschedule + Postgres restart —
budget a **couple of minutes** of write downtime, a bit more if the image must
pull on the new node.

1. **Put up the maintenance page — this is the fence, not a scale-down.** Flip
   the ingress to a maintenance splash that returns 503 for **every** app host
   (the main host _and_ the API host, plus any per-course
   [deployment-channel](./deployment-channels.md) hosts). The maintenance page is
   mandatory because scaling Deployments to zero does **not** reliably stop all
   writers:

   - **auth** (GoTrue) writes sessions/refresh tokens on every request — it is a
     database writer, so a scale list that omits it leaves auth traffic writing.
   - **edge-functions** is HPA-managed; `kubectl scale` is immediately undone by
     the HorizontalPodAutoscaler, which scales it back toward `minReplicas`.
   - per-course **channel** Deployments (`<release>-web-<channel>`,
     `<release>-functions-<channel>`) are not in any fixed name list.

   Blocking every host at the ingress covers all of them at once. Only if you
   also want the pods gone (e.g. to free the node) should you additionally
   **record current replica counts and suspend the HPA**, so you can restore them
   exactly in step 5:

   ```bash
   # Record what to restore: each Deployment's name + desired replicas (a
   # `-o wide` snapshot is not machine-readable for restore), and the HPA YAML.
   kubectl -n "$NS" get deploy \
     -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.replicas}{"\n"}{end}' \
     > /tmp/pg-maint-deploy-replicas-$(date +%s).txt
   kubectl -n "$NS" get hpa -o yaml > /tmp/pg-maint-hpa-$(date +%s).yaml
   # edge-functions is HPA-managed. You cannot "pause" it by patching
   # minReplicas:0/maxReplicas:0 — this chart's HPA scales on Resource CPU/memory
   # metrics, where minReplicas:0 needs the HPAScaleToZero gate and maxReplicas:0
   # is rejected outright. DELETE the HPA first (recorded above) so it stops
   # reconciling, then scale the Deployment:
   kubectl -n "$NS" delete hpa <release>-functions
   kubectl -n "$NS" scale deploy -l app.kubernetes.io/instance=<release> --replicas=0
   ```

2. **Confirm the physical standby is caught up** before you disturb the primary —
   a streaming standby with a small **byte** gap is a viable safety net if the
   bounce goes sideways. Filter to the physical standby role
   (`usename = 'supabase_replication_admin'`) so a logical-replication client
   (Realtime streams as `supabase_admin`) can't be mistaken for the standby, and
   check `state = 'streaming'` with the WAL byte gap (`pg_wal_lsn_diff`) — not
   `replay_lag` alone, which is a delay interval that is `NULL` when idle.
   **Proceed only when the row is `streaming` and `lag_bytes` is below the alert
   threshold (`replicationLagBytesWarning`, 100 MiB by default)** (run on the
   PRIMARY):

   ```bash
   kubectl -n "$NS" exec -it <release>-postgres-0 -c postgres -- \
     psql -U supabase_admin -d postgres -c "SELECT application_name, state,
       sync_state, pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS lag_bytes
       FROM pg_stat_replication WHERE usename = 'supabase_replication_admin';"
   ```

3. **Do the maintenance.** Drain the node (or reboot/upgrade it):

   ```bash
   kubectl drain <node> --ignore-daemonsets --delete-emptydir-data
   ```

   With the postgres PDB and preStop fast-shutdown in place, the primary evicts,
   reschedules onto another schedulable node, reattaches its PVC, and restarts as
   the same primary. If the drain _hangs_ on the postgres pod, the PDB is not
   enabled in this environment — see [above](#what-makes-the-bounce-safe-and-cheap);
   do **not** force-delete the pod as a habit.

   > **Node-local storage is a hard exception.** This "reschedule onto another
   > node and reattach the PVC" only works when the primary's volume is
   > network-attached and movable (Khoury prod uses NetApp NFS — fine). If
   > Postgres is on a **node-local** storage class (e.g. `local-path` / local
   > NVMe, as in the staging overlay), the PVC is pinned to the drained node: the
   > rescheduled pod stays `Pending` and the database is **down until that node
   > returns**. On node-local storage do not use this bounce — either keep the
   > primary on its node (reboot in place without draining Postgres off it) or use
   > the [promote path](./point-in-time-recovery.md#manual-failover-promote-the-standby).

4. **Verify Postgres is healthy, streaming resumed, and the node is back.**
   Primary out of recovery and accepting writes, standby back to `streaming`:

   ```bash
   # Primary actually accepts WRITES — not just out of recovery. pg_is_in_recovery()
   # = f is necessary but not sufficient; also confirm it is not read-only and can
   # write. txid_current() allocates a real xid, so it errors on a read-only /
   # in-recovery server and succeeds on a writable primary:
   kubectl -n "$NS" exec -it <release>-postgres-0 -c postgres -- \
     psql -U supabase_admin -d postgres -tAc \
       "SELECT pg_is_in_recovery(), current_setting('transaction_read_only'), txid_current();"
   # want: f | off | <a transaction id>

   # Physical standby is streaming again (run on the PRIMARY):
   kubectl -n "$NS" exec -it <release>-postgres-0 -c postgres -- \
     psql -U supabase_admin -d postgres -c "SELECT application_name, state,
       pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS lag_bytes
       FROM pg_stat_replication WHERE usename = 'supabase_replication_admin';"

   # Put the drained node back in service (drain leaves it cordoned):
   kubectl uncordon <node>
   kubectl get node <node>   # want: Ready, SchedulingDisabled cleared
   ```

   When `postgres.replica.enabled`, `PawtograderReplicaNotStreaming` clears as
   soon as the standby re-establishes streaming, but `PawtograderReplicaLagHigh`
   stays active until the standby has caught up and replay lag drops back below
   its configured threshold — expect it to linger briefly while the reconnected
   standby replays the WAL it missed during the bounce.

5. **Bring the app back — restore first, drop the maintenance page last.** With
   the maintenance gate still up (so users don't hit empty services / 502s while
   pods start), restore the app, verify health, run the
   [smoke checklist](./production-install.md#smoke-test), and only then remove the
   maintenance page. If you scaled down in step 1:

   - Restore each Deployment to the replica count you recorded (do **not**
     hardcode a number — read it back from the saved file):

     ```bash
     while IFS=$'\t' read -r name replicas; do
       kubectl -n "$NS" scale deploy "$name" --replicas="$replicas"
     done < /tmp/pg-maint-deploy-replicas-*.txt
     ```

   - **Recreate the deleted HPA by reconciling the Helm release**
     (`helm upgrade` with the same values), not `kubectl autoscale`: the chart's
     `edge-functions-hpa.yaml` is an `autoscaling/v2` HPA with **both** CPU and
     memory Resource metrics plus custom scale-up/down behavior, none of which a
     `kubectl autoscale` (CPU-target v1-style) HPA reproduces. Helm owns it, so a
     reconcile restores it exactly.

   Drop the maintenance page only after the smoke checklist passes.

---

## The one exception: maintenance too long for a bounce

If the work can't fit in a couple-minute bounce — the classic case is a
**Postgres major-version upgrade**, or anything that holds the primary's data
volume unavailable for an extended period — a full-downtime window is too long.
That is the one time you actually **promote the standby** to keep writes up, then
rebuild the old primary afterward. Follow the manual failover procedure in
[point-in-time-recovery.md](./point-in-time-recovery.md#manual-failover-promote-the-standby),
and rehearse it first with the
[promotion drill](./point-in-time-recovery.md#promotion-drill-rehearsing-failover).

---

## Related

- [point-in-time-recovery.md](./point-in-time-recovery.md) — the standby,
  unplanned promote/failover, and the promotion drill.
- [incident-response.md](./incident-response.md) — when a "planned" bounce turns
  into an incident.
- [production-install.md](./production-install.md#smoke-test) — the post-change
  smoke checklist.
