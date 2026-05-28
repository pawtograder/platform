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
  // Webpack tries to bundle instrumentation.ts for BOTH runtimes
  // (nodejs + edge). The edge runtime cannot resolve `node:*`
  // builtins and would fail the build. `/* webpackIgnore: true */`
  // tells webpack to leave the import alone — it stays a runtime
  // dynamic import, which only resolves on the nodejs runtime where
  // these modules exist (and where we'd actually reach this code,
  // gated above on NEXT_RUNTIME === "nodejs").
  const inspector = await import(/* webpackIgnore: true */ "node:inspector");
  const fs = await import(/* webpackIgnore: true */ "node:fs/promises");
  const path = await import(/* webpackIgnore: true */ "node:path");

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

  // PID-suffixed filename: Next forks a primary process plus one or
  // more render workers, all of which load instrumentation.ts and
  // register the SIGUSR2 handler. Without a unique filename per
  // process, concurrent writes interleave and produce a single
  // malformed JSON. The converter globs `server-cdp-*.json`.
  const outputPath = path.resolve(process.cwd(), "coverage", `server-cdp-${process.pid}.json`);

  const flush = async () => {
    try {
      const { result } = await post<{ result: Array<{ url?: string }> }>("Profiler.takePreciseCoverage");
      // Filter out node:* builtins and node_modules entries that the
      // converter would drop anyway. Without this, server-cdp.json
      // is ~30-50% larger and the CI runner can blow past its disk
      // quota when Playwright also keeps screenshots/traces around.
      const filtered = result.filter((r) => {
        const u = r?.url ?? "";
        if (!u) return false;
        if (u.startsWith("node:")) return false;
        if (u.includes("/node_modules/")) return false;
        return true;
      });
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      // Atomic write: a re-entrant flush (e.g. SIGUSR2 then SIGTERM)
      // would otherwise truncate-then-append-mid-stream and produce
      // malformed JSON. Write to a tempfile and rename so the final
      // file is either the previous version or the new one, never a
      // half-write.
      const tmpPath = `${outputPath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify({ result: filtered }));
      await fs.rename(tmpPath, outputPath);
      // eslint-disable-next-line no-console
      console.log(`[coverage] wrote ${filtered.length}/${result.length} V8 entries to ${outputPath}`);
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
