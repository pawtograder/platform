// Build-time V8 coverage capture for Next.js Server Components.
//
// Preloaded via NODE_OPTIONS in the `build:coverage` npm script. Why:
//
//   `next build` runs a render pass ("Collecting page data" / "Generating
//   static pages") that EXECUTES every route's Server Components — to
//   classify them static/dynamic and to prerender the static ones. That
//   build-time execution is the only place a fully-static server shell (e.g.
//   a passthrough layout over a "use client" page) ever runs; at request time
//   its output is served from cache, so the runtime Inspector in
//   instrumentation.ts records it 0% covered. This hook attaches a
//   `node:inspector` Profiler to every build process (the main process and
//   any static-generation child workers, which inherit NODE_OPTIONS) and
//   dumps coverage/build-cdp-<pid>.json. v8-server-to-lcov.ts merges those
//   with the runtime server-cdp dumps.
//
// Capture must survive every exit mode:
//   - normal return / process.exit() → process.on("exit") does a SYNCHRONOUS
//     takePreciseCoverage (the inspector callback fires synchronously for a
//     connected in-process Session) + writeFileSync. This is the guaranteed
//     path and the one that matters for fast jest-worker children that
//     process.exit() before any timer fires.
//   - SIGTERM/SIGINT (jest-worker graceful shutdown) → converted to a clean
//     process.exit(0) so the "exit" handler runs.
//   - SIGKILL / hang → an unref'd periodic snapshot leaves the last complete
//     dump on disk (precise-coverage counts are cumulative; takePreciseCoverage
//     does not reset them, so the latest snapshot is complete-to-that-point).

"use strict";

if (process.env.COVERAGE === "1") {
  try {
    const inspector = require("node:inspector");
    const fs = require("node:fs");
    const path = require("node:path");

    const session = new inspector.Session();
    session.connect();

    const outDir = path.resolve(process.cwd(), "coverage");
    const outPath = path.join(outDir, `build-cdp-${process.pid}.json`);

    let started = false;

    // Keep only compiled Next server bundles — the .next/server/app|pages
    // chunks the converter can map back to source. Build runs spawn many
    // short-lived node processes (webpack workers, lint, etc.); without this
    // every one would write a dump containing just this hook + a few build
    // tools, producing hundreds of useless files for the converter to chew on.
    const keep = (r) => ((r && r.url) || "").includes("/.next/server/");

    const write = (result) => {
      const filtered = result.filter(keep);
      if (filtered.length === 0) return; // nothing renderable — skip
      fs.mkdirSync(outDir, { recursive: true });
      const tmp = `${outPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ result: filtered }));
      fs.renameSync(tmp, outPath);
    };

    // Synchronous capture — safe to call from process.on("exit"). Relies on
    // the connected Session dispatching the Profiler callback synchronously.
    const captureSync = () => {
      if (!started) return;
      try {
        let result = null;
        session.post("Profiler.takePreciseCoverage", (err, res) => {
          if (!err && res) result = res.result;
        });
        if (result) write(result);
      } catch {
        /* best-effort */
      }
    };

    // Async snapshot — periodic safety net for SIGKILL/hung processes.
    let inFlight = false;
    const snapshot = () => {
      if (!started || inFlight) return;
      inFlight = true;
      session.post("Profiler.takePreciseCoverage", (err, res) => {
        inFlight = false;
        if (!err && res) {
          try {
            write(res.result);
          } catch {
            /* best-effort */
          }
        }
      });
    };

    session.post("Profiler.enable", () => {
      session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true }, (err) => {
        if (!err) started = true;
      });
    });

    const timer = setInterval(snapshot, 4000);
    if (typeof timer.unref === "function") timer.unref();

    process.on("exit", captureSync);
    const onSignal = () => process.exit(0); // run the "exit" handler, then exit
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  } catch {
    // Inspector unavailable — silently skip; the build proceeds uninstrumented.
  }
}
