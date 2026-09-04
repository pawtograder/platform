# Metrics gap remediation — tracking doc

**Status:** WS-LEADER and WS-EDGE (with the WS-DASH edge dashboards) implemented
on `metrics-pr0-cleanup` (chart 0.3.18, gates off). WS-APP still to write.
Nothing deployed.
**Opened:** 2026-09-03
**Scope:** platform (chart, app, edge image, migrations) + prod-charts (values, deploy)
**Target:** Khoury production, namespace `pawtograder-prod`

Two Grafana dashboards render empty in Khoury prod. This doc consolidates the
diagnosis, the four workstreams that fix it, the decisions already made, and the
staged runbook for landing it.

---

## 1. Diagnosis

Everything below was verified against the live cluster and the repos on
2026-09-03. The scrape path is **healthy**; the problem is missing producers.

### `edge-functions` dashboard — completely dark

Every headline panel queries `deno_http_requests_total`,
`deno_http_request_duration_seconds_bucket`, or `edge_runtime_workers_active`.
**Nothing in the stack emits these.** Those names appear only in the dashboard
JSON and in two comments that falsely assert the edge runtime serves them
(`charts/pawtograder/templates/monitoring.yaml:610`,
`charts/pawtograder/images/edge-functions/main.ts:70`).

What actually happens: the `edge-functions` ServiceMonitor scrapes `path:
/metrics` on the http port; `main.ts` routes that like any other function to
`supabase/functions/metrics/index.ts`, which emits only `pawtograder_*` series.
That is why `queues-and-workers` is green off the _same scrape target_ while
this dashboard is empty.

### `app-business` dashboard — two tiles only

The two working tiles (**Real classes**, **Active submissions**) are
`pawtograder_*` series from the **postgres_exporter custom queries** in
`charts/pawtograder/templates/monitoring.yaml:439,456`. Everything else is
`web_*`, dead for two independent reasons:

1. **The business counters are declared but never incremented.** `lib/metrics.ts`
   defines them; the only files importing `@/lib/metrics` are
   `app/api/metrics/route.ts` and `app/api/llm-hint/route.ts` (the latter uses
   only `timeHttp`). No call site ever increments them, so prom-client never
   registers a series.
2. **The workflow family is gated off.** `web_workflow_runs_recent` and friends
   are populated only by `refreshWorkflowMetrics()`, gated on
   `METRICS_WORKFLOW_REFRESH_LEADER`. Chart default is `false`; prod does not
   override it. Confirmed absent from the live `pawtograder-web` Deployment.

**Help queue depth** is a third case: postgres_exporter-backed but filtered to
`created_at > NOW() - INTERVAL '24 hours'`, so "No data" there is an honest zero.

### Root cause, stated plainly

Both dashboards were authored ahead of the instrumentation. They promise data the
system was never wired to produce.

---

## 2. Environment facts that contradict the chart's own comments

The chart's comments consistently describe a kube-prometheus-stack deployment
that Khoury does not run. Verified reality:

| Fact                     | Detail                                                                                                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scraper                  | **Grafana Alloy** in the `monitoring` namespace, not kube-prometheus-stack                                                                                                                                              |
| ServiceMonitor discovery | Alloy's `prometheus.operator.servicemonitors` has **no selector block** — it picks up every ServiceMonitor cluster-wide. A new ServiceMonitor needs no labels to be discovered.                                         |
| Dashboard delivery       | The sidecar **does** consume `grafana_dashboard: "1"` ConfigMaps. All eight are present in `pawtograder-prod`. The prod-charts README lists this as "still needed from ops" — stale.                                    |
| Registry                 | **Harbor** (`dev-harbor.khoury.northeastern.edu`). The prod-charts README says ghcr.io — stale. ghcr.io is the staging path.                                                                                            |
| Namespace                | `pawtograder-prod` (not `pawtograder`)                                                                                                                                                                                  |
| Migration runner         | `charts/pawtograder/images/migrations/migrate.sh:303` applies each file under `psql --single-transaction`. **`CREATE INDEX CONCURRENTLY` cannot be used** — it aborts the Job and fails `helm upgrade --wait-for-jobs`. |
| Secrets                  | `METRICS_SCRAPE_TOKEN` (64B) present in `pawtograder-jwt`; `METRICS_TOKEN` (64B) present in `pawtograder-edge-functions`. Both endpoints are authenticated.                                                             |

---

## 3. Standalone finding — fix separately

**The canary channel exports zero metrics.** Channel pods carry
`app.kubernetes.io/component: web-canary`; the web ServiceMonitor selects
`component: web` exactly. Same for `functions-<channel>`. Class 636's web tier has
been unobservable for as long as the channel has existed — no scrape target, so
no alert fires if a canary pod crash-loops.

**Do not fix this inside the main effort.** A newly-appearing target would
contaminate the "exactly one target exports the workflow gauges" acceptance
check. Ship it as a separate small chart PR (add a channel ServiceMonitor, or
widen the selector with `matchExpressions`).

This also means **deployment channels cannot validate any metrics change** — see
§6.

---

## 4. Workstreams

### WS-LEADER — dedicated metrics-leader Deployment

Populates the 9 workflow panels on `app-business`.

- New `templates/web-metrics-leader.yaml`: 1 replica, component
  `metrics-leader`, `strategy: Recreate` (RollingUpdate briefly runs two leaders
  = 2x DB load + duplicated gauges).
- Refactor `_web-workload.tpl` to take a `config` arg so the leader reuses the
  exact same pod shape. `web.yaml` and `web-channels.yaml` pass no `config` and
  must render **byte-identical**.
- Its own Service + ServiceMonitor on `component: metrics-leader`. Every selector
  was traced: the leader is excluded from the web Service endpoints, the ingress
  backend, the existing web ServiceMonitor, the ingress-controller NetworkPolicy,
  the PDB, web anti-affinity, and the `helm test` smoke job — and included in
  `allow-monitoring`. It cannot serve user traffic.
- **No metric relabeling needed.** A prom-client labelled gauge that was never
  `.set()` emits zero samples, so non-leader pods contribute nothing to `sum()`
  by construction.
- App-side refresh throttle in `lib/metrics.ts`
  (`METRICS_WORKFLOW_REFRESH_INTERVAL_SECONDS`, default 300). This is the only
  bound that survives a second Prometheus or a manual `curl` loop.
- **DB migration: two partial indexes on `public.workflow_runs`**
  (`completed_at`, `in_progress_at`). Verified missing; all three workflow RPCs
  are currently seq scans. Without these, the leader is the `76ca0bb8` pathology
  (77.7% of DB exec time) at 1/32 scale.
- Four new `validations.yaml` rules. Note `validations.yaml:25` **already**
  hard-fails `workflowMetricsLeader=true` + `replicas>1`, so the original
  triple-counting concern was never reachable.
- Chart bump to 0.3.18.

**Gate:** `web.metricsLeader.enabled`, default `false`.

**As shipped** (2026-09-04, branch `metrics-pr0-cleanup`), differing from or
adding to the plan above:

- `web.workflowMetricsLeader` is **kept, not deprecated**. On a 1-replica install
  it is strictly better than a dedicated leader — no extra pod, and already
  guarded — so the two mechanisms coexist and the chart refuses both at once.
- The `refreshIntervalSeconds` env var renders **only when the caller passes the
  key**, using a `kindIs "invalid"` test rather than `with`. Two reasons: `with`
  would swallow a deliberate `0` (which disables the throttle for tests), and
  `web.yaml` passing nothing is what keeps its render byte-identical.
- Emitted `#` comments in `_web-workload.tpl` were left at their pre-refactor
  wording. Helm keeps template comments in the rendered manifest, so rewording
  one _is_ a render diff. The new explanation lives in the `{{/* */}}` header,
  which is not emitted.
- The migration uses plain `CREATE INDEX IF NOT EXISTS` (not `CONCURRENTLY` —
  see §2) with a header explaining the `ACCESS EXCLUSIVE` lock and the
  create-by-hand-first escape route.
- Two alert rules, not one: `PawtograderWorkflowMetricsRefreshFailing`
  (`rate(web_workflow_metrics_refresh_errors_total[15m]) > 0`) covers "refreshes
  are failing"; `PawtograderWorkflowMetricsStale`
  (`absent(web_workflow_runs_recent)`, gated on the leader being enabled) covers
  the different failure of "nothing is scraping the leader at all".
- Rule 4 forced a values change in three shipped example overlays:
  `values-prod.yaml` and `values-prod-noeso.yaml` now enable the dedicated leader
  (the recommended answer at `replicas: 3`), and `values-staging.yaml` enables it
  because staging is where this path gets exercised first. `values-preview.yaml`
  already sets `workflowMetricsLeader: true` on one replica and needed nothing;
  `values-tartangrader.yaml` is a branding-only overlay layered on staging and
  needed nothing.
- Gate 1's byte-identity check is wired into
  `charts/pawtograder/tests/render-guardrails.sh` as
  `assert_web_render_unchanged`, which renders both templates from the chart at
  the merge base and from the working tree against every consumer values file
  (including `prod-charts/values/values-prod.yaml` when that checkout is present,
  both as-is and with the leader enabled) and requires `cmp` equality. As of
  implementation: **18 renders compared, zero differences.**
- One normalization is applied before that comparison, and it matters: the
  `helm.sh/chart: pawtograder-<version>` label. It is on every manifest and it
  changes by construction on every chart bump — meaning **a chart-version bump
  alone already rolls every Deployment in this chart**, independent of anything
  in this effort. Comparing that label would make the assertion fail on the
  version bump and never on the template change it exists to catch. Nothing else
  is normalized: emitted `#` comments and whitespace are compared byte for byte.

### WS-APP — business metrics move to postgres_exporter

Originally scoped as "instrument the `web_*` counters." That approach is largely
**not viable**: this app has two `"use server"` files, both auth-only. Business
writes go browser → PostgREST directly, and 32 of 37 `lib/edgeFunctions`
importers are `"use client"`. The web tier is the wrong producer.

- `app-business.json` queries only two `web_*` non-workflow series:
  `web_submission_created_total` and `web_grading_action_total`. Move both to
  **postgres_exporter custom queries** in `monitoring.yaml`, modelled on the
  existing `pawtograder_active_submissions` block. Rename panels to match.
- **Delete** five orphan declarations from `lib/metrics.ts`:
  `web_submission_mutated_total`, `web_rubric_check_action_total`,
  `web_office_hours_event_total`, `web_realtime_broadcast_total`,
  `web_edge_function_invocation_total`. Replace with a comment naming the
  correct producer for each. **Correction (PR-0):** the earlier note that "none
  backs any panel" was wrong — `realtime-fanout.json` panels 3 and 11 both query
  `web_realtime_broadcast_total`. They have always read empty, since the counter
  was never incremented. PR-0 leaves the panels in place and marks their
  descriptions; retargeting them at the trigger-side exporter query is WS-APP
  work.
- **Keep and instrument** `web_http_*` (19 Node route handlers, via a
  `withRouteMetrics` wrapper) and `web_supabase_rpc_*` (the SSR boundary in
  `lib/ssrUtils.ts`, `lib/ssr-course-dashboard.ts`). Both need new dashboard
  panels — none exist today.
- Eager registry init in `instrumentation.ts` `register()` under the
  `NEXT_RUNTIME === "nodejs"` branch.

**Hard constraints:**

- `middleware.ts` runs on the **Edge runtime** and cannot use prom-client.
- The `route` label must be the parameterized pattern, never `nextUrl.pathname`.
- `web_supabase_rpc_errors_total`'s `code` must be a SQLSTATE or `"throw"`,
  never `error.message` — normalize anything not matching `/^[0-9A-Z]{5}$/`.
- **CI guard:** after build, `grep -rl "prom-client" .next/static/chunks/` must
  return nothing. Instrumenting `invokeEdgeFunction` would have pulled
  prom-client into the client bundle via the dynamic import, `isNode()` guard
  notwithstanding.

**Open cost question:** a scrape-interval `COUNT(*)` over the comment tables is a
seq scan. Preference order: (1) `cache_seconds: 300` on the exporter blocks;
(2) a trigger-maintained counter table; (3) windowed gauges. Measure with
`EXPLAIN ANALYZE` on the replica first; if over ~100ms, go to (2).

### WS-EDGE — per-function metrics producer

- **`main.ts` intercepts `/metrics` and appends its own series to the metrics
  function's 200 response.** Auth is inherited for free (`METRICS_TOKEN` stays
  enforced by the user worker; append only on 200). Blast radius is one
  `try/catch` — if rendering throws, the untouched response passes through and
  the queues dashboard cannot break.
- **The 500 path must stay a 500.** `prometheus-rules.yaml:222` documents that
  `PawtograderPostgresUnavailable` exists _because_ the metrics function returns
  500 when its first DB RPC fails. Do not "improve" this into a partial 200 — it
  would silently weaken a critical page.
- `edge_runtime_workers_active` needs no hand-rolling:
  `EdgeRuntime.getRuntimeMetrics()` is installed only on the main worker (where
  `main.ts` runs) and returns `activeUserWorkersCount`.
- **A separate metrics port is impossible**, not merely awkward. In edge-runtime
  v1.74.0 `Deno.listen` is a documented no-op and `Deno.serve` hardcodes port
  9999 regardless of arguments; a second `Deno.serve` would race the first
  handler for the same connection receiver.
- **Redis-backed collection rejected**: a Redis counter is global, so 32 pods
  report identical values and `sum(rate(...))` over-counts 32x — plus hot-path
  I/O against the store coordinating GitHub rate limiting, plus dragging
  `ioredis` into the pod-lifetime main isolate.

**Security constraint — the critical one.** `serviceName` is attacker-controlled
(`main.ts:364` accepts any `[a-zA-Z0-9_-]+`, and `/functions/v1/*` is publicly
routed by Kong). Keying a map on it verbatim is an unbounded, remotely-driven
`Map` in the pod-lifetime main isolate — structurally the eszip leak again, plus
a cardinality bomb. **Bound it with a closed allowlist** read from `ESZIP_DIR` at
boot; anything else records as `function="_unknown"`.

> **DECIDED 2026-09-03: no per-function latency quantiles.** Adding `function` to
> the histogram takes the edge tier from ~8.6k to ~37k series, and every one is
> per-pod, so an HPA excursion to 64 replicas doubles it at exactly the moment of
> load. Per-function _counts_ and `rate(seconds_total)/rate(requests_total)`
> (mean latency, and share of total time spent) answer "which function is the
> problem" well enough. **Do not ship the `perFunctionLatency` values flag** —
> an unused flag is an invitation.

**As shipped** (2026-09-04, branch `metrics-pr0-cleanup`, chart 0.3.18 — no
further bump; WS-LEADER already moved it):

- `EdgeRuntime.getRuntimeMetrics()` **verified present** on the pinned
  `supabase/edge-runtime:v1.74.0` by running the image: `Object.keys(EdgeRuntime)`
  is `ai, userWorkers, getRuntimeMetrics, applySupabaseTag, systemMemoryInfo,
raiseSegfault, miCollect, scheduleTermination`, and the call returns exactly the
  documented shape (`mainWorkerHeapStats`, `eventWorkerHeapStats`,
  `activeUserWorkersCount`, `retiredUserWorkersCount`, `receivedRequestsCount`,
  `handledRequestsCount`). Heap fields are `usedHeapSize` / `totalHeapSize` /
  `externalMemory`, which is what `stat=` maps onto. It is guarded by a 1s
  `Promise.race` — a scrape must never hang on it, so a timeout drops the runtime
  gauges for that scrape and emits the counters anyway.
- **The allowlist reads BOTH directories, not just `ESZIP_DIR`.** A function
  shipped without a bundle still runs (main.ts falls back to raw `servicePath`),
  so `/home/deno/functions` is read as well; otherwise such a function would
  report as `_unknown` and the label would be wrong rather than merely bounded.
  Both reads are synchronous and happen before `Deno.serve()` accepts anything.
- The invariant comment sits directly under the eszip-leak note, because the
  contrast is the point: that map's keys were function names too, but its values
  were 19-59MB buffers and its key set was request-driven. Here the values are
  fixed-size `Float64Array`s plus a status map capped at 32, and the key set is
  closed at image-build time.
- Metrics landed as planned, plus two the plan did not name:
  `pawtograder_edge_eszip_cold_bytes` and `_cold_queue_depth`. Both are free
  (`coldBytes` and `coldQueue.length` already exist) and they instrument the one
  term of the container memory budget that has never been observable — a
  sustained non-zero queue depth means `eszipColdLoadHeadroomMb` is undersized,
  which today is only visible as latency.
- `EDGE_METRICS_BUCKETS` is validated the way `byteBudget()` validates its
  inputs: non-finite, non-positive or non-monotonic rejects loudly and falls back
  to the default, because `histogram_quantile()` over a non-monotonic bucket set
  returns plausible garbage rather than failing.
- Hot path adds no second `Date.now()` — the elapsed value the access log already
  computes is reused. Steady state is allocation-free: every accumulator is
  pre-allocated at boot.
- **Time to headers, not full response time**, stated in the `# HELP` string.
  `worker.fetch()` resolves when headers are ready; capturing end-of-body needs a
  per-request `TransformStream`, which allocates on the hot path and perturbs the
  stream pass-through `main.ts` warns about.
- **Verified end to end against the real image**, not just rendered: an
  unauthorized scrape returns 401 with nothing appended; a forced 500 returns 500
  with nothing appended; `EDGE_METRICS` unset emits no `pawtograder_edge_*` at
  all; a request for an unknown path segment records as `function="_unknown"`; and
  a malformed `EDGE_METRICS_BUCKETS` logs the rejection and falls back.
- **Landed cardinality: ~270 series/pod**, i.e. **~8.6k at 32 replicas**, ~22k
  ceiling — the budget above, unchanged. The arithmetic is written out in
  `values.yaml` next to the gate, with the warning that it is per-pod and doubles
  when the HPA doubles.
- **Gate: `edgeFunctions.metrics.enabled`, default `false`**, rendered as the
  `EDGE_METRICS` env var (runtime, not build-time). `values-staging.yaml` sets it
  `true`. `render-guardrails.sh` asserts the gate renders 0/1 correctly, that
  `EDGE_METRICS_BUCKETS` is strictly increasing, and that its top finite bucket is
  `>= worker.timeoutMs/1000` — with a negative case (`timeoutMs=900000` against
  the default buckets) proving the assertion actually fires.
- The ~85KB collector does not move the memory budget; it is recorded in the
  `_edge-functions-workload.tpl` inventory comment as absorbed by the ~90Mi host
  term rather than added as a line, so the next person reconciling that sum finds
  it accounted for.
- **No CI Deno type-check covers this file.** `npm run typecheck:functions` and
  the `deno-unit-tests` job both scope to `supabase/functions/`;
  `charts/pawtograder/images/edge-functions/main.ts` is outside both. It was
  checked by hand with `deno check` under `lib: [deno.window, dom, esnext]` —
  clean, and clean on the pre-change file too. Without that lib setting the file
  reports 17 errors before the change and 24 after, all of them cascades from
  `Deno` being unresolvable; that is a missing lib, not a regression.

**Also required:** fix the two false comments (`monitoring.yaml:610`,
`main.ts:70`), and extend the SCOPE block in
`supabase/functions/metrics/index.ts` to say the edge tier's own series are
appended by the demuxer and must not be reimplemented there. **Done** — the
SCOPE block now also explains _why_ a user worker cannot produce them
(`getRuntimeMetrics()` is main-worker only; the eszip cache and the request loop
are not visible from an isolate), which is the part that stops someone
reimplementing them anyway.

### WS-DASH — dashboard fixes

- **`edge-functions.json:68` still ships `pawtograder-staging` as the
  `$namespace` default.** The Grafana-UI fix applied on 2026-09-03 lives only in
  Grafana's DB and will be overwritten by the next chart deploy that touches this
  ConfigMap — which the WS-EDGE rewrite guarantees. **Fix it in the repo JSON.**
- Note `$namespace` is declared as a **Loki** query variable being interpolated
  into Prometheus kube-state-metrics queries. It works only because both label
  sets happen to contain the namespace string.
- Delete the "Web app's calls to edge functions" panel
  (`web_edge_function_invocation_total`). Panel 10 supersedes it and is strictly
  better — the demuxer sees 100% of invocations, the web tier ~1%.
- Add `pawtograder_edge_eszip_cache_bytes` and
  `pawtograder_edge_main_worker_heap_bytes{stat="used"}` to the memory panel,
  decomposing working set into cache vs main-isolate heap vs isolates.

**As shipped** (2026-09-04). `edge-functions.json` was rewritten onto the
`pawtograder_edge_*` names: the `$fn` variable, invocations, error rate, top
errors and per-function invocations move over directly; P95 latency **drops its
`{function=~"$fn"}` selector** (the label does not exist and the panel would go
blank) and says so in its description; panel 11 becomes "Mean latency by
function" plus "Time spent per function", keeping the p50/p95/p99 expressions in
its description for anyone who later adds the label deliberately; a new "Worker
retirements & demuxer errors" panel fills the slot PR-0 freed. `gridPos.y` was
re-flowed — 13 panels, contiguous, no overlaps or gaps. PR-0's `includeAll: true`
/ `current = All` `$namespace` fix and its seven `=~` matchers are preserved.

Both dashboard bugs PR-0 left open are **RESOLVED**:

1. **`edge-soak.json`'s `ns` variable** hard-coded `"pawtograder-staging"` as its
   `current` with `includeAll: false` — the identical prod-renders-empty bug.
   Fixed to the `postgres-deep-dive.json` convention (`includeAll: true`,
   `current = All`/`$__all`, `regex: pawtograder.*`, `sort: 1`). It **did** hit
   the trap PR-0 warned about: every one of its matchers used `=`, which matches
   nothing against `$__all`. All 16 were flipped to `=~`, including the Loki
   stream selectors.
2. **`edge-functions.json`'s `$namespace` was a Loki query variable** feeding
   seven Prometheus kube-state-metrics expressions. It now queries the
   **Prometheus** datasource (`label_values(kube_pod_info, namespace)`, regex
   `pawtograder.*`), matching `postgres-deep-dive.json`. The `loki` **datasource**
   variable stays for the logs panel, which still interpolates `$namespace` —
   that direction is safe, because the value list no longer depends on Loki's
   label cardinality. The variable carries a description recording why.

---

## 5. PR structure

**One PR.** This was originally scoped as four (PR-0 cleanup, then one per
workstream, each with its own chart version). PR-0 has already landed as a
commit; everything remaining ships together.

| Contents                                                                                                                                                                                                                                                                                                      | Chart  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| WS-LEADER (`_web-workload.tpl` refactor, leader Deployment + Service + ServiceMonitor, 4 validations, refresh throttle, two partial indexes, alert rules), WS-APP (exporter queries, panel renames, `web_http_*` / `web_supabase_rpc_*` wiring + new panels), WS-EDGE (producer + dashboard rewrite), WS-DASH | 0.3.18 |

### Why one PR and not four

Each of the three arguments for splitting turned out to be weaker than it looked:

- **Reviewer attention.** The original note said "do not merge PR-1 and PR-3
  together; reviewing them together guarantees one gets less attention than it
  needs." That reasoning holds for a review queue with several reviewers and a
  cost to context-switching. Here there is one reviewer who has the whole design
  in their head already. Splitting does not buy more attention; it buys four
  smaller context reloads.

- **Independent rollback.** This is the real requirement, and PR boundaries were
  never what satisfied it — the **values gates** are. One chart version plus
  three gate flips is a _better_ rollback story than three chart versions,
  because reverting a gate is a values edit in prod-charts, while reverting a
  chart version is a chart re-pull plus a version bump plus a deploy. The
  finest-grained, fastest rollback available is `web.metricsLeader.enabled:
false`, and that exists regardless of how the code was merged.

- **Blast-radius separation.** Still true, and still handled — by the gates and
  by the staged flip order in §7, not by the PR count. The two highest-risk items
  (`_web-workload.tpl` and the edge-runtime memory path) remain independent at
  deploy time even though they share a commit range.

Against that, splitting has a concrete cost that only became visible once load
generation was settled as **manual** (§10): Gate 4 is a coordinated human
session, run _while_ load is being driven. Four PRs means four of those sessions
rather than one, on four separate staging deploys, with the same person driving
each. That is the dominant cost in this plan and it scales linearly with the PR
count.

### What that changes about the gates

**Gate 1's byte-identity check becomes BLOCKING, not advisory.** In the four-PR
structure the `_web-workload.tpl` refactor was one item among several in a PR
that would get its own review pass. In a single PR it is the **only ungated
item** — everything else in this effort sits behind a values gate defaulting off,
so on the deploy that ships this chart, the refactor is the sole thing that can
change a running workload. If `web.yaml` or `web-channels.yaml` render even one
byte differently, a deploy advertised as purely additive performs a full rolling
restart of three prod web replicas plus the live canary. The check therefore runs
in CI (`charts/pawtograder/tests/render-guardrails.sh`, invoked by
`.github/workflows/lint.yml`) and a diff fails the build. It is not something to
eyeball once and move on from.

The remaining gates are unchanged in content; they are now flips of one chart
version rather than deploys of successive ones.

### prod-charts

**No prod-charts change lands until all platform work is done and validated on
staging.** The two repos are not merged into one change: the platform PR ships
the chart and the gates (all off), and only afterwards does prod-charts bump
`chart_version` and set the values that turn things on. The one hard ordering
constraint is §10's: the prod-charts commit that moves to 0.3.18 must set either
`web.metricsLeader.enabled: true` or `monitoring.allowMissingWorkflowMetrics:
true` in the _same_ commit, because rule 4 is a render-time `fail` — the deploy
is refused, not degraded, and that includes the rollback deploy.

## 6. There is no shadow prod

The originally requested "shadow prod deploy on a chart pinned to a build of the
platform PR" **is not available for this change.** Three independent blockers:

1. **Channel pods are not scraped** (§3). A perfect canary build produces zero
   series. Validating a metrics change there would first require shipping a
   chart change — the thing you were trying to de-risk.
2. **`build-images.yml` skips the edge-functions build whenever `channel` is
   non-empty**, so WS-EDGE cannot ride a channel in prod at all. (Staging's
   `release-images.yml` _does_ build channel edge images — a real asymmetry.)
3. **A channel carries no chart-level change.** The leader Deployment, the
   ServiceMonitor, the validations, the exporter queries and the dashboard
   ConfigMaps are all release-wide.

**Strategy instead: ship dark, flip gates one at a time.** Land everything behind
values gates defaulting off, deploy to prod (proving the new image and chart are
inert), then enable one workstream per deploy, each with a values-only rollback —
no rebuild, no image revert.

| Stage                    | Proves                                                                 |
| ------------------------ | ---------------------------------------------------------------------- |
| Local render diff        | The refactor is a no-op for existing workloads                         |
| Replica `EXPLAIN`        | The workflow RPCs aren't seq scans (expect failure pre-index)          |
| Staging + load           | Shape, names, labels, scrape wiring, dashboards, no OOM at small scale |
| Prod `dry_run`           | `values-prod.yaml` renders under the new chart                         |
| Prod deploy, gates OFF   | Rollout safety of the image/chart alone                                |
| Flip gates one at a time | The actual data criteria, with single-variable attribution             |

**Staging's weakness, stated honestly:** an idle staging makes "the gauge exists
with value 0" indistinguishable from "the family never registered" — a Prometheus
series only exists once `set()` is called at least once. Seed `workflow_runs`
rows across ≥2 classes and ≥3 conclusions, drive traffic through several edge
functions, then **assert on label-set shape, not just non-emptiness**.

---

## 7. Staged runbook

### Pre-flight

- [ ] Record current state: chart `0.3.17`, images `main-20260828-a1664ddb`
      (maintenance `main-20260727-f9233a4c`), `web.replicas: 3`,
      `channels[0].web.image.tag: canary-725fa70b`. **This is the rollback pair —
      do not GC those Harbor tags.**
- [ ] Confirm the four `metrics_workflow_*` RPCs exist in the prod DB.
      `20260529190000_workflow_metrics_rpcs.sql` predates the deployed migrations
      tag so it is almost certainly applied — **check, don't assume**, or the
      leader ships and increments `web_workflow_metrics_refresh_errors_total`
      forever.
- [ ] Get the class count from the live `pawtograder_classes_real_classes`
      series. This is the multiplier for every cardinality budget.
- [ ] Confirm `platform/Dockerfile` still contains the literal
      `--max-old-space-size=8000`. `build-images.yml` patches that exact string
      and **hard-fails if it moves**.
- [ ] Confirm class 636 is still pinned to `canary` and that tag is still
      pullable — `--wait` blocks on channel pods, so a GC'd canary tag fails an
      otherwise healthy deploy.
- [ ] Pick a low-traffic window, not near an assignment deadline.
- [ ] Capture the baseline (§8.0).

### Gates

**Gate 1 — Rendered-manifest byte-identity (local, no cluster).** Render
`web.yaml` and `web-channels.yaml` from `main` and from the PR-1 branch against
`values-prod.yaml` and every other consumer values file, and diff. Pass = the
`pawtograder-web` and `pawtograder-web-canary` Deployments/Services are
byte-identical; only additions appear elsewhere. **Any diff means a full rolling
restart of 3 prod web replicas + canary on a supposedly additive deploy.** Wire
the assertion into `tests/render-guardrails.sh` so CI enforces it forever.

**Gate 2 — Validation matrix (local).** For each new rule, one combination that
must render and one that must fail — plus a render of the _unmodified current_
`values-prod.yaml`. You must know ahead of time whether that passes or fails, so
Gate 5 is a formality rather than a surprise.

**Gate 3 — Index / query-plan proof (needs DB access).** `EXPLAIN (ANALYZE,
BUFFERS)` the three workflow RPCs against the **prod streaming replica** (already
deployed, read-only — no need to stand up a shadow namespace). Pass = index scans
and total refresh well under the 10s scrape timeout; target <1s.
**Decide here:** `CREATE INDEX CONCURRENTLY` is unusable (§2). Either create
non-concurrently and accept an `ACCESS EXCLUSIVE` lock on `workflow_runs` for the
build duration, or create out-of-band by hand and make the migration
`CREATE INDEX IF NOT EXISTS`. **Prefer out-of-band if the measured build time
exceeds a few seconds** — `workflow_runs` is on the autograder hot path.

**Gate 4 — Staging with load.** Merge PR-1 to `staging`; it auto-deploys. Enable
the leader in `values-staging.yaml`, seed data, drive load **manually**, run §8
checks _while load is running_ — the `rate()`-based panels need a live window, so
this is a coordinated session rather than seed-and-walk-away.

Also fold in the Q3 experiment here: record `pawtograder-postgres-0`'s pod start
time, deploy a `queries.yaml`-only change, and check whether the pod restarted.
If it did, Gate 8 in prod is a scheduled off-peak DB blip. Record the answer in
§10.

**Gate 5 — Prod dry run.** Build images → pin all four tags → `Deploy
(production)`, `dry_run: true`. Pass = renders clean and the new validations do
not refuse the deploy.

**Gate 6 — Prod deploy, all gates OFF.** Pass = green inside 25m, `helm test`
green, target census unchanged, edge memory and replica count flat for 60 min,
`count({__name__=~"web_workflow_.*"})` still 0 (proving the gate works). Soak at
least one class-active day.

**Gate 7 — Flip the leader.** One value, one deploy. Pass = §8.1. Rollback =
flip back; a 1-replica Deployment serving no ingress traffic is the cheapest
rollback in the plan, which is exactly why it gets its own deploy.

**Gate 8 — WS-APP.** Different acceptance shape: postgres_exporter is a single
target, no pod multiplier, no dedup question. Series appear within one scrape or
they don't.

**Gate 9 — WS-EDGE.** Soak longest. The OOM history is a slow-leak,
burst-driven failure; a quiet soak proves little.

**Gate 10 — Dashboards.** The sidecar is confirmed working, so dashboard changes
propagate on the chart deploy that ships them.

---

## 8. Acceptance criteria — data, not pods

Runnable from Grafana Explore against the prod datasource. Direct Alloy
component-API access and port-forwards are **not** available under the working
kubeconfig's RBAC; anything needing more is marked `[OPS]`.

### 8.0 Baseline — capture before merging anything

- `count({namespace="pawtograder-prod"})` — the cardinality denominator
- `count by (__name__)({__name__=~"web_workflow_.*"})` — expect **empty**
- `count(count by (__name__)({__name__=~"pawtograder_.*"}))`
- `count(up{namespace="pawtograder-prod", job=~".*web.*"})` — expect 3 (canary
  excluded per §3). Later checks are "baseline + 1".
- `max by (pod)(container_memory_working_set_bytes{container="functions"})` and
  the edge HPA replica count — the OOM tripwire
- `sum by (job)(scrape_samples_scraped{namespace="pawtograder-prod"})`

Timestamp everything. Keep it in this doc, not a scratch file — it's the evidence
the change did what it claimed.

### 8.1 Leader

- `count(web_workflow_runs_recent) > 0`
- `count by (window)(...)` returns exactly `1h` and `24h`
- `count by (quantile)(web_workflow_queue_seconds)` = `{0.5, 0.95, 0.99}`;
  `web_workflow_run_seconds` = `{0.5, 0.95}`. **The asymmetry is intentional in
  `lib/metrics.ts` — verify it, don't "fix" it.**
- `increase(web_workflow_metrics_refresh_errors_total[30m]) == 0`
- **`count(count by (pod)(web_workflow_runs_recent)) == 1`**, sustained over
  10 min. Point reads can return 2 right after a leader restart while the old
  pod's series age out.
- `count(count by (pod)(web_http_request_duration_seconds_count)) == 4` (3 web +
  leader) while the workflow family is 1 — proves the leader is scraped and only
  the workflow family is singular.
- `count(up{...job=~".*web.*"})` == baseline + 1
- `web_workflow_metrics_refresh_seconds` p95 well under the 10s scrape timeout
- `[OPS]` `pg_stat_statements` share for `metrics_workflow_*` stays a rounding
  error. Compare against the `76ca0bb8` precedent (77.7%). Above ~1–2%, raise the
  refresh interval before doing anything else.

### 8.2 WS-APP

- New exporter series non-empty within 60s of rollout
- `count(count by (instance)(<new_metric>)) == 1` — always one exporter
- `PawtograderPostgresExporterQueryFailing` stays silent, **and** the
  `pawtograder_*` family count didn't shrink — a malformed `queries.yaml` entry
  can drop _other_ queries too
- `web_supabase_rpc_*` will be **sparse** given that business writes bypass the
  server. Decide the expected value before looking; sparseness is not failure.

### 8.3 WS-EDGE

- `count(count by (function)(<new_metric>))` ≤ the known function count (~55).
  Equal to the _total_ means it's emitting per known function rather than per
  _invoked_ function — a 32x multiplier.
- `count(count by (function, instance)(...))` **does not grow monotonically** over
  an hour. Monotonic growth = unbounded per-pod state = the OOM precursor.
- Edge working set within ~10% of baseline after 60 min; **zero** `OOMKilled`;
  HPA replica count not systematically higher. The memory HPA converts a leak
  into a replica-count climb _first_ — watch replicas as the early warning.
- Total added series within the ~8.6k budget.

### 8.4 Cardinality

Re-run §8.0 after each flip. Total namespace delta should be explainable to
within ~10%. Unexplained growth means a label you didn't intend. Above 25% over
budget, roll the gate back and find it — old series linger for the retention
period.

Also watch `scrape_duration_seconds` per target: a scrape that starts timing out
drops _everything_ from that target, which looks exactly like the bug being
fixed.

---

## 9. Rollback

**Universal (any stage):** set the four image tags back to
`main-20260828-a1664ddb` (maintenance `main-20260727-f9233a4c`), `chart_version`
back to `0.3.17`, run `Deploy (production)`. Both artifacts are in Harbor — no
rebuild, ~15 min.

- The two partial indexes are additive and ignored by old code → `rollback.md`
  §A (safe app-only). If WS-APP ships a counter table with triggers it becomes
  §B (schema stays forward) and the triggers must be inert to old code.
- Chart 0.3.17 ignores unknown values keys, so leaving the new gates in the file
  is harmless. Rolling _forward_ is where ordering bites: **never deploy 0.3.18
  without the value that satisfies the new validation rule.**

**Per workstream:** each gate flip is its own one-value, one-deploy rollback.
That is the entire justification for the staged structure.

**Deploy-timing hazard (mitigated 2026-09-04):** `deploy.yml` uses `--wait
--wait-for-jobs` and blocks on every Deployment including all ~32 edge pods.
`values-prod.yaml` records a 24-replica edge rollout taking ~12 min, which put
any edge-image change inside a rounding error of the old 15m budget. **The
timeout is now 25m.** A timeout still fails the job while the rollout is
mid-flight, so this is headroom, not a fix — schedule edge deploys accordingly.

---

## 10. Decisions made

| Decision                                  | Resolution                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| Build producers vs. trim dashboards       | **Build producers** (2026-09-03)                                                  |
| Per-function latency quantiles            | **No.** Do not ship the flag. (2026-09-03)                                        |
| Shadow prod deploy via canary channel     | **Not possible** — ship dark + flip gates (§6)                                    |
| Where the edge counter lives              | `main.ts` collects, intercepts `/metrics`, appends on 200                         |
| Leader scrape wiring                      | Distinct `component: metrics-leader` + its own ServiceMonitor                     |
| Most `web_*` business counters            | **Delete** — web tier is the wrong producer                                       |
| Fix canary-not-scraped                    | **Separately**, after this effort                                                 |
| Breaking validation rule                  | **Ship with an escape hatch** (2026-09-04)                                        |
| `values-tartangrader.yaml`                | **Update the example**; nobody is using it, so no deprecation period (2026-09-04) |
| Postgres restart on `queries.yaml` change | **Test in staging** rather than inferring from the render (2026-09-04)            |
| Deploy `--timeout`                        | **Raised 15m → 25m** (2026-09-04, `prod-charts/.github/workflows/deploy.yml`)     |
| Staging load generation                   | **Manual**, by Jon (2026-09-04)                                                   |
| Who runs the `[OPS]` checks               | **Jon + Claude together**, live during each gate (2026-09-04)                     |

### Resolutions, expanded

**Escape hatch (Q1).** The new "multi-replica + `monitoring.enabled` + no leader"
rule ships as a `fail` with `monitoring.allowMissingWorkflowMetrics: true` as the
acknowledgement, following the `studio.allowUnauthenticatedIngress` /
`monitoring.externalPostgresExporter` precedent already in `validations.yaml`.
**Ordering constraint:** the prod-charts commit that bumps `chart_version` to
0.3.18 must set either that key or `metricsLeader.enabled: true` in the _same_
commit. There is no "deploy inert" for a render-time `fail` — the deploy is
refused, not degraded. The `fail` message must name the exact value to set,
because whoever runs a rollback deploy at 2am will hit it.

**`values-tartangrader.yaml` (Q2).** Update it in PR-1 alongside the new
validation rules — set `monitoring.allowMissingWorkflowMetrics: true` (or enable
the leader) so the example still renders. No release-note deprecation period
needed. Audit `values-preview.yaml` and any other consumer values file in the
same pass.

**Postgres restart test (Q3).** Rather than inferring from a checksum annotation
in the rendered StatefulSet, verify empirically on staging during Gate 4: record
`pawtograder-postgres-0`'s pod start time, deploy a `queries.yaml`-only change,
and check whether it restarted. If it does, **every WS-APP deploy is a brief prod
DB blip** and Gate 8 must be scheduled off-peak. Record the answer here when
known.

**Load generation (Q5).** Manual. This means Gate 4's assertions must be run
_while_ load is being generated, not after — the counters are cumulative but the
`rate()`-based panels need a live window. Coordinate the timing rather than
seeding and walking away.

**`[OPS]` checks (Q6).** Run jointly. The kubeconfig in `prod-charts/` can read
pods, deployments, services, servicemonitors, configmaps, secret _metadata_, and
logs in `pawtograder-prod` — but **cannot** port-forward, exec, list namespaces,
or reach Alloy's component API. So: Grafana Explore for all PromQL, `kubectl` for
object state, and Jon for anything needing psql or port-forward.

## 11. Open questions

1. **Is `helm-diff` installed on the `pawtograder-infra-runner-set` runner?**
   Unknown. `dry_run` renders and validates but does not diff against live state.
   **Not blocking** — Gate 1's local two-version `helm template` diff covers the
   need that matters (proving the `_web-workload.tpl` refactor is a no-op), and
   it runs without cluster access. If the plugin turns out to be present, use it
   at Gate 5 as a bonus; if not, nothing in the plan changes. Cheapest way to
   find out is a `helm plugin list` line in the next workflow run.
