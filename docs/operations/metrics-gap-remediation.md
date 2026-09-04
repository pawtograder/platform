# Metrics gap remediation — tracking doc

**Status:** all four workstreams merged as #952 (chart 0.3.18) and deployed to
`pawtograder-staging` on 2026-09-04. Staging validation found two scrape
regressions, fixed on `fix/metrics-scrape-gzip-and-storage` (chart 0.3.19); see
§12. Prod gates still unflipped.
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
  **Revised after review:** a timestamp comparison alone is check-then-act. Two
  concurrent scrapes both read the old `lastWorkflowRefreshMs` before either
  pass finishes, and each launches all five aggregates — multiplying exactly the
  DB work the throttle exists to bound, under exactly the conditions (a second
  Prometheus, an overlapping curl loop, a refresh slower than the scrape
  interval) that motivate it. The refresh is now single-flight: the in-progress
  pass is stored on the global metrics bundle and concurrent callers `await` it.
  Semantics preserved — a failed pass still does not advance the timestamp, and
  the promise is cleared in a `finally` on both success and failure so one
  rejection cannot wedge every future refresh. `initIfNeeded()` needed the same
  treatment: it awaits a dynamic import before publishing the bundle, so two
  cold-start callers each built a whole registry and the second overwrote the
  first, leaving the two holding different bundles. Covered by two new cases in
  `tests/unit/metrics.test.ts`.
- **DB migration: two partial indexes on `public.workflow_runs`**
  (`completed_at`, `in_progress_at`). Verified missing; the three
  `workflow_runs`-backed RPCs (`metrics_workflow_runs_by_conclusion`,
  `metrics_workflow_queue_percentiles`, `metrics_workflow_run_percentiles`) are
  currently seq scans. The fourth RPC the leader calls,
  `metrics_workflow_errors_by_category`, reads `public.workflow_run_error`,
  whose `created_at` is already indexed (`idx_workflow_run_error_created_at`, 20250801174131) and needs no new index. Without these, the leader is the `76ca0bb8` pathology
  (77.7% of DB exec time) at 1/32 scale.
- **Revised after review: `web_workflow_errors_recent` no longer carries
  `workflow_run_error.name`.** That column is the student-visible sentence —
  free text, capped only at 500 characters by `workflow_run_error_name_length`,
  and `buildTooLargeErrorName()` and `recordRejectedPush()` embed a commit sha
  in it — so every oversized or late push minted a new label value. The RPC's
  `LIMIT 200` did not bound that: it caps the rows returned by **one call**,
  while each refresh resets the gauge and may select a different top-200 and
  Prometheus retains every series it has ever seen. It was also a global top-N,
  so one noisy class could evict every other class from the gauge.
  `20260904130000_workflow_error_category_metrics.sql` adds
  `metrics_workflow_errors_by_category`, which groups by a `CASE` that can only
  emit a literal from a closed list derived from `workflow_run_error.data`
  (`error_type` / `type`), with no top-N;
  `normalizeWorkflowErrorCategory()` in `lib/metrics.ts` applies the same closed
  set on the app side so a stale or hand-edited RPC cannot widen it either. The
  bound is now structural in both places rather than documented.
  **Cardinality budget, per class:** 12 (`runs_recent`) + 3
  (`queue_seconds`) + 2 (`run_seconds`) + 7 (`errors_recent`) = 24 series, so
  ~2.4k at 100 active classes — up from the old nominal ~1.7k, but bounded,
  which the old number was not. `metrics_workflow_errors_by_name` is left in
  place, unused, so a rollback to the previous web image still works.
- **Operational gap, documented not fixed (D4): switching leader mechanisms is a
  two-stage upgrade.** `validations.yaml` refuses both leaders at once, so no
  rendered state has two. But the dedicated leader and the web tier are separate
  Deployments reconciled independently, so one values change that flips
  `workflowMetricsLeader: false` and `metricsLeader.enabled: true` together
  leaves a window where the new leader is already serving scrapes and the old web
  pod still carries `METRICS_WORKFLOW_REFRESH_LEADER`. Both refresh, Prometheus
  scrapes two copies of every global gauge, and every workflow panel reads
  **double** with the DB load doubled behind it. No render-time rule can catch
  it: each end state is legal and the illegal one exists only between two
  reconciles.
  **Stage 1** turns the outgoing mechanism off and deploys — which needs
  `monitoring.allowMissingWorkflowMetrics: true` for that one deploy, since rule
  4 now applies at any replica count. **Stage 2** enables the incoming one **and
  sets `allowMissingWorkflowMetrics` back to `false` in the same commit.**
  Leaving the bypass on is not cosmetic: it is the acknowledgement that rule 4
  exists to force, so a later change that disables both leaders would render
  cleanly and the workflow dashboards would go quiet with nothing objecting —
  the precise silent-blindness failure this whole workstream was opened to fix.
  Treat the bypass as scoped to the single Stage 1 deploy, and check it is back
  to `false` as part of Stage 2's acceptance.
  Stage
  1 leaves a window with no leader and empty panels, which is the correct
  direction to fail: under-reporting reads as an outage, whereas a 2x
  over-report reads as a real traffic spike and sends someone hunting an event
  that never happened.
  If it does happen it is **transient and self-healing** — it ends when the old
  pod terminates, and nothing is corrupted, because these are gauges reset on
  every refresh rather than counters. §8.1's
  `count(count by (pod)(web_workflow_runs_recent)) == 1` sustained over 10
  minutes already detects it after the fact; that check was written for exactly
  this shape. Recorded in `values.yaml` next to both flags and in a
  `{{/* */}}` block in `web-metrics-leader.yaml`.
- **Rule 4 applies at ANY replica count (C2).** It was gated on
  `web.replicas > 1`, which skipped the most ordinary install there is:
  `monitoring.enabled=true`, one replica, both leader settings at their default
  `false`. Nothing sets `METRICS_WORKFLOW_REFRESH_LEADER`, the web ServiceMonitor
  scrapes happily, and every workflow family stays permanently empty — with no
  acknowledgement required. The replica count decides _which_ leader mechanism is
  correct, never _whether_ one is needed. Blast radius audited: every
  `examples/*.yaml` was rendered plain and with `--set monitoring.enabled=true`,
  before and after. `values-preview.yaml` already sets
  `workflowMetricsLeader: true` on its single replica; staging and both prod
  overlays enable the dedicated leader; `values-tartangrader.yaml` renders under
  its documented layering. The only behaviour change is that
  `render-guardrails.sh`'s `BASE` can no longer keep the rule dormant by pinning
  `web.replicas=1` — it now sets `monitoring.allowMissingWorkflowMetrics=true`,
  and the cases that exercise the rule set it back to `false`.
- Five new `validations.yaml` rules (four as planned, plus one added in review:
  `web.metricsLeader.enabled=true` with
  `monitoring.serviceMonitors.metricsLeader=false` is refused unless
  `monitoring.allowUnscrapedMetricsLeader=true`. The refresh runs only while
  `/api/metrics` is being served — there is no background timer — so with no
  ServiceMonitor the leader pod is healthy and exports nothing, which is the
  same permanently-empty dashboard rule 4 exists to prevent, reached through a
  different door. `render-guardrails.sh` asserts both the refusal and the
  acknowledgement path). Note `validations.yaml:25` **already**
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
  are failing"; `PawtograderWorkflowMetricsStale` covers the different failure of
  "nothing is scraping the leader at all".
  **Also revised (C3):** the rule now renders for **either** leader mechanism, not
  just the dedicated Deployment. Gated on `metricsLeader.enabled` alone it left the
  supported single-replica mode (`web.workflowMetricsLeader=true`) with no absence
  coverage at all — and that gap is total, because if the web target is not
  scraped then `web_workflow_metrics_refresh_errors_total` is absent too, so the
  _other_ rule in the group cannot fire either. The annotation names which
  mechanism is in play and which pod to look at, since the remedy differs.

**Revised after review:** `PawtograderWorkflowMetricsStale` originally read
`absent(web_workflow_runs_recent)`, which is a guaranteed FALSE warning on a
healthy deployment. That gauge only has samples once some class completed a
workflow run inside the window; a prom-client labelled gauge that was never
`.set()` emits nothing, so a fresh install, a weekend or the gap between terms
— and this platform is idle for months — fires it after 30 minutes. It now
alerts on `absent(web_workflow_metrics_last_success_timestamp_seconds)`, an
unlabelled sentinel that `refreshWorkflowMetrics()` sets at the end of every
fully successful pass **including one where every aggregate returned zero
rows**. Absence of that series means the producer is broken or unscraped,
which is the only condition worth waking someone for. A sentinel inside
`web_workflow_runs_recent` itself was rejected: `$class_id` is a
`label_values()` variable and the topk panel sums by `class_id`, so a magic
class would appear in the dropdown and in the ranking.
**Second revision (C4):** the sentinel is registered **only when
`METRICS_WORKFLOW_REFRESH_LEADER=true`**. An unlabelled prom-client gauge is
initialized and exported as `0` the moment it is registered, before any
`.set()`, so registering it on every web pod made
`absent(...)` permanently false — the alert would have been silent exactly
when the leader was down, and the "exactly one pod exports this" invariant was
broken too. `lib/metrics.ts` exports `isWorkflowRefreshLeader()` and
`app/api/metrics/route.ts` now calls it, so the registry and the refresh gate
cannot drift apart. Four cases in `tests/unit/metrics.test.ts` pin it,
including "a non-leader process registers no such metric at all" — asserted on
the metric being _absent_, not on it reading zero, because a zero sample is
the failure.
A leader whose database is down still exports the sentinel at `0` (registered,
never set), so `absent()` does not fire for that case — which is correct:
that is `PawtograderWorkflowMetricsRefreshFailing`'s job, and the two rules
partition the failure space between them.

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
  `helm.sh/chart: pawtograder-<version>` label. It is on the **pod template** of
  every stateless workload and changes by construction on every chart bump, so
  **a chart-version bump alone already rolls the whole stateless tier**,
  independent of anything in this effort. Comparing that label would make the
  assertion fail on the version bump and never on the template change it exists
  to catch. Nothing else is normalized: emitted `#` comments and whitespace are
  compared byte for byte.
- **What "the whole stateless tier" means, verified by render** (13 workloads on
  the prod overlay): `web` (3), `web-canary` (1), `functions` (~32 under the
  HPA), `rest` (3), `kong` (2), `auth` (2), `storage` (2), `maintenance` (2),
  `imgproxy`, `meta`, `redis`, `studio` (1 each) — and `realtime`, which is a
  **StatefulSet with 3 replicas**. Realtime is the one that is user-visible: a
  roll drops every websocket, and every connected browser re-subscribes. That is
  a different class of event from an edge-pod roll and it was not called out
  anywhere before.
- **`pawtograder-postgres` and `pawtograder-postgres-replica` do NOT roll, by
  design.** `postgres-statefulset.yaml` and `postgres-replica.yaml` build their
  pod-template labels with `pawtograder.componentStableLabels`, which omits
  `helm.sh/chart` and `app.kubernetes.io/version` — the helper exists because the
  full label set used to roll the primary on every chart bump and took the
  database down ~10 minutes through slow sidecar SIGTERM, and the comment at
  `postgres-statefulset.yaml:38` records it. So the migrations Job is the only
  part of this deploy that goes near Postgres. Do not "tidy" those two label
  blocks back into `componentLabels`.

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
  was never incremented. PR-0 left the panels in place and marked their
  descriptions; **WS-APP deleted them** rather than retargeting — see §10.
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

**Cost question — RESOLVED, measured, then superseded on correctness grounds.**
See "As shipped" below. Short version: both series now read trigger-maintained
counter columns on `class_metrics_totals`, so neither scans and neither needs
`cache_seconds`. The grading scan that `cache_seconds: 300` was sized for
(348 ms at deliberately generous prod scale, a ~0.12% duty cycle) is gone —
not because of cost, but because a `COUNT(*)` over tables that get hard-deleted
is not a counter.

**As shipped** (2026-09-04, branch `metrics-pr0-cleanup`, chart 0.3.18 — no
further bump):

#### Naming: `pawtograder_*`, and the panels were renamed

Both series are `pawtograder_submissions_created_total{class_id}` and
`pawtograder_grading_actions_total{class_id,kind}`. The cheap alternative — name
the exporter block `web_submission_created` so no dashboard edit was needed —
was rejected: a `web_`-prefixed metric produced by postgres_exporter sends the
next person debugging it to the wrong tier, and it would outlive everyone who
knew why. Six panel expressions moved, plus descriptions on four of them
recording the old name and the reason it never emitted.

#### The `topk` panel was already broken, independently of the rename

`topk(20, sum by(class_id)(increase(A[1h]) + increase(B[1h])))` cannot ever have
worked. `A` carries `{class_id}` and `B` carries `{class_id, kind}`; PromQL
matches binary operands on their **full** label sets, finds none, and returns
empty. The fix pushes the aggregation inside each operand:
`sum by(class_id)(increase(A[1h])) + sum by(class_id)(increase(B[1h]))`.

That still requires every `class_id` to exist on both sides, so **both exporter
queries are driven off `public.classes`** — the submissions block with a
`LEFT JOIN`, the grading block with a `CROSS JOIN` over the three kinds — and
every class emits a zero-filled series on both sides. A class that has
submissions but no grading comments no longer silently drops out of the ranking.

#### Submissions: option (2), and it was already built

`pawtograder_submissions_created_total` reads
`public.class_metrics_totals.submissions_total`, **not** `COUNT(*)` over
`public.submissions`. That table is a trigger-maintained per-class counter that
has existed since `20250928001347_class_metrics_performance.sql`; it is
backfilled from the real count and maintained by `AFTER INSERT` triggers with no
`DELETE` counterpart.

The reason to prefer it is monotonicity, not speed. `COUNT(*)` over
`public.submissions` is **not** monotonic: deleting an assignment cascades its
submissions away and the count falls, which Prometheus reads as a counter reset
and `rate()` renders as a spike the size of the whole remaining total. The
counter table cannot fall. Its absolute value can drift from the true row count
after such a delete, and that is fine — every panel reads it through
`increase()`/`rate()`, where a constant offset cancels.

It is also free: one row per class, no scan of the submissions heap, so no
`cache_seconds`.

#### Privilege hardening on `class_metrics_totals`

Both exporter queries now read `public.class_metrics_totals`, which makes it
authoritative for two exported counters, so
`20260904150000_restrict_class_metrics_totals.sql` narrows its privileges to the
roles that actually use it: `service_role` and the `supabase_admin` connection
the postgres_exporter sidecar runs as. `anon` and `authenticated` had ALL on the
table, inherited from the schema-wide
`ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES` in
`20250330003141_remote_schema.sql:3593`; nothing in the application uses it —
outside `supabase/migrations` it appears only in the generated
`SupabaseTypes.d.ts`, in no view and in no other function. RLS is enabled with no
policies as a backstop in case that default ever re-grants the table. The one
reader RPC, `get_all_class_metrics()`, is narrowed the same way; it is
`SECURITY DEFINER`, so the table revoke alone would not have covered it, and it
has no callers either.

**Order matters, and the naive version breaks the app.** All 20
`class_metrics_*` counter trigger functions were `SECURITY INVOKER`, so they run
as whoever issued the INSERT — normally `authenticated`, since these counters are
maintained off ordinary student and staff writes through PostgREST. Revoking
UPDATE first would make the trigger fail and abort the user's INSERT; enabling
RLS first would make the trigger's UPDATE match zero rows and silently stop the
counters, which is worse. So the functions become `SECURITY DEFINER` with
`search_path` pinned to `''` **first**, via `ALTER FUNCTION` rather than a body
rewrite (no body text changes, so there is nothing to mistranscribe across 20
functions, and every table reference in them is already schema-qualified). They
are owned by `postgres`, which owns the table, and the table is not
`FORCE ROW LEVEL SECURITY`, so they keep writing after RLS is on. Do not add
`FORCE` here without re-testing every trigger. Note also that
`CREATE OR REPLACE FUNCTION` resets both attributes — a later migration that
redefines one of these must restate them.

**Verified against a full `supabase db reset`**, not just a render: a row was
inserted as `authenticated` into each of the 22 tables carrying one of these
triggers, and 20 of the 22 counters advanced. The two that did not
(`notifications`, `user_roles`) behave identically with the functions reverted to
their pre-change form, so they are unaffected by this — see the note below. As
`anon` and as `authenticated`, SELECT / INSERT / UPDATE / DELETE on the table and
EXECUTE on `get_all_class_metrics()` are all refused; `service_role` still reads
the table and the exporter query still returns its three rows per class over a
real `supabase_admin` connection.

**Pre-existing, unrelated, worth a separate issue:**
`class_metrics_notifications_counter` and `class_metrics_user_roles_counter` both
guard their work with `IF NEW IS NOT NULL THEN ...`. PostgreSQL evaluates
`record IS NOT NULL` row-wise — it is true only when _every_ field is non-null —
so for any real row with a nullable column unset the guard is false, the derived
flag stays NULL, and the counter adds nothing. That is why
`notifications_unread` reads 0 against 33 seeded notifications. It predates this
branch, is untouched by it, and is out of scope here.

#### Grading actions: option (2) after all — trigger-maintained counters

**Revised after review.** As first shipped this was a live `UNION ALL` `COUNT(*)`
over `submission_comments`, `submission_file_comments`,
`submission_artifact_comments` and `submission_reviews WHERE released`, measured
at 348 ms at synthetic prod scale (100 classes, 500k submissions, 1.5M
`submission_comments`, 400k `submission_file_comments`, 100k
`submission_artifact_comments`, 400k `submission_reviews`; 333 MB of comment
heap; parallel seq scans, no index helps a full-table `GROUP BY`) and served
from `cache_seconds: 300`. The seeded dev database ran it in 0.96 ms.

That query is **not a counter**. It can decrease two ways, and Prometheus reads
any decrease as a counter reset, which `rate()`/`increase()` render as a phantom
burst the size of the whole remaining total:

1. **Hard deletes.** `public.delete_assignment_with_all_data()`
   (`20260109094216_fix-delete-assignment-jsonb-bug.sql`, lines ~107-170)
   hard-deletes all three comment tables and `submission_reviews` for the
   assignment. Verified against that migration and confirmed as the current
   definition — nothing supersedes it. The "soft deletes are counted on purpose"
   reasoning was right about `deleted_at` and simply did not reach this path.
2. **Bulk unrelease.** `submission_reviews.released` is mutable and
   `unrelease_all_grading_reviews_for_assignment()` flips a whole assignment back
   to `false`. This was previously accepted and documented, but the blast radius
   was understated: the "Grading actions (1h)" stat and the "Top classes by
   recent activity" table sum **across** kinds, so a bulk unrelease corrupted
   those too, not just the by-kind series.

Documenting either one is not enough for a panel read during a grading crunch:
it does not render as "stale", it renders as a large spike.

**The earlier cost objection turned out to be false.** WS-APP rejected a
trigger-maintained counter as "a new trigger on the comment insert hot path to
save 0.12% of one core". That trigger already exists.
`class_metrics_submission_comments_counter()`
(`20250928001347_class_metrics_performance.sql`) has fired `AFTER INSERT` on all
four comment tables since September 2025.
`20260904140000_grading_action_counters.sql` adds three columns to
`class_metrics_totals` and one more column to the single-row `UPDATE` that
trigger already issues — no new trigger, no new per-row invocation, no extra
statement. `submission_reviews` gets the one genuinely new trigger, scoped
`AFTER UPDATE OF released ... WHEN (NEW.released AND NOT OLD.released)`, so it is
not entered for the score / `completed_at` / rubric-assignment updates that make
up nearly all of that table's write volume.

So the choice was between two documented caveats plus a dashboard that would
have to drop `kind="release"` from its cross-kind panels, and one migration that
makes all three kinds genuinely monotonic. The migration wins, and it is
strictly cheaper at steady state than what it replaces.

Consequences:

- **No `cache_seconds`.** It is a one-row-per-class read now. That matters
  beyond CPU: a 300 s cache on a counter makes `rate(...[1m])` alternate between
  a flat zero and the whole five-minute increment in one sample.
- `submission_regrade_request_comments` stays excluded from the two comment
  counters (it keeps feeding `submission_comments_total` as before). Students
  write those; they are not grading actions, and the scan being replaced did not
  count them either. Keeping the meaning identical across the switch is what
  makes the counter continuous rather than stepping.
- The backfill counts surviving rows, so it starts below the true historical
  action count. That is a constant offset and cancels under `increase()`/
  `rate()`, the same argument that already justified
  `class_metrics_totals.submissions_total`.
- `render-guardrails.sh` now asserts the block reads the three counter columns
  and `public.class_metrics_totals`, contains no `COUNT(*)`/`UNION ALL`, and sets
  no `cache_seconds`. The old assertion that the literal `deleted_at IS NULL` was
  absent is gone with the scan it guarded.

**Counter monotonicity, restated.** These count grading **actions**, not
surviving rows. A retracted comment, a deleted assignment and an unreleased
review all still happened, and none of them moves the counter. There is no
longer a knowingly non-monotonic dimension in this family.

#### `web_http_*`

`lib/routeMetrics.ts` exports `withRouteMetrics(routePattern, handler, method?)`,
delegating to the existing `timeHttp`. Applied to **18 handlers across 15 files**
under `app/api/**`. Skipped: `app/api/tunnel` (Sentry, high volume, no diagnostic
value) and `app/api/metrics` (the self-scrape). `app/api/llm-hint` was converted
from its hand-rolled `timeHttp` call to the wrapper.

- The `route` label is the literal parameterized pattern hardcoded per file
  (`"/api/calendar/[course_id]"`). The wrapper takes it as an argument precisely
  so there is nothing to get wrong at runtime; `req.nextUrl.pathname` would make
  `route` an unbounded per-course label driven by a public URL.
- `status` is bucketed to `2xx`/`4xx`/`5xx` by `bucketStatus()`, applied
  **inside `timeHttp`** rather than in the wrapper so it cannot be bypassed. The
  throw path records `5xx`, not the old literal `500`.
- The `method` override exists for the two handlers that take no arguments at
  all (`export async function OPTIONS()` on the calendar route,
  `export async function GET()` on the LTI JWKS route) — there is no Request to
  read the method from.
- RSC page renders are **not** instrumented. No seam short of middleware, and
  middleware is Edge.

#### `web_supabase_rpc_*`

`timeRpc` applied at the SSR boundary: `getUserRolesForCourse`, `getCourse`,
`fetchCourseControllerData`, `fetchAssignmentControllerData` (`lib/ssrUtils.ts`,
wrapped by delegating to renamed `*Untimed` inner functions so the bodies are
untouched), the two aggregate RPCs in `lib/ssr-course-dashboard.ts`
(`get_instructor_dashboard_overview_metrics`, `get_workflow_statistics` ×2, which
share one label), and `lti_upsert_line_item` / `sis_sync_enrollment` in
`lib/lti/grades.ts` and `lib/lti/roster.ts` (both reached from live routes).

- The `rpc` label is a **closed union type**, `RPC_LABELS` in `lib/metrics.ts`,
  8 entries against the ~15 cap. Typing `timeRpc`'s first parameter as that union
  rather than `string` means adding a call site is a deliberate edit to a
  reviewed list, not a label that quietly appears in production.
- `normalizeRpcErrorCode()` collapses anything not matching `/^[0-9A-Z]{5}$/` to
  `"unknown"`, with `"throw"` as the one deliberate exception. The old signature
  invited `errorCode: error.message`, and a PostgREST message embeds the
  offending value — unbounded cardinality on a counter.
- `classifySupabase()` is the shared classifier so no call site re-derives it and
  reaches for `.message`. It takes `unknown` rather than a structural type so it
  stays assignable to `timeRpc`'s generic `classify` for any result type.
- **Revised after review: two of the SSR loaders were recording failures as
  successes.** `getUserRolesForCourseUntimed` and `getCourseUntimed` discard the
  PostgREST `error` and return only `data`, and both were classified with a
  constant `() => ({ status: "ok" })`. PostgREST failures resolve as
  `{ data: null, error }` rather than rejecting, so an RLS or SQL error recorded
  `status="ok"` and never incremented `web_supabase_rpc_errors_total` — the new
  SSR error panel was structurally blind. The `*Untimed` inner functions now
  return a `{ value, error }` envelope so `classifySupabase` can see the error;
  the exported functions unwrap it, so their runtime contract is byte-for-byte
  what it was. **Deliberately not converted to throwing**: callers read
  `undefined`/`null` as "not enrolled" / "no such course", and throwing would
  turn a transient DB error into a 500 on pages that currently degrade.
  `fetchCourseControllerData` and `fetchAssignmentControllerData` are correct as
  they stand — every read in them goes through `fetchAllPages()`, which throws,
  so `ok` is the right classifier and `timeRpc`'s catch path records
  `code="throw"`. **The audit found no other instance**: the two aggregate RPCs
  in `lib/ssr-course-dashboard.ts` and the two in `lib/lti/*` already pass
  `classifySupabase` against the raw PostgREST envelope and were never
  affected.

#### New panels — the metrics would otherwise be invisible

Six panels plus a row header appended to **`app-business.json`**, not a new
dashboard. Justification: these are produced by prom-client in the web pods and
scraped from `/api/metrics` — the same target as the workflow row already on this
dashboard — so they sit next to the family they share a scrape target with, and
it avoids a ninth ConfigMap. p95 and error rate for both families, plus request
rate by status class, 5xx rate, and in-flight by route. The row description
records that **none** of them honour `$class_id`, because neither family has a
class dimension and that is deliberate.

#### Eager registry init

`instrumentation.ts` `register()` awaits `getMetrics()` inside the existing
`NEXT_RUNTIME === "nodejs"` branch. Without it a pod that has served no
instrumented route yet answers `/api/metrics` with an empty body, which reads on
a dashboard exactly like "this pod is not being scraped" — the failure this whole
effort exists to fix.

#### Client-bundle guard — two of them, and they catch different things

- `scripts/check-prom-client-bundle.sh` greps `.next/static/chunks/` after a
  production build. Wired into `.github/workflows/deploy.yml` immediately after
  the existing `npm run build` step, so it costs nothing. A missing chunks
  directory is a hard failure, not a pass.
- `tests/unit/prom-client-bundle.test.ts` walks the import graph statically —
  runs on every PR in under a second and names the exact edge rather than
  pointing at a minified chunk hash. It BFSes the reverse-import graph from
  `lib/metrics.ts` and `lib/routeMetrics.ts` and fails if any `"use client"`
  module is reachable. **It must ignore `import type`**: type-only imports are
  erased before bundling and create no bundle edge, and
  `hooks/useCourseController.tsx` legitimately does
  `import type { CourseControllerInitialData } from "@/lib/ssrUtils"`. Verified
  by negative test — adding a value import of `@/lib/metrics` to that file makes
  it fail with the chain printed.

Neither replaces the other.

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

**Revised after review (D1): the scrape is no longer counted as traffic.**
`recordRequest()` ran before the `isMetricsScrape` branch, so every
ServiceMonitor poll — routed through `serviceName="metrics"` like any other
function — was recorded as an edge request with a latency sample. At 32 pods on a
30s interval that is ~1.07 RPS of synthetic, guaranteed-200 traffic diluting the
fleet-wide 5xx ratio, worst during quiet periods when that ratio should be most
sensitive. The web tier already excludes `/api/metrics` from `web_http_*`; this
is the same rule. Checked for the same ordering elsewhere: the `_unknown` bucket
is unaffected (`metrics` is a real function and is on the boot-time allowlist),
and the eszip gauges are unaffected in the sense that matters — the metrics
function's bundle genuinely is resident, so counting it is correct. Worker errors
on the scrape path are still recorded, deliberately: those are not
synthetic-success dilution, and a metrics function failing to start is the one
failure that also blanks this pod's own exposition.

**Revised after review (C1): `app-business.json` got the same treatment.** It had
no namespace variable and no matcher on any panel, so a Grafana whose datasource
covers several deployments — previews are exactly that shape, see
`examples/values-preview.yaml` — merged identically named `route` and `rpc`
labels, and independently generated `class_id`s, from different environments into
one graph that read as production. A `$namespace` variable was added on the same
pattern (Prometheus datasource, `label_values(kube_pod_info, namespace)`, regex
`pawtograder.*`, `includeAll` with `All` as the default) and applied to **all 30
targets** — both the `web_*` families and the postgres*exporter `pawtograder*\*`ones, since both are ServiceMonitor-scraped and both carry the label.`$class_id` is now derived from the namespace-scoped series so the class list
follows the selection.

**Revised after review (D2/D3): the last `$fn` gap, and a units collision.**
Only three edge series carry a `function` label —
`pawtograder_edge_requests_total`, `pawtograder_edge_function_seconds_total` and
`pawtograder_edge_worker_errors_total` — and after C5 the worker-errors target on
panel 12 was the last one not applying `$fn`, so a selected function could be
blamed for another's error spike. Fixed. The retirement target on the same panel
stays fleet-wide and now says why in its description:
`pawtograder_edge_user_workers_retired_total` is a pod-wide runtime counter with
no function dimension, so filtering it would return the same number under a
misleading label. That completes the sweep; `main.ts` is the authority for which
series carry the label.

The units collision was a planning error, not an implementation one. "Mean
latency by function" (seconds per request) and "Time spent per function"
(`rate(function_seconds_total)`, function-seconds per wall-clock second — i.e.
mean concurrent executions, dimensionless and freely above 1) shared one panel
and one axis. A function averaging 2s at 10 RPS plots as `20`, which Grafana
labels "20 seconds" and which squashes the real latency series into the floor.
Split into two panels: **Mean latency by function** (unit `s`) and **Share of
tier time by function**, the latter divided by the fleet total, unit
`percentunit`, stacked. The share form was chosen over plotting concurrency
because "where is the tier's time going" is the question the panel exists to
answer, and a share answers it directly — a function can be fast per request and
still dominate the tier by volume. Both units are set explicitly rather than
inferred, and the raw numerator is named in the description for anyone who wants
absolute worker occupancy.

**Revised after review (C5): panel 11 honours `$fn` again.** Neither side of the
mean-latency expression nor the time-spent target carried `function=~"$fn"`, so
selecting a function did not filter the panel that replaced one which did. Fixed,
and applied to the other two per-function breakdowns for consistency —
"Invocations per function" and "Top errors by function" had the same omission. A
variable that filters some breakdown panels and not others is the same class of
bug. Panel 3 (P95 latency) still drops `$fn` deliberately: the histogram carries
no `function` label and the panel would go blank, which its description records.

**Revised after review: every `pawtograder_edge_*` expression now carries
`namespace=~"$namespace"`, and so does the `$fn` variable query.** With
`$namespace` defaulting to `All`, the headline traffic / error / latency /
worker panels had no namespace matcher at all, so a datasource holding staging,
previews and production summed all of them together while only the kube-state
and Loki panels honoured the selector. The label is present on this scrape path:
prometheus-operator-style ServiceMonitor discovery (Grafana Alloy's
`prometheus.operator.servicemonitors` here) sets `namespace` from
`__meta_kubernetes_namespace` on every target, and none of the chart's
ServiceMonitors override the relabeling — the same reason §8.0's
`count({namespace="pawtograder-prod"})` baseline works. `$namespace` was also
moved ahead of `$fn` in the variable list, since `$fn` now depends on it.
**`edge-soak.json` does not have this defect**: it queries no
`pawtograder_edge_*` series at all — every one of its expressions is
kube-state-metrics or Loki, and all 16 already carry `namespace=~"$ns"` from the
PR-0 fix.

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
change a running workload's SPEC.

Be precise about what the check does and does not buy, because the obvious
reading is wrong: the web pods roll on this deploy **either way**. The
`helm.sh/chart` label bump rolls the entire stateless tier by itself (see §4).
What byte-identity buys is that the pods coming back are the same pods — same
env, same probes, same volumes, same resources — so the rollout is a like-for-like
replacement rather than a silent respec of the user-facing tier riding along
inside a deploy advertised as purely additive. A diff here is a change nobody
reviewed as a change. The check therefore runs
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
- [ ] Confirm all four RPCs the leader calls exist in the prod DB, by name:
      `metrics_workflow_runs_by_conclusion`, `metrics_workflow_queue_percentiles`
      and `metrics_workflow_run_percentiles` (from
      `20260529190000_workflow_metrics_rpcs.sql`, which predates the deployed
      migrations tag so it is almost certainly applied), plus
      `metrics_workflow_errors_by_category` (new, in
      `20260904130000_workflow_error_category_metrics.sql`, so it is definitely
      not applied yet). **Check, don't assume** — a missing one makes the leader
      increment `web_workflow_metrics_refresh_errors_total` forever. Gate 3 uses
      the same four names; do not let the two lists drift.
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
byte-identical; only additions appear elsewhere. **Any diff means the web tier is
silently RESPEC'd on a supposedly additive deploy.** Not "means it restarts" —
the chart-version bump restarts it regardless (§4). The point is that the pods
that come back should differ from the current ones in nothing but that label.
Wire the assertion into `tests/render-guardrails.sh` so CI enforces it forever.

**Gate 2 — Validation matrix (local).** For each new rule, one combination that
must render and one that must fail — plus a render of the _unmodified current_
`values-prod.yaml`. You must know ahead of time whether that passes or fails, so
Gate 5 is a formality rather than a surprise.

**Gate 3 — Index / query-plan proof (needs DB access).** `EXPLAIN (ANALYZE,
BUFFERS)` all four RPCs — `metrics_workflow_runs_by_conclusion`,
`metrics_workflow_queue_percentiles`, `metrics_workflow_run_percentiles`,
`metrics_workflow_errors_by_category` — against the **prod streaming replica** (already
deployed, read-only — no need to stand up a shadow namespace). Pass = index scans
and total refresh well under the 10s scrape timeout; target <1s. The two new
indexes cover the first three; `metrics_workflow_errors_by_category` should
already be an index scan on `idx_workflow_run_error_created_at`, so it is the
control case — if that one seq-scans, the window predicate is not being pushed
down and the plans for the other three are suspect too.
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

**Expect a full stateless-tier roll, and schedule for it.** This is a chart
version bump, and `helm.sh/chart` sits on the pod template of all 13 stateless
workloads (§4), so every one of them rolls — regardless of which image tags
moved. A deploy where the web pods did _not_ restart would mean the chart version
did not change, i.e. something went wrong. Do not read the restarts as a
regression; read a _missing_ restart as one.

- **`realtime` is the user-visible one.** It is a StatefulSet with 3 replicas,
  and rolling it drops every websocket; every connected browser reconnects and
  re-subscribes. That is a real, if brief, user-facing event and it is the reason
  "pick a low-traffic window, not near an assignment deadline" is in the
  pre-flight. An edge roll is invisible; this one is not.
- **The data tier is untouched.** `pawtograder-postgres` and
  `pawtograder-postgres-replica` deliberately omit `helm.sh/chart` from their pod
  labels (`componentStableLabels`, after an incident where the full label set
  took the database down ~10 minutes on every bump), so the migrations Job is the
  only thing in this deploy that goes near Postgres. If either Postgres pod
  restarts on this deploy, that is a genuine finding — stop and investigate
  rather than attributing it to the version bump.

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
- `count(web_workflow_metrics_last_success_timestamp_seconds) == 1` and
  `time() - web_workflow_metrics_last_success_timestamp_seconds` stays under one
  refresh interval plus one scrape interval. **This, not
  `count(web_workflow_runs_recent) > 0`, is the liveness check on an idle
  deployment**: the sentinel is emitted on every successful refresh even when
  every aggregate returns zero rows, which is why
  `PawtograderWorkflowMetricsStale` now alerts on its absence. On staging,
  verify it appears BEFORE seeding any `workflow_runs` rows — that is the case
  the old `absent(web_workflow_runs_recent)` rule got wrong.
- `count(count by (category)(web_workflow_errors_recent))` ≤ 7, and every value
  is drawn from `WORKFLOW_ERROR_CATEGORIES` in `lib/metrics.ts`. A value outside
  that list means the RPC and the app disagree.
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
- `pawtograder_grading_actions_total` must be **flat or rising, never falling**.
  The cheap way to prove it: delete a throwaway assignment that has grading
  comments on staging and confirm the series does not move. Under the old
  `COUNT(*)` form it would have dropped by the comment count and `increase()`
  would have rendered a burst the size of the class total.

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

| Decision                                    | Resolution                                                                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build producers vs. trim dashboards         | **Build producers** (2026-09-03)                                                                                                                                    |
| Per-function latency quantiles              | **No.** Do not ship the flag. (2026-09-03)                                                                                                                          |
| Shadow prod deploy via canary channel       | **Not possible** — ship dark + flip gates (§6)                                                                                                                      |
| Where the edge counter lives                | `main.ts` collects, intercepts `/metrics`, appends on 200                                                                                                           |
| Leader scrape wiring                        | Distinct `component: metrics-leader` + its own ServiceMonitor                                                                                                       |
| Most `web_*` business counters              | **Delete** — web tier is the wrong producer                                                                                                                         |
| Fix canary-not-scraped                      | **Separately**, after this effort                                                                                                                                   |
| Breaking validation rule                    | **Ship with an escape hatch** (2026-09-04)                                                                                                                          |
| `values-tartangrader.yaml`                  | **Update the example**; nobody is using it, so no deprecation period (2026-09-04)                                                                                   |
| Postgres restart on `queries.yaml` change   | **Test in staging** rather than inferring from the render (2026-09-04)                                                                                              |
| Deploy `--timeout`                          | **Raised 15m → 25m** (2026-09-04, `prod-charts/.github/workflows/deploy.yml`)                                                                                       |
| Staging load generation                     | **Manual**, by Jon (2026-09-04)                                                                                                                                     |
| Who runs the `[OPS]` checks                 | **Jon + Claude together**, live during each gate (2026-09-04)                                                                                                       |
| WS-APP metric names                         | **Rename to `pawtograder_*`** and edit the six panels (2026-09-04)                                                                                                  |
| WS-APP exporter query cost                  | **No scan, no cache.** Both series read trigger-maintained `class_metrics_totals` columns (2026-09-04, revised in review)                                           |
| Grading-actions monotonicity (F6/CR1)       | **Option (a)**: three counter columns + one scoped trigger. The "new trigger on the hot path" objection was false — the comment trigger already exists (2026-09-04) |
| Workflow error label (F1)                   | **Closed category** from `workflow_run_error.data`, not `name`. `LIMIT 200` bounded one call, never the label domain (2026-09-04)                                   |
| `PawtograderWorkflowMetricsStale` (F7)      | **Sentinel**, not `absent()` on a data-dependent gauge. The old rule false-fired on any quiet window (2026-09-04)                                                   |
| Sentinel registration (C4)                  | **Leader-only.** An unlabelled gauge exports 0 on registration, so fleet-wide registration made `absent()` permanently false (2026-09-04)                           |
| Rule 4 replica gate (C2)                    | **Removed.** Applies to any enabled web tier; the replica count picks the mechanism, not the need (2026-09-04)                                                      |
| Stale-alert rendering (C3)                  | **Either leader mechanism**, with the mechanism named in the annotation (2026-09-04)                                                                                |
| `app-business.json` namespace scoping (C1)  | **Added**, mirroring `edge-functions.json`, across both metric families (2026-09-04)                                                                                |
| Metrics scrape counted as edge traffic (D1) | **Excluded.** ~1.07 RPS of synthetic 200s was diluting the fleet 5xx ratio (2026-09-04)                                                                             |
| Mean latency + time-spent on one axis (D3)  | **Split into two panels**; time-spent normalised to a share, units set explicitly (2026-09-04)                                                                      |
| Leader-mechanism switch (D4)                | **Two-stage upgrade, documented.** No render-time rule can see the transient overlap (2026-09-04)                                                                   |
| `realtime-fanout.json` panels 3 and 11      | **Delete.** No monotonic trigger-side producer exists (2026-09-04)                                                                                                  |
| Wave 1 vs wave 2 on failing example renders | **Wave 1 was right.** The prod failures are a pre-existing placeholder, not rule 4 (2026-09-04)                                                                     |

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

**`realtime-fanout.json` panels 3 and 11 (WS-APP).** **Deleted**, not retargeted
at a trigger-side exporter query. The panel grid was re-flowed (three stats
widened to `w: 8` across the top row; "Phoenix connections by replica" widened to
`w: 24`), so there are no gaps, and the reasoning is recorded in the dashboard's
own `description` field where the next person to ask will find it. Three reasons,
in order:

1. The only trigger-side row a broadcast produces is an insert into
   `realtime.messages`, which is **daily-partitioned with short retention**. A
   `COUNT` over it falls every time a partition is dropped, Prometheus reads a
   falling counter as a reset, and `rate()` renders the drop as a spike. It
   cannot back a `rate()` panel at all — this is the same monotonicity trap that
   drove the `deleted_at` decision above, but here there is no way around it.
2. The windowed-gauge alternative means scanning the highest-write table in the
   database on every scrape. That is precisely the `database_ram_metrics()`
   pathology.
3. `channel_class` would have to be reconstructed by parsing
   `realtime.messages.topic`, which embeds class and resource ids — a loosely
   bounded label fed by user-controlled data.

Every other panel on that dashboard comes from the realtime container's own
`/metrics` endpoint (`job="pawtograder-realtime"`). If broadcast counts are
wanted back, that is where they belong.

**Wave 1 vs wave 2 on the failing example renders.** Wave 1 was right; wave 2's
report was wrong on two counts. The failures are **not** rule 4 and are **not**
new, and the three files do not fail identically. Verified by rendering every
`charts/pawtograder/examples/*.yaml` with and without
`--set monitoring.enabled=true`, and again from a worktree at `2b8defc1` (the
commit before rule 4 existed):

| File                       | plain | `--set monitoring.enabled=true` | Cause                          |
| -------------------------- | ----- | ------------------------------- | ------------------------------ |
| `values-preview.yaml`      | OK    | OK                              | —                              |
| `values-staging.yaml`      | OK    | OK                              | —                              |
| `values-tartangrader.yaml` | OK    | **FAIL**                        | rule 4, standalone render only |
| `values-prod.yaml`         | FAIL  | FAIL (identical)                | pre-existing placeholder       |
| `values-prod-noeso.yaml`   | FAIL  | FAIL (identical)                | pre-existing placeholder       |

The prod failure, byte-identical with and without the `--set`, is at
`validations.yaml:127`:

> `monitoring.prometheusRules.labels.release is empty — a blank label value matches no ruleSelector, so every shipped alert is silently inert (same failure as leaving labels unset, but it passes the empty-map check). Fill in the value (e.g. release: kube-prometheus-stack). Not allowed when global.environment=production.`

At `2b8defc1` both prod files fail with the **same message**, at
`validations.yaml:77`. Only the line number moved. Peeling that placeholder
reveals a chain of further deliberate `REPLACE_ME`-shaped holes — empty
`edgeFunctions.image.tag`, then `postgres.walg.s3Prefix` — never rule 4. Wave 1's
`web.metricsLeader.enabled: true` edit is present in both files and does satisfy
rule 4. **No fix needed.**

The tartangrader standalone failure **is** rule 4, and it is an artifact of
rendering a branding fragment with no base: the chart default `web.replicas: 2`
plus a forced `monitoring.enabled=true`. That is not a supported way to consume
the file. **Wave 1's reasoning holds on every point**, verified:
`values-tartangrader.yaml`'s own header documents
`-f values-staging.yaml -f values-tartangrader.yaml`;
`render-guardrails.sh:293` really does layer it that way; `values-preview.yaml`
really does set `workflowMetricsLeader: true` on one replica; and
`validations.yaml` really does make `metricsLeader.enabled` and
`workflowMetricsLeader` mutually exclusive, so hard-coding the leader into the
skin would break the preview layering. Both documented layerings render, with and
without `--set monitoring.enabled=true`.

**What is genuinely refused, and is the intended breaking change:** the real
Khoury overlay `prod-charts/values/values-prod.yaml` (`web.replicas: 3`,
`monitoring.enabled: true`, none of the three leader keys) is refused by rule 4
at HEAD and rendered fine at `2b8defc1`. That is exactly the ordering constraint
§5 and §10's escape-hatch entry already record: the prod-charts commit that moves
to 0.3.18 must set `web.metricsLeader.enabled: true` or
`monitoring.allowMissingWorkflowMetrics: true` in the **same** commit.

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

---

## 12. Staging validation, 2026-09-04 (helm revision 88, chart 0.3.18)

Deployed to `pawtograder-staging` on ripley at 16:43 UTC, image tag
`staging-1a6f224`. The rollout itself was clean: chart 0.3.18 on every pod, the
`metrics-leader` Deployment + Service + ServiceMonitor present, `EDGE_METRICS=1`
on both edge channels, and all eight dashboard ConfigMaps updated in place.

### 12.1 What passed

Revisions 89 and 90 (chart 0.3.19, tag
`fix-metrics-scrape-gzip-and-storage-84a5b11`) then deployed the fixes; the edge
result below is measured against revision 90.

**Edge scrape, after the fix.** Every `pawtograder-staging` target reads `up`,
including all edge pods, and the endpoint behaves correctly on the Prometheus
path (bearer token + `Accept-Encoding: gzip`): 200, body begins `1f 8b 08 00`,
gunzips cleanly, 36 `pawtograder_edge_*` samples plus 19 pre-existing
queue/bottleneck/breaker samples, zero U+FFFD bytes, and the same metric-family
set as the uncompressed response. 5 distinct `function` label values (invoked
functions, not the ~55 known ones), 496 edge series total against the ~8.6k
budget, zero restarts and zero `OOMKilled`, 412 MiB peak working set.

- **Leader.** Exactly one pod exports the workflow family
  (`count(count by (pod)(web_workflow_runs_recent)) == 1`). The sentinel
  `web_workflow_metrics_last_success_timestamp_seconds` is present with
  `count == 1` and an age of 150s, inside one refresh plus one scrape. 16
  refreshes, **zero** `web_workflow_metrics_refresh_errors_total` series,
  refresh p95 0.94s against a 10s scrape timeout.
- **WS-APP.** `pawtograder_submissions_created_total` (148 series) and
  `pawtograder_grading_actions_total` (444 series) both live, from exactly one
  exporter instance, with the `pawtograder_*` family count intact at 21.
- **`web_http_*`.** Verified by request rather than by inspection, because on an
  idle staging the family is legitimately absent. Hitting `/api/lti/jwks`
  produced the expected shape, with the route label as the parameterized pattern
  and the status bucketed:

  ```
  web_http_request_duration_seconds_bucket{le="0.5",route="/api/lti/jwks",method="GET",status="5xx"} 4
  ```

### 12.2 Four §8.1 sub-checks read empty, and that is correct

`web_workflow_queue_seconds`, `web_workflow_run_seconds`,
`web_workflow_errors_recent`, and the `window="1h"` half of
`web_workflow_runs_recent` were all empty. All four are 1h-window aggregates
(`lib/metrics.ts`), and staging had no workflow runs inside that hour: the 24h
window read 501 success + 2 failure for `class_id=1`. A gauge that is never
`.set()` emits no sample, so an idle hour is indistinguishable from a broken
RPC by inspection alone.

**Do not sign off on these four from a point read.** Seed or trigger workflow
runs and re-check inside the same hour, or the check is vacuous.

### 12.3 Two regressions found, fixed separately

**(a) The edge target went DOWN, taking the pre-existing series with it.**
`up{job="pawtograder-functions"}` flipped 1 to 0 across all 16 pods three
minutes after the rollout, with `lastError: gzip: invalid header`.

Prometheus scrapes with `Accept-Encoding: gzip`; the demuxer forwards the
request verbatim, so the worker's body arrives gzip-encoded, and the append
path's `res.text()` decoded DEFLATE bytes as UTF-8 and re-emitted the result
under the inherited `content-encoding: gzip`. Recognizable from the body's
first bytes: `1f ef bf bd 08 00`, the gzip magic with `8b` replaced by U+FFFD.

Two things about this are worth carrying forward. First, plain `curl` sends no
`Accept-Encoding` at all, so the functional test in §8.3 passed against a code
path Prometheus never takes: **testing an exposition endpoint with bare `curl`
proves nothing.** Second, the blast radius was the whole target, not just the
new series. The `pawtograder_async_*`, `pawtograder_bottleneck_*` and
`pawtograder_circuit_breaker_*` families come off that same endpoint, so
`queues-and-workers` and `rate-limiting` went dark for staging too and the
queue-depth alerts went blind. The values still rendering in Grafana came from
the `pawtograder-preview-pr-*` namespaces, which run older images. That is an
easy thing to mistake for a healthy staging.

**(b) `storage` had been DOWN for 24h+ on a 404, and the fix that looked
obvious takes the tier down.** The ServiceMonitor's comment asserted that
storage-api serves `/metrics` only on the admin app or in multitenant mode, and
that a single-tenant deploy necessarily 404s. Read off the dist bundle in
`supabase/storage-api:v1.48.26`, that is backwards:

```
app.js              plugins.metrics({ enabledEndpoint: !isMultitenant, ... })
plugins/metrics.js  if (prometheusMetricsEnabled) register(metricsEndpoint)
                      -> if (enabledEndpoint) fastify.get("/metrics", ...)
config.js:252       prometheusMetricsEnabled = PROMETHEUS_METRICS_ENABLED === "true"
```

Single-tenant is the mode where the **main** app serves it, gated only on
`PROMETHEUS_METRICS_ENABLED`. So the flag was set, deployed to staging as
revision 89, and the storage tier went into CrashLoopBackOff:

```
"Reply was already sent, did you forget to \"return reply\" in the \"/metrics\" (GET) route?"
Error [ERR_HTTP_HEADERS_SENT]: Cannot write headers after they are sent to the client
  -> uncaughtException -> PID 1 exits
```

`handleMetricsRequest` writes the reply without returning it, so fastify's
`onSend` chain double-writes the response head. The route exists and the
handler is fatally broken, on a ~30s scrape interval. Reverted in revision 90;
storage recovered with no further restarts.

The uncomfortable part is that the original advice ("set the toggle false") was
correct, and its stated mechanism was wrong. A wrong mechanism attached to a
right conclusion is worse than no comment at all: it presents as an error to
correct, and correcting it broke production behaviour that the wrong reasoning
had been protecting. Verifying the mechanism against the bundle was necessary
but not sufficient -- the missing step was checking what the endpoint does when
called, not just whether it is registered.

Resolution: ship neither the flag nor the ServiceMonitor.
`monitoring.serviceMonitors.storage` now defaults to **false**, because a
permanently-DOWN 404 target is itself a defect -- it trains everyone to ignore a
DOWN storage row. Storage metrics remain uncollected. The route worth trying is
the admin app on `ADMIN_PORT` (5001), which registers the same handler behind a
different hook chain, but that needs its own container port, Service port and
ServiceMonitor, and the admin app also exposes tenant/migration/s3-credential
routes -- an exposure decision, not a `monitoring.enabled` side effect.

### 12.4 Standing checks to add to §8.0

Baseline capture missed both regressions because it counted series rather than
checking targets. Add:

- `up{namespace="<ns>"} == 0`: enumerate every DOWN target by job **before**
  reading any panel, and treat a target that was already down as in scope, not
  as background.
- For each target's `lastError` in the Prometheus targets API, not just `up`.
  `gzip: invalid header` and `404 Not Found` are both invisible in `up` alone.
- `curl -H 'Accept-Encoding: gzip' <pod>:<port>/metrics | gunzip`: must
  actually decompress. Run this against any endpoint with a proxy, demuxer, or
  rewrite in front of it.
