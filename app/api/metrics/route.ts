// Prometheus scrape endpoint for the Next.js web app.
//
// Gated by METRICS_SCRAPE_TOKEN (constant-time compared). The bearer is
// injected by the ServiceMonitor in charts/pawtograder/templates/monitoring.yaml
// when monitoring.enabled=true. Without the env var set the endpoint
// returns 503 so we don't leak metrics on hostile networks.

import { timingSafeEqual } from "node:crypto";
import { getMetrics } from "@/lib/metrics";

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
  // Pad to the longer of the two so timingSafeEqual doesn't throw on
  // length mismatch (which itself is timing-revealing).
  const len = Math.max(expected.length, presented.length);
  const a = Buffer.alloc(len);
  const b = Buffer.alloc(len);
  a.write(expected);
  b.write(presented);
  return timingSafeEqual(a, b) && expected.length === presented.length;
}

export async function GET(req: Request): Promise<Response> {
  if (!process.env.METRICS_SCRAPE_TOKEN) {
    return new Response(
      "metrics disabled (METRICS_SCRAPE_TOKEN not set)",
      { status: 503, headers: { "content-type": "text/plain" } }
    );
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
  const body = await m.registry.metrics();
  return new Response(body, {
    status: 200,
    headers: { "content-type": m.registry.contentType }
  });
}
