import * as Sentry from "@sentry/nextjs";

export const onRequestError = Sentry.captureRequestError;

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");

    // Build the Prometheus registry (and prom-client's default process/heap
    // collectors) at boot rather than on the first scrape. Without this, a pod
    // that has served no instrumented route yet answers /api/metrics with an
    // empty body, which reads on a dashboard exactly like "this pod is not
    // being scraped" — the failure this whole effort exists to fix. It also
    // means the first scrape after a rollout pays the prom-client import.
    // getMetrics() returns null and does nothing on any non-Node runtime.
    await (await import("./lib/metrics")).getMetrics();
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}
