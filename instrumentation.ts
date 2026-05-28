import * as Sentry from "@sentry/nextjs";

export const onRequestError = Sentry.captureRequestError;

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
    if (process.env.COVERAGE === "1") {
      await registerServerCoverageCollector();
    }
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

/**
 * Server-side coverage capture via the Node Inspector protocol.
 *
 * Why this exists: `NODE_V8_COVERAGE` does NOT capture scripts that
 * Next 15 loads via the `vm` module (vm.compileFunction /
 * vm.runInThisContext), which is how Server Component bundles are
 * executed. We verified this by dumping NODE_V8_COVERAGE from a real
 * `next start` and finding zero `.next/server/app/*` entries.
 *
 * `Profiler.startPreciseCoverage` (driven by the local
 * `node:inspector` Session) DOES see vm-loaded scripts because it
 * runs inside the same V8 isolate. We start coverage at server boot,
 * keep the session alive for the lifetime of the process, and write
 * the coverage data to `coverage/server-cdp.json` when we receive
 * SIGUSR2. The collect step then converts that JSON into lcov via
 * `monocart-coverage-reports` (the same library we use for client
 * coverage).
 *
 * Active only when `COVERAGE=1` is set.
 */
async function registerServerCoverageCollector(): Promise<void> {
  const inspector = await import("node:inspector");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  const session = new inspector.Session();
  session.connect();

  // Helper that wraps session.post in a Promise.
  const post = <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> =>
    new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (session as any).post(method, params ?? {}, (err: Error | null, result: T) => {
        if (err) reject(err);
        else resolve(result);
      });
    });

  await post("Profiler.enable");
  await post("Profiler.startPreciseCoverage", {
    callCount: true,
    detailed: true
  });

  const outputPath = path.resolve(process.cwd(), "coverage", "server-cdp.json");

  const flush = async () => {
    try {
      const { result } = await post<{ result: unknown[] }>("Profiler.takePreciseCoverage");
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, JSON.stringify({ result }));
      // eslint-disable-next-line no-console
      console.log(`[coverage] wrote ${result.length} V8 entries to ${outputPath}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[coverage] failed to take precise coverage:", err);
    }
  };

  // SIGUSR2 = "please dump coverage now". Sent by the workflow's
  // teardown step before stopping Next. Unlike SIGINT, this does not
  // terminate the process — coverage can be sampled multiple times.
  process.on("SIGUSR2", () => {
    void flush();
  });

  // Also flush on shutdown so a SIGINT/SIGTERM still captures
  // whatever coverage exists at exit time.
  const onShutdown = async () => {
    await flush();
    process.exit(0);
  };
  process.on("SIGTERM", () => void onShutdown());
  process.on("SIGINT", () => void onShutdown());

  // eslint-disable-next-line no-console
  console.log("[coverage] server-side precise coverage started");
}
