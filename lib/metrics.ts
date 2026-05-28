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
    edgeFunctionInvocations
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
