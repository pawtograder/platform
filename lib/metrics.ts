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
  submissionCreated: Counter<string>;
  submissionMutated: Counter<string>;
  gradingActions: Counter<string>;
  rubricCheckActions: Counter<string>;
  officeHoursEvents: Counter<string>;
  realtimeBroadcasts: Counter<string>;
  edgeFunctionInvocations: Counter<string>;

  // Workflow business gauges. Refreshed from the DB at scrape time —
  // see refreshWorkflowMetrics() below. These are the user-facing
  // success/failure + queue/run duration signals for the autograder
  // pipeline, derived from public.workflow_runs + public.workflow_run_error.
  workflowRunsRecent: Gauge<string>; // labels: class_id, conclusion, window
  workflowQueueSeconds: Gauge<string>; // labels: class_id, quantile
  workflowRunSeconds: Gauge<string>; // labels: class_id, quantile
  workflowErrorsRecent: Gauge<string>; // labels: class_id, name
  workflowRefreshDuration: Histogram<string>; // observed when refresh runs
  workflowRefreshErrors: Counter<string>;
};

// We attach state to globalThis so it survives Next.js's per-request
// module instantiation in dev (and route-handler re-imports in prod).
type GlobalWithMetrics = typeof globalThis & {
  __pawtograderMetrics?: MetricsBundle;
};

const g = globalThis as GlobalWithMetrics;

function isNode(): boolean {
  return process.env.NEXT_RUNTIME === "nodejs" || typeof process.env.NEXT_RUNTIME === "undefined";
}

async function initIfNeeded(): Promise<MetricsBundle | null> {
  if (!isNode()) return null;
  if (g.__pawtograderMetrics) return g.__pawtograderMetrics;

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

  const submissionCreated = new promClient.Counter({
    name: "web_submission_created_total",
    help: "Submissions created (counted in the create-submission code path).",
    labelNames: ["class_id"],
    registers: [registry]
  });

  const submissionMutated = new promClient.Counter({
    name: "web_submission_mutated_total",
    help: "Submission row mutations from the web app (re-grade, retract, swap).",
    labelNames: ["class_id", "action"],
    registers: [registry]
  });

  const gradingActions = new promClient.Counter({
    name: "web_grading_action_total",
    help: "Grading actions taken by graders (comment, mark, release).",
    labelNames: ["class_id", "kind"],
    registers: [registry]
  });

  const rubricCheckActions = new promClient.Counter({
    name: "web_rubric_check_action_total",
    help: "Rubric check apply / unapply events.",
    labelNames: ["class_id", "action"],
    registers: [registry]
  });

  const officeHoursEvents = new promClient.Counter({
    name: "web_office_hours_event_total",
    help: "Office-hours queue events emitted from the app (request, claim, close).",
    labelNames: ["class_id", "event"],
    registers: [registry]
  });

  const realtimeBroadcasts = new promClient.Counter({
    name: "web_realtime_broadcast_total",
    help: "Server-initiated realtime broadcasts via realtime.send().",
    labelNames: ["channel_class"],
    registers: [registry]
  });

  const edgeFunctionInvocations = new promClient.Counter({
    name: "web_edge_function_invocation_total",
    help: "Edge function invocations made from the web app.",
    labelNames: ["function", "status"],
    registers: [registry]
  });

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
    help: "workflow_run_error rows logged in the recent window, by class + error name.",
    labelNames: ["class_id", "name", "window"],
    registers: [registry]
  });

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
    submissionCreated,
    submissionMutated,
    gradingActions,
    rubricCheckActions,
    officeHoursEvents,
    realtimeBroadcasts,
    edgeFunctionInvocations,
    workflowRunsRecent,
    workflowQueueSeconds,
    workflowRunSeconds,
    workflowErrorsRecent,
    workflowRefreshDuration,
    workflowRefreshErrors
  };

  return g.__pawtograderMetrics;
}

// Snapshot getter — returns null on Edge, never throws on Node.
// Callers should `await this()` and then `m?.<metric>.inc()` etc.
export async function getMetrics() {
  return initIfNeeded();
}

// Time-an-HTTP-handler helper. Returns the handler return value.
// Safe to wrap every API route. Status defaults to 200 when the handler
// returns; if it throws we record status=500 and re-throw.
export async function timeHttp<T>(
  route: string,
  method: string,
  fn: () => Promise<T>,
  // Pass the actual status when the handler returns a Response so we can
  // label correctly (Next.js Route Handlers return Response). Falls back
  // to inspecting the Response object if T extends Response.
  statusOf?: (result: T) => number
): Promise<T> {
  const m = await initIfNeeded();
  if (!m) return fn();
  const end = m.httpDuration.startTimer({ route, method });
  m.httpInFlight.inc({ route });
  try {
    const result = await fn();
    const status = statusOf?.(result) ?? (result instanceof Response ? result.status : 200);
    end({ status: String(status) });
    return result;
  } catch (e) {
    end({ status: "500" });
    throw e;
  } finally {
    m.httpInFlight.dec({ route });
  }
}

// Time-a-Supabase-call helper. Use sparingly — wrap the boundary RPCs
// in TableController, not every read. status is "ok" / "error" / a PG
// SQLSTATE if you have one.
export async function timeRpc<T>(
  rpc: string,
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
    if (c.errorCode) m.rpcErrors.inc({ rpc, code: c.errorCode });
    return result;
  } catch (e) {
    end({ status: "error" });
    m.rpcErrors.inc({ rpc, code: "throw" });
    throw e;
  }
}

// Refresh the workflow gauges from public.workflow_runs and
// public.workflow_run_error. Called at the start of the /api/metrics
// scrape so values reflect the last 1h / 24h aggregates.
//
// All queries pre-filter to rows newer than NOW() - 24h to bound
// cardinality; the older "1h" gauge is a strict subset of that window.
// Both DB calls run in parallel; an error in one doesn't kill the other.
//
// Cardinality budget per class:
//   web_workflow_runs_recent  : 2 windows × ~6 conclusions = ~12 series
//   web_workflow_queue_seconds: 3 quantiles                = 3 series
//   web_workflow_run_seconds  : 2 quantiles                = 2 series
//   web_workflow_errors_recent: capped at 30 distinct names per class
//
// For a deployment with 100 active classes that's ~5k series — well under
// kube-prometheus-stack defaults.
export async function refreshWorkflowMetrics(): Promise<void> {
  const m = await initIfNeeded();
  if (!m) return;
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
      client.rpc("metrics_workflow_errors_by_name", { window_hours: 1 })
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
    }

    if (errors1h.status === "fulfilled" && !errors1h.value.error) {
      m.workflowErrorsRecent.reset();
      for (const row of errors1h.value.data ?? []) {
        m.workflowErrorsRecent.set(
          {
            class_id: String((row as { class_id: number | string }).class_id),
            name: String((row as { name: string }).name),
            window: "1h"
          },
          Number((row as { count: number }).count)
        );
      }
    } else {
      m.workflowRefreshErrors.inc({ step: "errors_1h" });
    }
  } catch {
    // Don't let metric collection failures bubble up — the scrape should
    // still return whatever is currently in the registry.
    m.workflowRefreshErrors.inc({ step: "refresh" });
  } finally {
    end();
  }
}
