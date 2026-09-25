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

![The maintenance page served on staging: the pixel-art Pawtograder cityscape behind a centered card with a configurable title, message, and ETA.](./images/maintenance-page.jpg)

_The styled maintenance page (served with `HTTP 503` + `Retry-After`), captured from staging. Title/message/ETA are set per-window with `maintenance.sh down --title/--message/--eta`._

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

## Chart versions and Postgres restarts

A chart upgrade can restart the primary as surely as a node drain can, and
nobody schedules a window for a change they think is routine. So the chart
version says which kind of change it is:

- **Patch (`0.3.26` → `0.3.27`): Postgres keeps running.** Other tiers may roll
  (web, edge functions, rest), but the primary and standby StatefulSets'
  pod templates are unchanged.
- **Minor or major (`0.3.x` → `0.4.0`): Postgres may restart.** This is the
  only kind of release allowed to restart it, but not every one does. Check
  the release's PR for the `postgres-restart-gate` notice, or diff the rendered
  StatefulSets yourself. If it restarts Postgres, plan a maintenance window
  with the procedure below.

What restarts Postgres is any change to the rendered `.spec.template` of
`templates/postgres-statefulset.yaml` or `templates/postgres-replica.yaml`.
That includes volumes and mounts, env, resources, the image, labels, and the
`checksum/config` annotation. The annotation hashes `postgres-config.yaml` and
`postgres-exporter-queries.yaml`, so a new exporter query restarts the primary
too, even though it looks like a monitoring change. New monitoring objects
belong in `monitoring.yaml`. Values count as much as templates: a
`postgres.config` or `postgres.resources` edit in a values file rolls the pod
the same way.

A change to `.spec.volumeClaimTemplates` is different, and worse: it doesn't
restart anything. The field is immutable, so Kubernetes rejects the
StatefulSet update and the `helm upgrade` fails. A storage change like that
needs its own plan, either a data migration to a new volume or deleting and
recreating the StatefulSet (`--cascade=orphan`) around it, not just a window.

CI enforces this. The `postgres-restart-gate` job in `.github/workflows/lint.yml`
runs `charts/pawtograder/tests/postgres-restart-gate.sh`, which renders both
StatefulSets at `main` and at the PR head across the example values files,
each side with its own copy of the values.
It compares against `main` rather than the PR's base because production
deploys from `main`. Against `staging`, backing out a restart that was never
released would itself look like a restart. It fails a PR that changes either
pod template, claim template, replica count (scaling the primary to 0 stops
the database), or immutable identity field (name, `serviceName`, `selector`,
`podManagementPolicy`) without a minor bump over `main`'s version. It also covers the persistence-disabled branch. It fails if
any case can't be compared, whether a render breaks or a values file is
missing, rather than passing on partial coverage. A PR that does bump gets a
notice instead. To run it locally:

```bash
charts/pawtograder/tests/postgres-restart-gate.sh origin/main
```

**Coordinate the merge to `staging`.** A push to `staging` deploys staging at
once, which restarts staging's Postgres. Staging then promotes to `main`
branch-wide, so after the merge the change goes to production with the next
promotion. Until the production window is booked, keep a Postgres-restarting
change on its own branch, not on `staging`. When the window is booked,
merge it to `staging`, promote it, and deploy it to production in the window.

If production needs relief before a window can be scheduled, look for an
online workaround first: a setting that takes effect on reload
(`ALTER SYSTEM` + `pg_reload_conf()`) rather than a pod change. Record it
as a comment in the environment's values file, not as `postgres.config`
keys. Rendering those keys changes `checksum/config`, so the next routine
upgrade would restart the primary after all. The 2026-09-23 `/dev/shm` incident
([incident-response.md](./incident-response.md#postgres-devshm-exhaustion-sqlstate-53100))
is the worked example: #1021 shipped as a patch, was split, and its restarting
half moved to 0.4.0.

### Deploying a Postgres-restarting release in a window

The procedure below was written for node and host maintenance, where the chart
doesn't change. A release that restarts Postgres is different: its
`helm upgrade` is the bounce, and it runs inside the window. The fence that
`maintenance.sh down` puts up is made of live edits (the web host rerouted to
the page, writers scaled to 0, the functions HPA deleted, CronJobs suspended),
and a plain `helm upgrade` re-renders every one of them. Client-side, it puts
the writers, HPA and web backend back while the primary is rolling.
Server-side, it fails on the fields `kubectl` took over, in the middle of the
window.

So the release carries the fence itself. `maintenance.active=true` renders the
state `down` leaves behind, field for field: the web host's `/` (and each
channel host's `/`) on `pawtograder-maintenance:8080`, the writers the script
fences at `replicas: 0`, no functions HPA, and the write-capable CronJobs at
`suspend: true`. The release and the live objects then agree, and neither
apply mode has anything to change. pg_cron is paused in the database and
survives the upgrade, so it stays the script's job. See `maintenance.active`
in `charts/pawtograder/values.yaml` for the exact list.

`maintenance.sh down` is still the entry point, because it captures the prior
state, pauses pg_cron, and gates on zero writer pods. The posture only makes
the upgrade agree with it. On exit, `maintenance.sh up` runs **first** and the
upgrade that turns the posture off runs **second**.

```bash
NS=pawtograder-prod
VALUES=values/values-prod.yaml       # the file the routine deploy uses
# A versioned chart reference. Not charts/pawtograder: Helm ignores --version
# for a local directory and renders whatever is checked out.
CHART=oci://dev-harbor.khoury.northeastern.edu/pawtograder/charts/pawtograder
DEPLOYED=$(helm list -n "$NS" -o json | jq -r '.[] | select(.name=="pawtograder") | .chart | sub("^pawtograder-"; "")')
TARGET=0.4.0

# 0. Before the window: confirm the TARGET chart knows the posture. Helm ignores
#    values a chart doesn't define, so a chart without it would take
#    --set maintenance.active=true silently and lift the fence. Expect "true".
helm template pawtograder "$CHART" --version "$TARGET" -n "$NS" -f "$VALUES" \
  --set maintenance.enabled=true --set maintenance.active=true \
  --show-only templates/ingress.yaml | grep 'pawtograder.io/maintenance-active'

# 1. Pre-stage the page with the chart AND values that are ALREADY DEPLOYED.
#    The target chart would roll the primary before anything is fenced, and so
#    would target values: $VALUES may already carry the window's
#    postgres.config, resources or image change. --reuse-values keeps the
#    release's current values and adds only the page. Set this window's page
#    text now, as values (see below). --wait-for-jobs: this revision's
#    migrations Job must finish before `down` counts writers.
helm upgrade pawtograder "$CHART" --version "$DEPLOYED" -n "$NS" --reuse-values \
  --set maintenance.enabled=true --set maintenance.eta="6:15pm ET" \
  --wait --wait-for-jobs
kubectl -n "$NS" rollout status deploy/pawtograder-maintenance

# 2. Fence, and wait for the verdict. Do not go on without SAFE TO BOUNCE.
charts/pawtograder/scripts/maintenance.sh down

# 3a. Hold the STANDBY back, so the upgrade rolls only the primary. Without
#     this, one upgrade submits both StatefulSet updates and their controllers
#     can take the primary and the standby down together, leaving no standby to
#     promote if the primary does not come back. A partition >= the replica
#     count keeps every standby pod on its old spec. The chart does not render
#     updateStrategy, so neither apply mode touches this field, and Helm's
#     --wait honours the partition.
kubectl -n "$NS" patch statefulset pawtograder-postgres-replica --type=merge -p \
  "{\"spec\":{\"updateStrategy\":{\"type\":\"RollingUpdate\",\"rollingUpdate\":{\"partition\":$(kubectl -n "$NS" get statefulset pawtograder-postgres-replica -o jsonpath='{.spec.replicas}')}}}}"

# 3. The bounce: the target release, carrying the posture. Same values as the
#    routine deploy, plus the posture and the page text from step 1, and with
#    MIGRATIONS OFF. The migrations Job is a plain Job submitted with the rest
#    of the upgrade, not after the primary rolls, so it could start against the
#    old primary and lose its connection when that pod is terminated. They run
#    in step 4c, once the new primary is verified.
helm upgrade pawtograder "$CHART" --version "$TARGET" -n "$NS" -f "$VALUES" \
  --set maintenance.enabled=true --set maintenance.active=true \
  --set maintenance.eta="6:15pm ET" --set migrations.enabled=false \
  --wait --timeout 25m

# 4. Verify, still behind the page.
charts/pawtograder/scripts/maintenance.sh status   # page UP, HPA ABSENT, writers 0,
                                                   # "carries maintenance.active=true"
kubectl -n "$NS" rollout status statefulset/pawtograder-postgres
#    ...then the write probe from step 4 of the manual sequence below. Only once
#    the NEW primary accepts writes, release the standby and let it roll:
kubectl -n "$NS" patch statefulset pawtograder-postgres-replica --type=merge -p \
  '{"spec":{"updateStrategy":{"rollingUpdate":{"partition":0}}}}'
kubectl -n "$NS" rollout status statefulset/pawtograder-postgres-replica
#    ...then the standby query from step 4 of the manual sequence. partition 0
#    is the default behaviour, so the field can stay; Helm never renders it.
#    If the primary does NOT come back, the standby is still on its old spec
#    and healthy: go to the promote path in point-in-time-recovery.md.

# 4c. Migrations, still fenced: the same target and values with migrations on.
#     The StatefulSets already match, so nothing rolls; this only runs the
#     migrations Job, and --wait-for-jobs waits for it (a plain Job, not a
#     hook, so --wait alone would not).
helm upgrade pawtograder "$CHART" --version "$TARGET" -n "$NS" -f "$VALUES" \
  --set maintenance.enabled=true --set maintenance.active=true \
  --set maintenance.eta="6:15pm ET" --wait --wait-for-jobs --timeout 25m

# 4d. Re-pause pg_cron. A migration that calls cron.schedule (or unschedules and
#     recreates a job) leaves it ACTIVE behind the fence. repause pauses
#     whatever is active and adds it to the set `up` resumes. A job created by
#     one migration can still fire during a later one in the same run; check
#     the release's migrations for cron.schedule before the window.
charts/pawtograder/scripts/maintenance.sh repause

# 5. Exit, in this order.
charts/pawtograder/scripts/maintenance.sh up       # restore; page down LAST
helm upgrade pawtograder "$CHART" --version "$TARGET" -n "$NS" -f "$VALUES" \
  --wait --wait-for-jobs --timeout 25m             # posture off: the routine deploy
charts/pawtograder/scripts/maintenance.sh status   # HPA present, no posture warning
```

Why the exit runs in that order:

- **`up` first** keeps the guarantees `up` exists for. It checks the primary
  accepts writes before any writer starts, and it drops the page only once the
  restored tiers are Ready. An upgrade applies everything at once, so running
  it first would move the web host off the page while web is still starting
  (the controller's bare 503), with pg_cron still paused.
- **The upgrade second** is then close to a no-op. Every field `up` restored
  (replicas, CronJob `suspend`, the ingress backends) is back at the value the
  chart renders with the posture off, so nothing conflicts. The one thing it
  does is recreate the functions HPA. `up` leaves the HPA alone when the
  release holds the posture. Its captured copy came from the old chart, and
  re-applying it would put the HPA's fields under kubectl's field manager, so
  any field the target chart changed would conflict on this upgrade.
- **Nothing is left in drift.** With autoscaling on, the posture never renders
  `replicas` on the functions Deployment. Rendering 0 there would make the exit
  upgrade, under a client-side 3-way merge, delete the field and reset a
  restored tier to one pod.

Rules for the window:

- **`up` skips what the target release removed.** If the release applied in
  the window drops a writer it recorded (a removed deployment channel, say),
  `up` warns that the object no longer exists and carries on restoring the
  rest. The same goes for a write CronJob the release disabled.
- **Don't add writers or move the web Service in the window's upgrade.** A
  tier or deployment channel that `down` never captured would be created at 0
  behind the page, and nothing would bring it up before the page drops. And
  `up` restores the web backend `down` recorded, so a changed web Service name
  or port would leave the web host on a port that no longer exists. The chart
  refuses a posture upgrade that enables a new writer, adds a channel,
  disables web or changes its backend; make those changes in a routine
  deploy.
- **Use this procedure only if the target leaves the standby's rollout
  controls alone.** Step 3a relies on a live `partition` the chart doesn't
  render. If the release's `postgres-restart-gate` notice lists an
  `updateStrategy` or `ordinals` change for `postgres-replica.yaml`, the
  target upgrade can overwrite the partition or replace the held pod, and
  the standby rolls with the primary. Stage that release differently.
- **Don't shrink the standby in the window's upgrade.** The standby is the
  failover target while the primary rolls, and the partition in step 3a only
  holds existing pods. The chart refuses a posture upgrade that disables the
  standby or lowers its replica count; do that after the window.
- **Re-suspend hand-suspended CronJobs after the exit upgrade.** `up`
  restores a CronJob that was already suspended before the window, but the
  posture-off exit upgrade then drops the `suspend` field the posture
  rendered, which Kubernetes defaults to false. `up` lists the ones affected;
  after the exit upgrade, re-run
  `kubectl -n "$NS" patch cronjob <name> --type=merge -p '{"spec":{"suspend":true}}'`
  for each. Only a definite NotFound counts; any other read error aborts `up`.
- **Set the page text as values, not with `down --title/--message/--eta`.**
  Those flags patch the maintenance ConfigMap under kubectl's field manager.
  The target upgrade renders the chart's text over it, which fails
  server-side and reverts the text client-side. Pass the same
  `maintenance.title`/`message`/`eta` to steps 1 and 3.
- **Nothing else deploys during the window.** Any upgrade without
  `maintenance.active=true`, including the routine deploy workflow, lifts the
  fence. The workflow can't pass `--set`, and its `helm test` fails against
  the page, so run step 3 by hand. Use the Helm major version the workflow
  uses, so the upgrade applies the same way (server-side or client-side) as
  the release's other revisions.
- **Don't `helm rollback` inside the window.** Every earlier revision was
  rendered without the posture, so a rollback lifts the fence as surely as a
  plain upgrade. If step 3 fails, fix forward and re-run it with the posture.
- **Never carry the posture past the window.** Pass it with `--set` for one
  upgrade only. Don't put it in a values file or carry it with
  `--reuse-values`, because every upgrade that keeps it re-fences production.
  `down` refuses a release that already holds it, since it would capture the
  fence as the "prior" state. `up` and `status` warn while it is still set.
- **If the target changes a writer's replica count**, the exit upgrade
  (server-side) reports a conflict on `.spec.replicas`, because
  `maintenance.sh up` restored the old count under kubectl's manager. Check
  that the conflict names only fields `up` restored, then re-run the exit
  upgrade with `--force-conflicts` so the chart's value wins (see the SSA note
  in the manual sequence).

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

### Recommended: drive it with `maintenance.sh`

`charts/pawtograder/scripts/maintenance.sh` wraps the page-up + write-fence
sequence below with live status output and exact-restore state capture. Use it as
the primary path; the numbered steps that follow are the underlying reference (and
the fallback if you need to do it by hand). Its `down` does, in order: pause
pg_cron → (page up + scale every writer tier to 0, in one fence) → suspend
write CronJobs → block until all writer pods terminate → report SAFE TO BOUNCE /
NOT READY. `up` is the reverse (writable preflight → restore writers/channels →
unsuspend CronJobs → re-apply the functions HPA → resume pg_cron → drop the page
last). When the release holds `maintenance.active`, `up` leaves the HPA to the
exit upgrade; see
[above](#deploying-a-postgres-restarting-release-in-a-window).

```bash
# 1. Pre-stage the page once (creates the Service; does NOT reroute yet).
#    Use the CURRENTLY DEPLOYED version (--version), never the release you are
#    about to install: a Postgres-restarting target chart would roll the
#    primary right here, before anything is fenced. <chart-ref> must be a
#    versioned reference (oci://... or repo/chart). Helm ignores --version for
#    a local chart directory and would install whatever that checkout holds.
helm upgrade pawtograder <chart-ref> --version <deployed-version> -n pawtograder-prod \
  --reuse-values --set maintenance.enabled=true

# 2. Page up + fence all writers, then read the SAFE TO BOUNCE / NOT READY line:
charts/pawtograder/scripts/maintenance.sh down            # add --dry-run to preview
#    ...perform the node/DB maintenance once it says SAFE TO BOUNCE...

# 3. Restore everything (page comes down LAST):
charts/pawtograder/scripts/maintenance.sh up

charts/pawtograder/scripts/maintenance.sh status          # read-only posture, any time
```

`down` captures prior state (active `cron.job` rows, the edge-functions HPA,
writer replica counts, suspended CronJobs, the ingress web-host backend) into the
`pawtograder-maintenance-state` ConfigMap; `up` restores from it and deletes it.
`NAMESPACE`/`RELEASE` are configurable (`-n`/`-r`, default `pawtograder-prod` /
`pawtograder`); `--yes` skips the prompt.

**Facts the write-fence audit surfaced (why the script does more than scale pods):**

- **The page is not a write fence.** The ingress patch reroutes the **web host
  only**; the **API/kong host stays open**, so the database is still reachable
  until the writer tiers are actually stopped.
- **Writes come from more than the obvious tiers.** `auth` (GoTrue) writes
  sessions on every request; `edge-functions` is HPA-managed (a bare
  `kubectl scale` is undone by the HPA — delete the HPA first); and **`pg_cron`**
  fires DB-side jobs (gradebook recalculation, deadline checks, sync) with no pod
  to scale — pause them with `UPDATE cron.job SET active=false`.
- **The real gate is "zero writer pods", not "empty queue".** Everything is
  fenced in one step — page up + scale **all** writer tiers to 0 (`functions` incl.
  its HPA, `web`, `rest`, `auth`, `storage`, `realtime`, and channel deploys) —
  and the script then blocks until those pods have **terminated**. Scaling
  `functions` to 0 lets in-flight handlers COMMIT and exit cleanly because
  edge-runtime drains on SIGTERM up to `edgeFunctions.gracefulExitTimeoutSeconds`
  (410s ≥ `worker.timeoutMs` 400s), exiting as soon as in-flight is done
  (near-instant when idle); `terminationGracePeriodSeconds` (430s) is only the
  SIGKILL backstop. Once no writer pod is running, nothing is touching the DB.
- **The pgmq backlog is durable, so it is NOT a gate.** The queues
  (`pgmq.q_async_calls`, `q_async_calls_low_priority`, `q_gradebook_row_recalculate`,
  `q_discord_async_calls`) are Postgres tables — the backlog survives the bounce and
  drains after `up` when `functions` resumes. The script prints the buffered count
  as context but does **not** block on it: safety comes from graceful-exit +
  zero writer pods, and blocking on 0 would never converge anyway because the
  api/kong host stays open and webhooks (e.g. `github-repo-webhook`) keep writing
  directly.
- Write-capable **CronJobs** (`audit-partitions`, the backup drills) are suspended
  for the window and restored afterward.

### Manual reference sequence

1. **Put up the maintenance page, then fence writes.** The chart ships a styled
   maintenance page (`maintenance.enabled`) — a tiny nginx Deployment behind the
   `pawtograder-maintenance` Service that returns HTTP 503 + `Retry-After` with an
   on-brand "we'll be right back" body. You route the **web host** to it so users
   see a clean banner instead of errors.

   **Deploy the page first — it must exist before you reroute.** Enabling
   `maintenance.enabled` only _creates_ the Deployment/Service; the ingress patch
   is what reroutes. Roll it out and wait for endpoints:

   ```bash
   # <deployed-version>: the chart already running, NOT a target release.
   # <chart-ref>: a versioned oci:// or repo reference, never a local directory
   # (Helm ignores --version for a local path).
   helm upgrade pawtograder <chart-ref> --version <deployed-version> -n "$NS" --reuse-values \
     --set maintenance.enabled=true \
     --set maintenance.eta="6:15pm ET"   # optional; title/message also overridable
   kubectl -n "$NS" rollout status deploy/pawtograder-maintenance
   ```

   **Reroute the web host → maintenance page.** The primary ingress is named
   `pawtograder` (the Helm fullname); its first rule (`rules[0]`) is the web host,
   and with the API on its own host (prod default) that rule's first path
   (`paths[0]`) is the web backend. Verify the rule is the web host, then repoint
   it:

   ```bash
   # Confirm rules[0] is the WEB host (not the api host) before patching:
   kubectl -n "$NS" get ingress pawtograder -o jsonpath='{.spec.rules[0].host}{"\n"}'

   kubectl -n "$NS" patch ingress pawtograder --type=json -p \
     '[{"op":"replace","path":"/spec/rules/0/http/paths/0/backend/service","value":{"name":"pawtograder-maintenance","port":{"number":8080}}}]'
   ```

   > **Restore every patched field to its exact prior value.** Under server-side
   > apply, `kubectl patch`/`scale` take ownership of the fields they touch, and
   > reverting the value does not release that claim. Ownership alone is harmless:
   > SSA raises a conflict only when a later apply would **change** a field owned
   > by someone else. So the rule that matters is byte-exactness. If what you
   > restore differs from what the chart renders, even by one character, the next
   > `helm upgrade` fails:
   >
   > ```
   > UPGRADE FAILED: conflict occurred while applying object ...
   >   Apply failed with 1 conflict: conflict with "kubectl-patch" using v1: .data.index.html
   > ```
   >
   > and it fails on a deploy that may be days later and unrelated to the window.
   >
   > `--field-manager=helm` does **not** avoid this. Verified in production, it
   > only changes the name in the message to `conflict with "helm"`, because a
   > manager's `Update` entry is distinct from Helm's `Apply` entry. The escape
   > hatch is to force ownership back to Helm on the next server-side apply,
   > after confirming the live value is the one you want:
   >
   > ```bash
   > helm upgrade <release> <chart> -n "$NS" -f <values> --server-side --force-conflicts
   > ```
   >
   > `--force-conflicts` and `--server-side` are Helm 4 flags. Stock Helm 3
   > `helm upgrade` has neither and rejects `--force-conflicts` as an unknown flag.
   > On a GitOps/Fleet deploy path, force via the wrapper's own flag or re-apply
   > input.

   **This reroutes the web host ONLY — it is not a write fence.** The API/kong
   host is a separate ingress rule and stays open, so the page is a user-facing
   banner, not protection for the database. Fencing writes is a separate step, and
   scaling Deployments to zero does **not** by itself stop every writer:

   - **auth** (GoTrue) writes sessions/refresh tokens on every request — it is a
     database writer, so a scale list that omits it leaves auth traffic writing.
   - **edge-functions** is HPA-managed; `kubectl scale` is immediately undone by
     the HorizontalPodAutoscaler, which scales it back toward `minReplicas`.
   - per-course **channel** Deployments (`<release>-web-<channel>`,
     `<release>-functions-<channel>`) are not in any fixed name list.

   So to actually fence writes, **record current replica counts, delete the HPA,
   and scale the writer tiers to 0**, so you can restore them exactly in step 5:

   ```bash
   # 0. Pause pg_cron FIRST. ~20 scheduled jobs write in-DB every minute,
   #    independent of every app pod, so scaling Deployments alone does NOT fence
   #    them. Record the active set so you can resume exactly in step 5.
   kubectl -n "$NS" exec <release>-postgres-0 -c postgres -- psql -U supabase_admin \
     -d postgres -tAc "SELECT string_agg(jobid::text,',') FROM cron.job WHERE active;"
   kubectl -n "$NS" exec <release>-postgres-0 -c postgres -- psql -U supabase_admin \
     -d postgres -c "UPDATE cron.job SET active=false WHERE active;"

   # 1. Record what to restore: writer Deployments + the realtime StatefulSet
   #    (name + desired replicas — a `-o wide` snapshot is not machine-readable),
   #    and the HPA YAML.
   kubectl -n "$NS" get deploy,statefulset \
     -o jsonpath='{range .items[*]}{.kind}{"\t"}{.metadata.name}{"\t"}{.spec.replicas}{"\n"}{end}' \
     > /tmp/pg-maint-replicas-$(date +%s).txt
   kubectl -n "$NS" get hpa -o yaml > /tmp/pg-maint-hpa-$(date +%s).yaml

   # 2. edge-functions is HPA-managed and cannot be "paused" via minReplicas:0
   #    (needs the HPAScaleToZero gate) / maxReplicas:0 (rejected outright) — so
   #    DELETE the HPA first (recorded above), then scale the writer tiers to 0
   #    BY COMPONENT. Do NOT use `-l app.kubernetes.io/instance=<release>`: it
   #    would also scale the maintenance page down and STILL miss realtime (a
   #    StatefulSet, not a Deployment).
   kubectl -n "$NS" delete hpa <release>-functions
   for c in functions web rest auth storage; do
     kubectl -n "$NS" scale deploy -l "app.kubernetes.io/component=$c" --replicas=0
   done
   kubectl -n "$NS" scale statefulset -l "app.kubernetes.io/component=realtime" --replicas=0
   # plus any per-course channel Deployments (<release>-{web,functions}-<channel>).
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

   - Resume pg_cron for exactly the jobs you paused in step 0 (the jobids you
     recorded), then restore each writer to its recorded replica count — read it
     back from the saved file (**do not** hardcode), scaling by the captured
     **kind** so the `realtime` StatefulSet is restored too:

     ```bash
     kubectl -n "$NS" exec <release>-postgres-0 -c postgres -- psql -U supabase_admin \
       -d postgres -c "UPDATE cron.job SET active=true WHERE jobid = ANY(ARRAY[<recorded-jobids>]::bigint[]);"
     while IFS=$'\t' read -r kind name replicas; do
       kubectl -n "$NS" scale "${kind,,}" "$name" --replicas="$replicas"
     done < /tmp/pg-maint-replicas-*.txt   # the file written in step 1 above
     ```

   - **Recreate the deleted HPA by reconciling the Helm release**
     (`helm upgrade` with the same values), not `kubectl autoscale`: the chart's
     `edge-functions-hpa.yaml` is an `autoscaling/v2` HPA with **both** CPU and
     memory Resource metrics plus custom scale-up/down behavior, none of which a
     `kubectl autoscale` (CPU-target v1-style) HPA reproduces. Helm owns it, so a
     reconcile restores it exactly.

   **Point the web host back to the app** (reverse of the step-1 patch), then drop
   the maintenance page only after the smoke checklist passes:

   ```bash
   kubectl -n "$NS" patch ingress pawtograder --type=json -p \
     '[{"op":"replace","path":"/spec/rules/0/http/paths/0/backend/service","value":{"name":"pawtograder-web","port":{"number":3000}}}]'
   # Optional: tear the page down again once traffic is back on the app.
   helm upgrade pawtograder <chart> -n "$NS" --reuse-values --set maintenance.enabled=false
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
