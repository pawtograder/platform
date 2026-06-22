// Prometheus scrape endpoint for the Next.js web app.
//
// Gated by METRICS_SCRAPE_TOKEN (constant-time compared). The bearer is
// injected by the ServiceMonitor in charts/pawtograder/templates/monitoring.yaml
// when monitoring.enabled=true. Without the env var set the endpoint
// returns 503 so we don't leak metrics on hostile networks.

import { createHash, timingSafeEqual } from "node:crypto";
import { getMetrics, refreshWorkflowMetrics } from "@/lib/metrics";

// prom-client uses Node-only APIs (process.cpuUsage, V8 GC hooks).
export const runtime = "nodejs";
// Always render fresh — never cache the registry snapshot.
export const dynamic = "force-dynamic";

function isAuthorized(headerValue: string | null): boolean {
  const expected = process.env.METRICS_SCRAPE_TOKEN;
  if (!expected) return false;
  if (!headerValue) return false;
  const m = headerValue.match(/^Bearer\s+(.+)$/);
  if (!m) return false;
  const presented = m[1];
  // Constant-time compare. Hash both sides to fixed-length digests so this is correct for
  // multi-byte/unicode tokens (Buffer.alloc(charLength)+write truncates UTF-8, which could make
  // two different tokens compare equal) and never throws on a length mismatch.
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(presented).digest();
  return timingSafeEqual(a, b);
}

export async function GET(req: Request): Promise<Response> {
  if (!process.env.METRICS_SCRAPE_TOKEN) {
    return new Response("metrics disabled (METRICS_SCRAPE_TOKEN not set)", {
      status: 503,
      headers: { "content-type": "text/plain" }
    });
  }
  if (!isAuthorized(req.headers.get("authorization"))) {
    return new Response("unauthorized", {
      status: 401,
      headers: { "content-type": "text/plain", "www-authenticate": "Bearer" }
    });
  }
  const m = await getMetrics();
  if (!m?.registry) {
    return new Response("metrics not initialized", {
      status: 503,
      headers: { "content-type": "text/plain" }
    });
  }
  // Refresh DB-backed business gauges (workflow runs, queue/run duration
  // percentiles, recent errors) at scrape time. Gated on
  // METRICS_WORKFLOW_REFRESH_LEADER=true so only ONE pod runs the
  // cluster-wide RPCs — without that gate every web replica would
  // execute the same admin RPCs on each Prometheus poll, multiplying
  // DB load by the replica count AND emitting duplicate global gauges
  // that downstream `sum()` queries would overcount.
  //
  // The chart sets the env var on a single dedicated replica (or on
  // index 0 of a StatefulSet, etc.). Other replicas still expose
  // node/process gauges from the same registry; only the workflow
  // family is leader-gated.
  //
  // Failures are swallowed inside the helper and surfaced as
  // web_workflow_metrics_refresh_errors_total so the scrape itself
  // never fails just because the DB is slow.
  if (process.env.METRICS_WORKFLOW_REFRESH_LEADER === "true") {
    await refreshWorkflowMetrics();
  }

  const body = await m.registry.metrics();
  return new Response(body, {
    status: 200,
    headers: { "content-type": m.registry.contentType }
  });
}
