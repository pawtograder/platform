// Build-time V8 coverage capture for Next.js Server Components.
//
// Preloaded via NODE_OPTIONS="--require ./scripts/coverage/build-cdp-hook.cjs"
// during the coverage `next build`. Why this exists:
//
//   Server Components on routes whose server shell is fully static (e.g. a
//   passthrough layout over a "use client" page) are PRERENDERED at
//   `next build`. At request time their RSC output is served from the
//   prerender cache, so the component function never executes again and the
//   runtime Inspector path in instrumentation.ts records it as 0% covered —
//   even though the code genuinely ran (at build). This hook attaches a
//   `node:inspector` Profiler to every build process (the main process and
//   the static-generation workers, which inherit NODE_OPTIONS) and dumps
//   precise coverage to coverage/build-cdp-<pid>.json. v8-server-to-lcov.ts
//   then merges those dumps with the runtime server-cdp dumps.
//
// Robustness: Next's static-generation workers are jest-worker children that
// can terminate via process.exit() (no clean SIGTERM/beforeExit). V8 precise
// coverage counters are cumulative and takePreciseCoverage does NOT reset
// them, so we periodically overwrite the dump with a full snapshot; the last
// snapshot before a worker dies is always complete-to-that-point. We also
// flush on beforeExit / SIGTERM / SIGINT to capture the tail.

"use strict";

if (process.env.COVERAGE === "1") {
  try {
    const inspector = require("node:inspector");
    const fs = require("node:fs");
    const path = require("node:path");

    const session = new inspector.Session();
    session.connect();

    const post = (method, params) =>
      new Promise((resolve, reject) => {
        session.post(method, params || {}, (err, result) => (err ? reject(err) : resolve(result)));
      });

    const outDir = path.resolve(process.cwd(), "coverage");
    const outPath = path.join(outDir, `build-cdp-${process.pid}.json`);

    let started = false;
    let inFlight = null;

    const flush = () => {
      if (!started) return Promise.resolve();
      if (inFlight) return inFlight;
      inFlight = (async () => {
        try {
          const { result } = await post("Profiler.takePreciseCoverage");
          // Match instrumentation.ts: keep app code, drop node internals
          // and node_modules. Empty-url entries are anonymous evals.
          const filtered = result.filter((r) => {
            const u = (r && r.url) || "";
            if (!u) return false;
            if (u.startsWith("node:")) return false;
            if (u.includes("/node_modules/")) return false;
            return true;
          });
          fs.mkdirSync(outDir, { recursive: true });
          // Atomic overwrite so a snapshot is never observed half-written.
          const tmp = `${outPath}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify({ result: filtered }));
          fs.renameSync(tmp, outPath);
        } catch {
          // Best-effort — coverage capture must never break the build.
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    };

    (async () => {
      try {
        await post("Profiler.enable");
        await post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
        started = true;
      } catch {
        return;
      }
      // Periodic snapshot: the safety net for workers that exit via
      // process.exit() (no beforeExit/signal). unref() so it never keeps a
      // process alive on its own.
      const timer = setInterval(() => {
        void flush();
      }, 4000);
      if (typeof timer.unref === "function") timer.unref();
    })();

    process.on("beforeExit", () => {
      void flush();
    });
    const onSignal = () => {
      flush().finally(() => process.exit(0));
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  } catch {
    // Inspector unavailable — silently skip; the build proceeds uninstrumented.
  }
}
