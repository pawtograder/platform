// Prometheus metrics registry for the Next.js web app.
//
// prom-client is Node-only — it does not work in the Edge runtime that
// middleware.ts runs in. Every helper exported here is safe to call from
// either runtime: when NEXT_RUNTIME !== "nodejs" the registry isn't
// initialized and the helpers no-op (so we don't blow up on the Edge).
//
// The actual counters/histograms live in a single Registry exposed via
// app/api/metrics/route.ts. That route is gated by METRICS_SCRAPE_TOKEN
// and surfaced to the cluster's Prometheus via the ServiceMonitor in
// charts/pawtograder/templates/monitoring.yaml.

import type { Counter, Gauge, Histogram, Registry as RegistryT } from "prom-client";

type MetricsBundle = {
  registry: RegistryT;
  httpDuration: Histogram<string>;
  httpInFlight: Gauge<string>;
  rpcDuration: Histogram<string>;
  rpcErrors: Counter<string>;

  // Workflow business gauges. Refreshed from the DB at scrape time —
  // see refreshWorkflowMetrics() below. These are the user-facing
  // success/failure + queue/run duration signals for the autograder
  // pipeline, derived from public.workflow_runs + public.workflow_run_error.
  workflowRunsRecent: Gauge<string>; // labels: class_id, conclusion, window
  workflowQueueSeconds: Gauge<string>; // labels: class_id, quantile
  workflowRunSeconds: Gauge<string>; // labels: class_id, quantile
  workflowErrorsRecent: Gauge<string>; // labels: class_id, category, window
  workflowRefreshDuration: Histogram<string>; // observed when refresh runs
  workflowRefreshErrors: Counter<string>;
  // Unix seconds of the last fully successful refresh, INCLUDING one where
  // every aggregate returned zero rows — that is the point. See the alerting
  // note at refreshWorkflowMetrics().
  //
  // Registered ONLY on a leader process. An unlabelled prom-client gauge is
  // initialized to 0 and exported the moment it is registered, before any
  // .set(), so registering it everywhere would make every ordinary web pod
  // export `web_workflow_metrics_last_success_timestamp_seconds 0` and
  // absent() could never fire — the alert would be permanently silent exactly
  // when the leader is broken. See isWorkflowRefreshLeader().
  workflowRefreshLastSuccess?: Gauge<string>;

  // Epoch-ms of the last SUCCESSFUL refreshWorkflowMetrics() pass. 0 means
  // "never refreshed", so the first call always runs. See the throttle at the
  // top of refreshWorkflowMetrics().
  lastWorkflowRefreshMs: number;

  // The refresh pass currently running, if any. Concurrent callers await THIS
  // rather than starting a second pass — the timestamp throttle alone is a
  // check-then-act race (two scrapes both read the old timestamp before either
  // finishes and both run all five aggregates). Cleared in a finally, on both
  // success and failure, so one rejection cannot wedge every future refresh.
  workflowRefreshInFlight?: Promise<void>;
};

// We attach state to globalThis so it survives Next.js's per-request
// module instantiation in dev (and route-handler re-imports in prod).
type GlobalWithMetrics = typeof globalThis & {
  __pawtograderMetrics?: MetricsBundle;
  // The in-progress init, if any. initIfNeeded() awaits a dynamic import before
  // it can publish the bundle, and two concurrent callers that both arrive
  // during that window would otherwise each build a whole registry — the second
  // overwriting the first, leaving the two callers holding DIFFERENT bundles.
  // That silently breaks anything keyed off the bundle (the single-flight
  // refresh below) and drops whatever the first caller had already recorded.
  __pawtograderMetricsInit?: Promise<MetricsBundle>;
};

const g = globalThis as GlobalWithMetrics;

function isNode(): boolean {
  return process.env.NEXT_RUNTIME === "nodejs" || typeof process.env.NEXT_RUNTIME === "undefined";
}

// Whether THIS process is the one that refreshes the DB-backed workflow gauges.
// Exported so app/api/metrics/route.ts and the registry agree on one definition
// rather than each spelling out the env var.
export function isWorkflowRefreshLeader(): boolean {
  return process.env.METRICS_WORKFLOW_REFRESH_LEADER === "true";
}

async function initIfNeeded(): Promise<MetricsBundle | null> {
  if (!isNode()) return null;
  if (g.__pawtograderMetrics) return g.__pawtograderMetrics;
  if (g.__pawtograderMetricsInit) return g.__pawtograderMetricsInit;
  g.__pawtograderMetricsInit = buildBundle().finally(() => {
    g.__pawtograderMetricsInit = undefined;
  });
  return g.__pawtograderMetricsInit;
}

async function buildBundle(): Promise<MetricsBundle> {
  const promClient = await import("prom-client");
  const registry = new promClient.Registry();
  promClient.collectDefaultMetrics({ register: registry, prefix: "web_" });

  const httpDuration = new promClient.Histogram({
    name: "web_http_request_duration_seconds",
    help: "Latency of HTTP request handlers, by route/method/status.",
    labelNames: ["route", "method", "status"],
    // Buckets tuned for app routes: most under 200ms, long tail to 30s
    // for streaming endpoints (LLM hint, calendar export).
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [registry]
  });

  const httpInFlight = new promClient.Gauge({
    name: "web_http_in_flight_requests",
    help: "Number of HTTP requests currently being handled.",
    labelNames: ["route"],
    registers: [registry]
  });

  const rpcDuration = new promClient.Histogram({
    name: "web_supabase_rpc_duration_seconds",
    help: "Duration of Supabase RPC / REST calls made from the server.",
    labelNames: ["rpc", "status"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry]
  });

  const rpcErrors = new promClient.Counter({
    name: "web_supabase_rpc_errors_total",
    help: "Count of failed Supabase RPC / REST calls.",
    labelNames: ["rpc", "code"],
    registers: [registry]
  });

  // ----- Deliberately absent: seven business counters that used to be
  // declared here and were never incremented from a single call site.
  // The web tier is structurally the wrong producer for all of them, so
  // they are not "TODO: instrument" — re-adding them here would recreate
  // metrics that can only ever read zero. The correct producer is:
  //
  //   web_submission_created_total    → pawtograder_submissions_created_total
  //   web_grading_action_total        → pawtograder_grading_actions_total
  //     These two were the only non-workflow web_* series the app-business
  //     dashboard actually queried, and they were also never incremented.
  //     Submissions are created by supabase/functions/autograder-create-
  //     submission (a Deno edge function); grading comments are written from
  //     lib/TableController.ts through a BROWSER Supabase client. Both now
  //     come from postgres_exporter custom queries in monitoring.yaml, under
  //     pawtograder_* names — a web_-prefixed metric produced by the exporter
  //     would send the next person debugging it to the wrong tier. The six
  //     dashboard panels were renamed to match (WS-APP).
  //
  //   web_submission_mutated_total    → postgres_exporter custom query
  //   web_rubric_check_action_total   → postgres_exporter custom query
  //   web_office_hours_event_total    → postgres_exporter custom query
  //     Business writes in this app go browser → PostgREST directly (there
  //     are exactly two "use server" files and both are auth-only), so no
  //     server-side code path ever observes a submission mutation, a rubric
  //     check apply/unapply, or an office-hours queue event. Count them
  //     where the rows land: charts/pawtograder/templates/monitoring.yaml,
  //     modelled on the existing pawtograder_active_submissions block.
  //
  //   web_realtime_broadcast_total    → postgres_exporter custom query
  //     Broadcasts are emitted by Postgres triggers calling realtime.send(),
  //     not by web code. (realtime-fanout.json still has two panels on this
  //     name; they read empty today and will be retargeted at the exporter
  //     query.)
  //
  //   web_edge_function_invocation_total → a producer on the functions pods
  //     lib/edgeFunctions.ts invokeEdgeFunction is the one shared wrapper,
  //     but the large majority of its importers are "use client", so the
  //     web tier would only ever see a small slice of real traffic.
  //     Authoritative per-function counts come from the edge runtime itself.
  //     Instrumenting the wrapper is also actively harmful: its dynamic
  //     import would pull prom-client into the client bundle regardless of
  //     the isNode() guard.
  //
  // See docs/operations/metrics-gap-remediation.md §4 (WS-APP, WS-EDGE).

  // ----- Workflow business gauges -----
  // These are refreshed on every /api/metrics scrape via
  // refreshWorkflowMetrics(); see that function for the SQL.
  const workflowRunsRecent = new promClient.Gauge({
    name: "web_workflow_runs_recent",
    help: "Autograder workflow runs that completed in the recent window, by class + conclusion.",
    labelNames: ["class_id", "conclusion", "window"],
    registers: [registry]
  });

  const workflowQueueSeconds = new promClient.Gauge({
    name: "web_workflow_queue_seconds",
    help: "Time from workflow_runs.requested_at to in_progress_at, percentile gauges over a 1h window.",
    labelNames: ["class_id", "quantile"],
    registers: [registry]
  });

  const workflowRunSeconds = new promClient.Gauge({
    name: "web_workflow_run_seconds",
    help: "Time from workflow_runs.in_progress_at to completed_at, percentile gauges over a 1h window.",
    labelNames: ["class_id", "quantile"],
    registers: [registry]
  });

  const workflowErrorsRecent = new promClient.Gauge({
    name: "web_workflow_errors_recent",
    help: "workflow_run_error rows logged in the recent window, by class + closed error category.",
    labelNames: ["class_id", "category", "window"],
    registers: [registry]
  });

  // Leader-only, and the conditional is load-bearing — see the field comment on
  // MetricsBundle. The env var is the SAME one app/api/metrics/route.ts gates
  // refreshWorkflowMetrics() on, so a process that would never refresh also
  // never claims to have refreshed. It is read once, here, because the registry
  // is built once per process and the variable is fixed for a pod's lifetime
  // (instrumentation.ts warms this at boot).
  const workflowRefreshLastSuccess = isWorkflowRefreshLeader()
    ? new promClient.Gauge({
        name: "web_workflow_metrics_last_success_timestamp_seconds",
        help: "Unix time of the last fully successful workflow-metrics refresh. Emitted even when every aggregate returns zero rows, so absence means the producer is broken rather than idle. Exported only by the metrics-leader process.",
        registers: [registry]
      })
    : undefined;

  const workflowRefreshDuration = new promClient.Histogram({
    name: "web_workflow_metrics_refresh_seconds",
    help: "Time spent refreshing workflow gauges from the DB.",
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry]
  });

  const workflowRefreshErrors = new promClient.Counter({
    name: "web_workflow_metrics_refresh_errors_total",
    help: "Refresh failures by SQL step (workflow_runs / queue_seconds / run_seconds / workflow_run_error).",
    labelNames: ["step"],
    registers: [registry]
  });

  g.__pawtograderMetrics = {
    registry,
    httpDuration,
    httpInFlight,
    rpcDuration,
    rpcErrors,
    workflowRunsRecent,
    workflowQueueSeconds,
    workflowRunSeconds,
    workflowErrorsRecent,
    workflowRefreshDuration,
    workflowRefreshErrors,
    workflowRefreshLastSuccess,
    lastWorkflowRefreshMs: 0
  };

  return g.__pawtograderMetrics;
}

// Snapshot getter — returns null on Edge, never throws on Node.
// Callers should `await this()` and then `m?.<metric>.inc()` etc.
export async function getMetrics() {
  return initIfNeeded();
}

// Bucket an HTTP status code into a status CLASS: "2xx" / "4xx" / "5xx".
//
// This is applied unconditionally inside timeHttp rather than left to callers,
// because the label it feeds is on a 12-bucket histogram: every distinct status
// value costs 14 series per route per method. Exact codes roughly double the
// http family for no diagnostic gain — nothing on the dashboards distinguishes
// a 401 from a 403, and the exact code is in the Sentry event and the access
// log for anyone who needs it. Anything outside 100-599 (a handler returning a
// nonsense status) lands in "other" rather than inventing a bucket.
export function bucketStatus(status: number): string {
  if (!Number.isFinite(status)) return "other";
  const klass = Math.floor(status / 100);
  if (klass < 1 || klass > 5) return "other";
  return `${klass}xx`;
}

// Time-an-HTTP-handler helper. Returns the handler return value.
// Safe to wrap every API route. Status defaults to 200 when the handler
// returns; if it throws we record status=5xx and re-throw.
export async function timeHttp<T>(
  route: string,
  method: string,
  fn: () => Promise<T>,
  // Pass the actual status when the handler returns a Response so we can
  // label correctly (Next.js Route Handlers return Response). Falls back
  // to inspecting the Response object if T extends Response. The value is
  // bucketed by bucketStatus() before it becomes a label.
  statusOf?: (result: T) => number
): Promise<T> {
  const m = await initIfNeeded();
  if (!m) return fn();
  const end = m.httpDuration.startTimer({ route, method });
  m.httpInFlight.inc({ route });
  try {
    const result = await fn();
    const status = statusOf?.(result) ?? (result instanceof Response ? result.status : 200);
    end({ status: bucketStatus(status) });
    return result;
  } catch (e) {
    // A throw that escapes the handler is a 500 to the client, whatever
    // Next.js ends up serialising.
    end({ status: "5xx" });
    throw e;
  } finally {
    m.httpInFlight.dec({ route });
  }
}

// Normalize whatever a caller hands us into a BOUNDED `code` label value for
// web_supabase_rpc_errors_total.
//
// This exists because the obvious call site is
//   classify: (r) => ({ status: "error", errorCode: r.error?.message })
// and a PostgREST error message is free-form, frequently contains the offending
// value, and is therefore unbounded cardinality on a counter — the classic way
// to take a Prometheus down. Postgres SQLSTATEs are exactly five characters of
// [0-9A-Z]; anything that is not one of those (a message, a PostgREST "PGRST116"
// style code, undefined) collapses to "unknown". The literal "throw" is the one
// deliberate exception, distinguishing "the call rejected" from "the call
// resolved with an error payload".
const SQLSTATE_RE = /^[0-9A-Z]{5}$/;

// The CLOSED set of `rpc` label values. web_supabase_rpc_duration_seconds is an
// 11-bucket histogram with a status label, so each entry here costs ~26 series
// per pod; the counter adds a few more. Keeping this a union type rather than
// `string` means adding a call site is a deliberate edit to this list that a
// reviewer sees, instead of a label that quietly appears in production.
//
// Cap: ~15. If this list wants to grow past that, the answer is almost always a
// coarser label, not a longer list.
export const RPC_LABELS = [
  // SSR boundary — lib/ssrUtils.ts, lib/ssr-course-dashboard.ts. These are the
  // slowest server-side DB calls in the app and the only substitute signal for
  // RSC page render cost (there is no seam to time an RSC render; see
  // lib/routeMetrics.ts).
  "ssr_user_roles",
  "ssr_course",
  "ssr_course_controller",
  "ssr_assignment_controller",
  "ssr_dashboard_overview_metrics",
  "ssr_workflow_statistics",
  // LTI — lib/lti/grades.ts, lib/lti/roster.ts. Reached from the live
  // /api/lti/push-grades and /api/lti/sync-roster route handlers.
  "lti_upsert_line_item",
  "lti_sis_sync_enrollment"
] as const;

export type RpcLabel = (typeof RPC_LABELS)[number];

export function normalizeRpcErrorCode(code: unknown): string {
  if (code === "throw") return "throw";
  if (typeof code !== "string") return "unknown";
  return SQLSTATE_RE.test(code) ? code : "unknown";
}

// Time-a-Supabase-call helper. Use sparingly — wrap the boundary RPCs
// at the SSR entry points, not every read. status is "ok" / "error";
// errorCode should be a PG SQLSTATE and is normalized either way.
//
// The `rpc` label is a HARDCODED short constant per call site, never a value
// derived from the request. See lib/ssrUtils.ts for the allowlist.
export async function timeRpc<T>(
  rpc: RpcLabel,
  fn: () => Promise<T>,
  classify: (result: T) => { status: string; errorCode?: string }
): Promise<T> {
  const m = await initIfNeeded();
  if (!m) return fn();
  const end = m.rpcDuration.startTimer({ rpc });
  try {
    const result = await fn();
    const c = classify(result);
    end({ status: c.status });
    if (c.errorCode !== undefined) m.rpcErrors.inc({ rpc, code: normalizeRpcErrorCode(c.errorCode) });
    return result;
  } catch (e) {
    end({ status: "error" });
    m.rpcErrors.inc({ rpc, code: "throw" });
    throw e;
  }
}

// Convenience classifier for the overwhelmingly common shape: a Supabase
// PostgrestResponse-like `{ error }`. Keeps every call site from re-deriving
// the same three lines (and from reaching for error.message).
export function classifySupabase(result: unknown): { status: string; errorCode?: string } {
  const error = (result as { error?: { code?: string | null } | null } | null | undefined)?.error;
  if (!error) return { status: "ok" };
  return { status: "error", errorCode: error.code ?? "unknown" };
}

// Refresh the workflow gauges from public.workflow_runs and
// public.workflow_run_error. Called at the start of the /api/metrics
// scrape so values reflect the last 1h / 24h aggregates.
//
// All queries pre-filter to rows newer than NOW() - 24h to bound
// cardinality; the older "1h" gauge is a strict subset of that window.
// Both DB calls run in parallel; an error in one doesn't kill the other.
//
// Cardinality budget per class — every bound here is STRUCTURAL, imposed by a
// closed set of label values, not by a row limit:
//   web_workflow_runs_recent  : 2 windows × ~6 conclusions = ~12 series
//   web_workflow_queue_seconds: 3 quantiles                = 3 series
//   web_workflow_run_seconds  : 2 quantiles                = 2 series
//   web_workflow_errors_recent: 7 categories × 1 window    = 7 series
//
// The error family used to carry workflow_run_error.name, which is the
// student-visible sentence — free text, capped only at 500 chars, and several
// producers embed a commit sha in it. The old RPC's LIMIT 200 did not bound
// that: it caps ONE call, while Prometheus retains every series it has ever
// seen, so an error storm with distinct messages minted hundreds of new series
// per refresh interval. It was also a global top-N, so one noisy class could
// evict every other class from the gauge.
//
// metrics_workflow_errors_by_category
// (supabase/migrations/20260904130000_workflow_error_category_metrics.sql)
// groups by a CASE that can only ever emit a literal from
// WORKFLOW_ERROR_CATEGORIES below, with no top-N. The full message stays in the
// database and on the instructor-facing workflow-errors page; it is not a label.
// WORKFLOW_ERROR_CATEGORIES is applied again on this side so an older or
// hand-edited RPC cannot widen the label domain either.
//
// For a deployment with 100 active classes that's ~2.4k series — well under
// kube-prometheus-stack defaults.
// The CLOSED set of web_workflow_errors_recent `category` label values. Must
// stay in step with the CASE in metrics_workflow_errors_by_category; anything
// the RPC returns that is not in this list is recorded as "other" rather than
// becoming a new series. That double bound is deliberate — the migration is the
// primary mechanism, this is what makes a stale database unable to break the
// cardinality budget.
export const WORKFLOW_ERROR_CATEGORIES = [
  "file_too_large",
  "submission_too_large",
  "empty_submission",
  "after_due_date",
  "missing_grader_result",
  "grader",
  "other"
] as const;

const WORKFLOW_ERROR_CATEGORY_SET: ReadonlySet<string> = new Set(WORKFLOW_ERROR_CATEGORIES);

export function normalizeWorkflowErrorCategory(value: unknown): string {
  return typeof value === "string" && WORKFLOW_ERROR_CATEGORY_SET.has(value) ? value : "other";
}

// Minimum seconds between two real DB refreshes, from
// METRICS_WORKFLOW_REFRESH_INTERVAL_SECONDS (chart:
// web.metricsLeader.refreshIntervalSeconds). Default 300. A literal 0 disables
// the throttle and is meant for tests only. Anything unparseable falls back to
// the default rather than to 0 — a typo must not silently remove the bound.
export const DEFAULT_WORKFLOW_REFRESH_INTERVAL_SECONDS = 300;

function refreshIntervalMs(): number {
  const raw = process.env.METRICS_WORKFLOW_REFRESH_INTERVAL_SECONDS;
  if (raw === undefined || raw === "") return DEFAULT_WORKFLOW_REFRESH_INTERVAL_SECONDS * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_WORKFLOW_REFRESH_INTERVAL_SECONDS * 1000;
  return n * 1000;
}

export async function refreshWorkflowMetrics(): Promise<void> {
  const m = await initIfNeeded();
  if (!m) return;

  // Single-flight. The timestamp throttle below is a check-then-act race on its
  // own: two concurrent authorized scrapes (a second Prometheus, an overlapping
  // curl loop, a slow refresh that outlives its scrape interval) both read the
  // old lastWorkflowRefreshMs before either pass finishes, and each launches all
  // five aggregate RPCs. That multiplies exactly the expensive DB work the
  // throttle exists to bound, under exactly the conditions that produced it.
  //
  // Concurrent callers therefore await the SAME pass. The promise is stored on
  // the global bundle (not a module-local) for the same reason the registry is:
  // Next.js re-instantiates modules per request in dev and on route-handler
  // re-import in prod.
  //
  // Cleared in a finally, on success AND failure, so one rejection cannot wedge
  // every future refresh. runWorkflowRefresh() already swallows RPC errors into
  // web_workflow_metrics_refresh_errors_total, so a rejection here would mean
  // something unexpected; it propagates to whoever is awaiting rather than being
  // hidden, and the next call starts a fresh pass either way.
  if (m.workflowRefreshInFlight) {
    await m.workflowRefreshInFlight;
    return;
  }

  const pass = runWorkflowRefresh(m).finally(() => {
    m.workflowRefreshInFlight = undefined;
  });
  m.workflowRefreshInFlight = pass;
  await pass;
}

async function runWorkflowRefresh(m: MetricsBundle): Promise<void> {
  // Throttle. The gauges are .set()-persisted in the registry between scrapes,
  // so returning here still exports the last-good values — a scrape served from
  // a value up to one interval old is correct, not stale data.
  //
  // This is deliberately NOT the ServiceMonitor's job. The scrape interval is a
  // cluster-side setting; this is the only bound that survives a second
  // Prometheus, a hand-edited ServiceMonitor, or an operator running a curl loop
  // against /api/metrics. Without it, /api/metrics is an unauthenticated-shaped
  // amplifier for five aggregate queries over public.workflow_runs.
  const intervalMs = refreshIntervalMs();
  if (intervalMs > 0 && m.lastWorkflowRefreshMs > 0 && Date.now() - m.lastWorkflowRefreshMs < intervalMs) {
    return;
  }

  // Set only on a fully successful pass (see the end of this function). A failed
  // refresh must NOT advance the clock: otherwise a database that is briefly
  // unreachable backs the leader off for a full interval instead of retrying on
  // the next scrape, turning a 30-second blip into 5 minutes of flat gauges.
  let allOk = true;
  const end = m.workflowRefreshDuration.startTimer();
  try {
    const { createAdminClient } = await import("@/utils/supabase/client");
    // Type-erase: the metrics_* RPCs land via supabase/migrations and are
    // regenerated into SupabaseTypes.d.ts on the next `npm run client-local`.
    // Until that lands the typed client throws on unknown RPC names, so this
    // helper opts out of the generic guard. The runtime behaviour is
    // identical to a strongly-typed call.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = createAdminClient() as any;

    // Run all four aggregate queries concurrently. Each returns its own
    // count → label dimension; the gauges are reset before each scrape
    // so stale class_ids don't linger when no rows match.
    const [runs1h, runs24h, queue, run, errors1h] = await Promise.allSettled([
      // Conclusions over the last hour.
      client.rpc("metrics_workflow_runs_by_conclusion", { window_hours: 1 }),
      // Conclusions over the last day (wider trend signal).
      client.rpc("metrics_workflow_runs_by_conclusion", { window_hours: 24 }),
      // Queue duration percentiles over the last hour.
      client.rpc("metrics_workflow_queue_percentiles", { window_hours: 1 }),
      // Run duration percentiles over the last hour.
      client.rpc("metrics_workflow_run_percentiles", { window_hours: 1 }),
      // Errors over the last hour.
      client.rpc("metrics_workflow_errors_by_category", { window_hours: 1 })
    ]);

    // Reset each family only after we know its fetch succeeded — otherwise
    // a transient RPC failure would wipe the last-good gauge snapshot and
    // the next scrape would export empty series. workflowRunsRecent is
    // shared between the 1h and 24h queries (distinguished by the `window`
    // label), so reset only when BOTH succeed; a single-window failure
    // leaves the previous values for that window intact.
    const runs1hOk = runs1h.status === "fulfilled" && !runs1h.value.error;
    const runs24hOk = runs24h.status === "fulfilled" && !runs24h.value.error;
    if (runs1hOk && runs24hOk) {
      m.workflowRunsRecent.reset();
    }
    if (runs1hOk) {
      for (const row of runs1h.value.data ?? []) {
        m.workflowRunsRecent.set(
          {
            class_id: String((row as { class_id: number | string }).class_id),
            conclusion: String((row as { conclusion: string }).conclusion ?? "unknown"),
            window: "1h"
          },
          Number((row as { count: number }).count)
        );
      }
    } else {
      m.workflowRefreshErrors.inc({ step: "workflow_runs_1h" });
      allOk = false;
    }
    if (runs24hOk) {
      for (const row of runs24h.value.data ?? []) {
        m.workflowRunsRecent.set(
          {
            class_id: String((row as { class_id: number | string }).class_id),
            conclusion: String((row as { conclusion: string }).conclusion ?? "unknown"),
            window: "24h"
          },
          Number((row as { count: number }).count)
        );
      }
    } else {
      m.workflowRefreshErrors.inc({ step: "workflow_runs_24h" });
      allOk = false;
    }

    if (queue.status === "fulfilled" && !queue.value.error) {
      m.workflowQueueSeconds.reset();
      for (const row of queue.value.data ?? []) {
        const cid = String((row as { class_id: number | string }).class_id);
        m.workflowQueueSeconds.set({ class_id: cid, quantile: "0.5" }, Number((row as { p50: number }).p50));
        m.workflowQueueSeconds.set({ class_id: cid, quantile: "0.95" }, Number((row as { p95: number }).p95));
        m.workflowQueueSeconds.set({ class_id: cid, quantile: "0.99" }, Number((row as { p99: number }).p99));
      }
    } else {
      m.workflowRefreshErrors.inc({ step: "queue_seconds" });
      allOk = false;
    }

    if (run.status === "fulfilled" && !run.value.error) {
      m.workflowRunSeconds.reset();
      for (const row of run.value.data ?? []) {
        const cid = String((row as { class_id: number | string }).class_id);
        m.workflowRunSeconds.set({ class_id: cid, quantile: "0.5" }, Number((row as { p50: number }).p50));
        m.workflowRunSeconds.set({ class_id: cid, quantile: "0.95" }, Number((row as { p95: number }).p95));
      }
    } else {
      m.workflowRefreshErrors.inc({ step: "run_seconds" });
      allOk = false;
    }

    if (errors1h.status === "fulfilled" && !errors1h.value.error) {
      m.workflowErrorsRecent.reset();
      for (const row of errors1h.value.data ?? []) {
        m.workflowErrorsRecent.set(
          {
            class_id: String((row as { class_id: number | string }).class_id),
            category: normalizeWorkflowErrorCategory((row as { category?: unknown }).category),
            window: "1h"
          },
          Number((row as { count: number }).count)
        );
      }
    } else {
      m.workflowRefreshErrors.inc({ step: "errors_1h" });
      allOk = false;
    }
  } catch {
    // Don't let metric collection failures bubble up — the scrape should
    // still return whatever is currently in the registry.
    m.workflowRefreshErrors.inc({ step: "refresh" });
    allOk = false;
  } finally {
    end();
    if (allOk) {
      m.lastWorkflowRefreshMs = Date.now();
      // The liveness sentinel. Set on every fully successful pass INCLUDING one
      // where every aggregate returned zero rows — an idle deployment (a fresh
      // install, a weekend, between terms) legitimately produces no completed
      // workflow runs, so the labelled gauges have no samples at all and
      // absent(web_workflow_runs_recent) would fire a guaranteed false warning.
      // This series is unconditional, so its absence means "the leader is not
      // running or not being scraped", which is the condition worth alerting on.
      // See PawtograderWorkflowMetricsStale in
      // charts/pawtograder/templates/prometheus-rules.yaml.
      // Optional: undefined on a non-leader process, which cannot reach this
      // path through /api/metrics anyway (the route gates the whole refresh on
      // the same variable).
      m.workflowRefreshLastSuccess?.set(Date.now() / 1000);
    }
  }
}
