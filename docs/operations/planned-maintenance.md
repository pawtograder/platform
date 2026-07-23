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

1. **Put up the maintenance page / stop writers.** Either flip the ingress to a
   maintenance splash, or scale the app tiers to zero so nothing writes to the
   database:

   ```bash
   kubectl -n "$NS" scale deploy \
     <release>-web <release>-rest <release>-functions <release>-realtime \
     --replicas=0
   ```

   (This is the same "stop writers" step the failover runbook uses; here it is a
   graceful pause, not an emergency fence.)

2. **Confirm the standby is caught up** before you disturb the primary — a small
   `replay_lag` means it is a viable safety net if the bounce goes sideways
   (run on the PRIMARY):

   ```bash
   kubectl -n "$NS" exec -it <release>-postgres-0 -c postgres -- \
     psql -U supabase_admin -c "SELECT application_name, state, sync_state,
       write_lag, replay_lag FROM pg_stat_replication;"
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

4. **Verify Postgres is healthy and streaming resumed.** Primary out of recovery
   and accepting writes, standby back to `streaming` with small lag:

   ```bash
   # Primary is up and read-write (returns f):
   kubectl -n "$NS" exec -it <release>-postgres-0 -c postgres -- \
     psql -U supabase_admin -tAc "SELECT pg_is_in_recovery();"

   # Standby is streaming again (run on the PRIMARY):
   kubectl -n "$NS" exec -it <release>-postgres-0 -c postgres -- \
     psql -U supabase_admin -c "SELECT application_name, state, replay_lag
       FROM pg_stat_replication;"
   ```

   The `PawtograderReplicaNotStreaming` / `PawtograderReplicaLagHigh` alerts
   (when `postgres.replica.enabled`) should clear once the standby reconnects.

5. **Bring the app back** (step 1 in reverse) and run the
   [smoke checklist](./production-install.md#smoke-test):

   ```bash
   kubectl -n "$NS" scale deploy \
     <release>-web <release>-rest <release>-functions <release>-realtime \
     --replicas=<original>
   ```

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
