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
last).

```bash
# 1. Pre-stage the page once (creates the Service; does NOT reroute yet):
helm upgrade pawtograder <chart> -n pawtograder-prod --reuse-values \
  --set maintenance.enabled=true

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
   helm upgrade pawtograder <chart> -n "$NS" --reuse-values \
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
   # RUN THE WHOLE FENCE AS ONE COMMAND. `set -euo pipefail` in a subshell is the
   # point: every step here had a failure mode that was advisory, and this
   # procedure's whole claim is that nothing writes to the primary while it is
   # bounced. Inside `set -e` the sequence STOPS at the first failure and the
   # block exits non-zero, so a fence that broke halfway cannot look like a fence
   # that completed.
   (
     set -euo pipefail

     # 0. Pause pg_cron FIRST. ~20 scheduled jobs write in-DB every minute,
     #    independent of every app pod, so scaling Deployments alone does NOT
     #    fence them. Record the active set so you can resume exactly in step 5.
     #    Then VERIFY the pause took: this psql can fail for reasons that leave
     #    the jobs running (wrong pod name after a rename, RBAC on exec, a
     #    primary that is not `-0`), and a fence that silently skipped its
     #    in-database writers is the worst version of this failure -- the app
     #    pods are all gone, so everything looks quiet.
     kubectl -n "$NS" exec <release>-postgres-0 -c postgres -- psql -U supabase_admin \
       -d postgres -tAc "SELECT string_agg(jobid::text,',') FROM cron.job WHERE active;"
     kubectl -n "$NS" exec <release>-postgres-0 -c postgres -- psql -U supabase_admin \
       -d postgres -c "UPDATE cron.job SET active=false WHERE active;"
     still_active="$(kubectl -n "$NS" exec <release>-postgres-0 -c postgres -- psql -U supabase_admin \
       -d postgres -tAc "SELECT count(*) FROM cron.job WHERE active;" | tr -d '[:space:]')"
     if [ "$still_active" != "0" ]; then
       echo "STOP: $still_active pg_cron job(s) are still active -- in-database writers are NOT fenced." >&2
       exit 1
     fi

     # 1. Record what to restore: writer Deployments + the realtime StatefulSet
     #    (name + desired replicas — a `-o wide` snapshot is not machine-readable),
     #    and the HPA YAML.
     kubectl -n "$NS" get deploy,statefulset \
       -o jsonpath='{range .items[*]}{.kind}{"\t"}{.metadata.name}{"\t"}{.spec.replicas}{"\n"}{end}' \
       > "/tmp/pg-maint-replicas-$(date +%s).txt"
     kubectl -n "$NS" get hpa -o yaml > "/tmp/pg-maint-hpa-$(date +%s).yaml"

     # 2. edge-functions is HPA-managed and cannot be "paused" via minReplicas:0
     #    (needs the HPAScaleToZero gate) / maxReplicas:0 (rejected outright) — so
     #    DELETE the HPA first (recorded above), then scale the writer tiers to 0.
     #    `--ignore-not-found` because an install with autoscaling off has no HPA
     #    and a NotFound here would abort a fence that is otherwise fine; unlike
     #    `scale`, `delete` really does take that flag.
     kubectl -n "$NS" delete hpa <release>-functions --ignore-not-found

     # ONE enumeration for every writer, by NAME. Three separate holes are being
     # closed here and they were all the same shape -- `kubectl scale -l
     # <selector>` prints "No resources found" and exits 0 when nothing matches:
     #   * `for c in rest auth storage` scaled by exact component label, so a
     #     label change skipped a tier without failing.
     #   * `scale statefulset -l component=realtime` skipped realtime the same way.
     #   * the previous `-l app.kubernetes.io/name=pawtograder` selector matched
     #     NOTHING at all on an install with `nameOverride` set, because
     #     `pawtograder.name` stamps the override into that label.
     # Selecting on app.kubernetes.io/INSTANCE (the release name, which nothing
     # overrides) and filtering by component regex covers the stable web and edge
     # tiers, the background-worker tier (component=functions-workers) and every
     # per-course channel (functions-<channel>, web-<channel>) in one pass. The
     # regex is what keeps this from being the whole-release selector: it excludes
     # `maintenance` (the page you are about to serve), `kong`, `postgres` and
     # `supavisor`.
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

     # 3. WAIT for the writers to actually be gone, and wait LONG ENOUGH.
     #    `kubectl scale` only writes `.spec.replicas`; termination is
     #    asynchronous, so a "fenced" writer keeps committing until its pod
     #    actually exits — including a worker draining pgmq into the primary you
     #    are about to bounce.
     #
     #    480s is DERIVED from the chart. The edge tier dominates every other
     #    fenced component (realtime is next at 60s):
     #        preStopSleepSeconds        10s
     #      + gracefulExitTimeoutSeconds 410s  (>= worker.timeoutMs 400s)
     #      = 420s of intended drain
     #        terminationGracePeriodSeconds 430s  kubelet SIGKILL backstop, the
     #                                            hard ceiling on a pod's life
     #      + ~50s  container teardown and the pod object leaving the API
     #      = 480s
     #    This wait was 300s, below the graceful window ALONE: a worker running a
     #    long batch outlived it legitimately, and the timeout read as "slow"
     #    rather than "still writing". Re-derive if your overlay raises any of the
     #    three values (charts/pawtograder/values.yaml, under `edgeFunctions`).
     PODS="$(kubectl -n "$NS" get pod -l "app.kubernetes.io/instance=<release>" -o jsonpath="$jp" \
       | awk '$1 ~ /^(web|rest|auth|storage|functions|realtime)(-.+)?$/ { print "pod/" $2 }')"
     # By NAME, not `-l`: `kubectl wait -l <selector>` exits non-zero with "no
     # matching resources found" when nothing matches, which is the NORMAL state
     # here once the pods are already gone — and a step that fails when everything
     # is correct is a step that gets skipped next time.
     if [ -n "$PODS" ]; then
       # shellcheck disable=SC2086
       if ! kubectl -n "$NS" wait --for=delete $PODS --timeout=480s; then
         echo "STOP: writer pods are STILL PRESENT after the full 480s drain window." >&2
         echo "They can still be committing. Do NOT drain the node. Investigate with" >&2
         echo "  kubectl -n \"$NS\" get pod -l app.kubernetes.io/instance=<release>" >&2
         exit 1
       fi
     fi
     echo "FENCED: pg_cron is paused and every writer pod is gone."
   )
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
   # HARD GATE, chained with `&&`: the drain CANNOT start unless the assertion
   # exits 0. Draining the primary's node while a writer is still committing is
   # the failure this whole procedure is built to avoid, and the gap between the
   # fence and this step is however long steps 2 and 3 took -- long enough for a
   # `helm upgrade`, an HPA, or a controller reconcile to put pods back.
   #
   # pg_cron is checked too: it is fenced by a DB update rather than by a scale,
   # so it is the one writer that can come back without a pod appearing.
   fenced() {
     local jp pods left crons
     jp='{range .items[*]}{.metadata.labels.app\.kubernetes\.io/component}{" "}{.metadata.name}{"\n"}{end}'
     # Take kubectl's EXIT STATUS, not just its output. A failed `get pod` -- an
     # expired token, the wrong context, a `get`-scoped role, a transient API 5xx --
     # writes nothing to stdout, so `awk ... END { print n+0 }` still prints 0 and
     # this gate reported "fence verified" and ran the command below. It failed
     # OPEN, onto a destructive step, which is the one direction a fence must never
     # fail. "I could not tell" is not "nothing is running".
     if ! pods="$(kubectl -n "$NS" get pod -l "app.kubernetes.io/instance=<release>" -o jsonpath="$jp")"; then
       echo "NOT FENCED: could not list pods (RBAC, expired credentials, or an API error) -- refusing to drain." >&2
       return 1
     fi
     left="$(printf '%s\n' "$pods" \
       | awk '$1 ~ /^(web|rest|auth|storage|functions|realtime)(-.+)?$/ { n++ } END { print n+0 }')"
     if [ "$left" -ne 0 ]; then
       echo "NOT FENCED: $left writer pod(s) still present -- refusing to drain." >&2
       return 1
     fi
     crons="$(kubectl -n "$NS" exec <release>-postgres-0 -c postgres -- psql -U supabase_admin \
       -d postgres -tAc "SELECT count(*) FROM cron.job WHERE active;" | tr -d '[:space:]')"
     if [ "$crons" != "0" ]; then
       echo "NOT FENCED: $crons pg_cron job(s) active -- refusing to drain." >&2
       return 1
     fi
     echo "fence verified: no writer pods, no active pg_cron jobs"
   }

   fenced && kubectl drain <node> --ignore-daemonsets --delete-emptydir-data
   ```

   With the postgres PDB and preStop fast-shutdown in place, the primary evicts,
   reschedules onto another schedulable node, reattaches its PVC, and restarts as
   the same primary. If the drain _hangs_ on the postgres pod, the PDB is not
   enabled in this environment — see [above](#what-makes-the-bounce-safe-and-cheap);
   do **not** force-delete the pod as a habit.

   > **If the drain hangs on `<release>-functions-workers` instead.** The
   > background-worker tier (`edgeFunctions.workerTier`, disabled in the chart
   > default and enabled by environment overlay — staging here, and production
   > through the separate `prod-charts` repo) gets a `minAvailable: 1` PDB, and
   > unlike the Postgres case that shape is
   > correct — it is a 2-pod tier and losing both at once stops pgmq draining for
   > all four routed functions. But at 2 replicas it allows exactly one
   > disruption, so if **one pod is already unhealthy** the budget is exhausted
   > and the eviction API refuses forever. A memory-budget mistake is the usual
   > way in: the tier's limit and its four-term sum are checked at render, but a
   > pod that OOM-kills in a loop is `Running`/not-`Ready`, which spends the
   > budget without ever releasing it.
   >
   > Note the PDB renders **only at 2 or more replicas** (at 1 it is omitted, for
   > the same reason Postgres uses `maxUnavailable`), and the tier's
   > anti-affinity is `preferred`, not `required` — so on a 3-worker-node cluster
   > both pods can and do land on one node, and draining that node needs the
   > budget it cannot get.
   >
   > The unblock is to **un-split**, not to delete the PDB:
   >
   > ```bash
   > helm upgrade <release> <chart> -n "$NS" --reuse-values \
   >   --set edgeFunctions.workerTier.enabled=false
   > ```
   >
   > That removes the PDB, the Deployment **and** the Kong routes in one release,
   > which is what makes it safe: the four functions return to the request tier
   > and keep being served, so the drain proceeds with nothing degraded. Deleting
   > the PDB by hand instead leaves the Deployment and the routes in place, so the
   > drain evicts both worker pods and the four functions 502 until they
   > reschedule — and it leaves the cluster in a state the chart will recreate on
   > the next `helm upgrade`, so the next drain hangs the same way with no record
   > of why. Re-enable after the node is back.
   >
   > `replicas: 0` is not an alternative: the chart refuses it, because it would
   > leave Kong routing those four names at a Service with no endpoints while
   > suppressing both the PDB and the availability alert.
   >
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
