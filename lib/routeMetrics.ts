// Per-route Prometheus instrumentation for Next.js Route Handlers.
//
// WHY PER-ROUTE AND NOT MIDDLEWARE. The obvious place to time every request is
// middleware.ts, and it is unavailable: middleware runs on the Edge runtime
// (this app is Next 15.x and does not set experimental.nodeMiddleware), and
// prom-client is Node-only. lib/metrics.ts already no-ops on Edge, so a
// middleware-based attempt would not crash — it would silently record nothing,
// which is worse. So each Node route handler is wrapped by hand instead.
//
// RSC page renders are deliberately NOT covered. There is no seam short of
// middleware, and middleware is Edge. web_supabase_rpc_* (lib/ssrUtils.ts,
// lib/ssr-course-dashboard.ts) is the substitute signal for the server-side
// cost of a page render.
//
// THE `route` LABEL IS THE WHOLE RISK. It must be the literal parameterized
// pattern, hardcoded in the file it belongs to — "/api/calendar/[course_id]",
// never req.nextUrl.pathname. Using the real path turns `route` into a
// per-course label on a 12-bucket histogram, i.e. unbounded cardinality driven
// by a public URL. That is why this wrapper takes the pattern as an argument
// rather than deriving it: there is nothing here to get wrong at runtime.
//
// `status` is bucketed to 2xx/4xx/5xx by timeHttp -> bucketStatus().
//
// SERVER ONLY. This module reaches lib/metrics.ts, which does
// `await import("prom-client")`. If a "use client" module ever imports it,
// webpack splits prom-client into a client chunk and ships it to the browser —
// the isNode() guard does not prevent that, because it is a runtime check and
// the split is a build-time decision. tests/unit/prom-client-bundle.test.ts
// guards this.

import { bucketStatus, timeHttp } from "@/lib/metrics";

export { bucketStatus };

/**
 * Series cost, so it stays visible: web_http_request_duration_seconds is a
 * 12-bucket histogram, so 14 series per (route, method, status) combination,
 * plus 1 for web_http_in_flight_requests per route. With 18 handlers across 15
 * files and at most 3 status classes each, the ceiling is ~18 * 3 * 14 + 15
 * = ~771 series per web pod, and in practice far less because most routes only
 * ever see one or two status classes. Multiply by the pod count (3 web + 1
 * metrics-leader in prod).
 */

type RouteHandler<A extends unknown[], R> = (...args: A) => R | Promise<R>;

/**
 * Wrap a Next.js Route Handler so its latency, in-flight count and status class
 * land on web_http_*.
 *
 * @param routePattern The literal App Router path with its segments left
 *   parameterized, e.g. "/api/calendar/[course_id]". Hardcode it; never compute
 *   it from the request.
 * @param handler The route handler, unchanged.
 * @param method Optional HTTP method override. Normally the method is read off
 *   the Request that Next passes as the first argument; handlers that take no
 *   arguments at all (an `export async function OPTIONS()`) have nothing to
 *   read, so they pass it explicitly.
 */
export function withRouteMetrics<A extends unknown[], R extends Response>(
  routePattern: string,
  handler: RouteHandler<A, R>,
  method?: string
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    const first = args[0];
    const resolvedMethod = method ?? (first instanceof Request ? first.method : "UNKNOWN");
    return timeHttp<R>(
      routePattern,
      resolvedMethod,
      async () => handler(...args),
      (result) => (result instanceof Response ? result.status : 200)
    );
  };
}
