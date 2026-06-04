// Main service for the self-hosted Pawtograder edge-runtime image.
//
// edge-runtime accepts one HTTP request and routes it to a per-function
// worker based on the first path segment after `/`. All 49 pawtograder
// functions set `verify_jwt = false` and validate auth in-function, so
// this main service does no JWT verification — it's a thin demuxer.
//
// === eszip loading (the per-isolate memory fix) ===
// Each function is pre-bundled into an `.eszip` at image build time
// (see the Dockerfile bundler stage). We hand those bytes to
// userWorkers.create() via maybeEszip/maybeEntrypoint instead of pointing
// the worker at raw .ts on disk. This matters because raw servicePath mode
// makes every isolate fetch its remote deps (octokit, supabase-js, sentry…)
// over the network and run the Deno transpiler, holding the whole TS source
// graph in the isolate heap — measured at ~150–250MB for a heavy function
// like autograder-create-submission, which sits right at the 256MB cap and
// tips over under burst. eszip ships the graph pre-transpiled and vendored,
// so the same function's isolates measured ~16–20MB marginal each (4 heavy
// isolates: 243MB raw → 100MB eszip). This is how supabase.com fits the same
// function under far higher load at the same 256MB ceiling.
//
// If an eszip is missing for a requested function we fall back to raw
// servicePath so the demuxer still works (e.g. a function added without a
// rebundle) — just without the memory win.
//
// === worker lifecycle ===
// It mirrors the worker lifecycle handling of supabase's stock main service
// (examples/main/index.ts): per-worker isolates are reused across requests
// and the runtime *retires* one when it nears its memory / CPU-time /
// wall-clock limit. The critical part is retrying `WorkerAlreadyRetired` on a
// fresh worker — without it, a request that lands on an about-to-die worker
// just fails. CPU-time soft/hard limits let the runtime retire busy workers
// gracefully rather than only ever killing on a hard memory hit mid-request.
//
// All limits are env-tunable (no rebuild needed to adjust):
//   EDGE_WORKER_MEMORY_LIMIT_MB (default 256, matches supabase.com)
//   EDGE_WORKER_TIMEOUT_MS      (default 400000 = 400s worker lifetime)
//   EDGE_WORKER_CPU_SOFT_MS     (default 2000 — matches hosted's 2s; graceful retire → frequent recycling)
//   EDGE_WORKER_CPU_HARD_MS     (default 5000 — hard kill with headroom; CPU time excludes async I/O)
//   EDGE_WORKER_LOW_MEMORY_MULTIPLIER (default 2 — memory early-drop at ~50%, the hosted "EarlyDrop")
//   EDGE_ESZIP_DIR              (default /home/deno/eszips — where build-time bundles live)
//
// This file is COPYed into /home/deno/functions/main/index.ts at image
// build time.

console.log("pawtograder edge-functions main started");

const MEMORY_LIMIT_MB = Number(Deno.env.get("EDGE_WORKER_MEMORY_LIMIT_MB")) || 256;
const WORKER_TIMEOUT_MS = Number(Deno.env.get("EDGE_WORKER_TIMEOUT_MS")) || 400 * 1000;
const CPU_SOFT_MS = Number(Deno.env.get("EDGE_WORKER_CPU_SOFT_MS")) || 2000;
const CPU_HARD_MS = Number(Deno.env.get("EDGE_WORKER_CPU_HARD_MS")) || 5000;
// Memory early-drop (the hosted "EarlyDrop" behaviour). When an isolate's memory
// crosses ~memoryLimitMb/lowMemoryMultiplier it FINISHES the current request and
// then retires — so a memory-heavy request (e.g. a grader tarball download)
// completes and returns a valid response instead of being force-killed when it
// would otherwise reach the hard memoryLimitMb mid-request. 2 ≈ hosted's "50% of
// any resource" threshold (~128MB at a 256MB limit). Without this the isolate
// has no memory soft limit and runs straight into the hard cap.
const LOW_MEMORY_MULTIPLIER = Number(Deno.env.get("EDGE_WORKER_LOW_MEMORY_MULTIPLIER")) || 2;
// Where the build-time eszip bundles live (one <function>.eszip per function).
const ESZIP_DIR = Deno.env.get("EDGE_ESZIP_DIR") || "/home/deno/eszips";
// Bound the retry recursion so a genuinely broken function can't loop forever.
const MAX_RETIRED_RETRIES = 5;

// Cache of loaded eszip bytes, keyed by function name. The value is a Promise
// so concurrent first-requests for the same function share a single disk read
// rather than each allocating their own ~40MB buffer (which under a 50-burst
// would be ~2GB of transient allocation in this main isolate). A resolved
// `null` means "no eszip on disk for this function" — fall back to raw
// servicePath and don't keep re-stat-ing the filesystem.
const eszipCache = new Map<string, Promise<Uint8Array | null>>();

// Snapshot the process env ONCE at startup. It's static for the lifetime of the
// pod, and this runs on the gateway hot path — recomputing it per request would
// churn allocations needlessly. Workers created below all receive this same array.
const envVars = Object.entries(Deno.env.toObject()) as [string, string][];

function loadEszip(name: string): Promise<Uint8Array | null> {
  let pending = eszipCache.get(name);
  if (!pending) {
    pending = Deno.readFile(`${ESZIP_DIR}/${name}.eszip`).catch((e) => {
      if (!(e instanceof Deno.errors.NotFound)) {
        console.error(`failed to read eszip for ${name}:`, (e as Error)?.message ?? e);
      }
      return null;
    });
    eszipCache.set(name, pending);
  }
  return pending;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const pathParts = url.pathname.split("/").filter(Boolean);
  const serviceName = pathParts[0];

  if (!serviceName) {
    return new Response(JSON.stringify({ msg: "missing function name in request path" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }

  // Reject anything that isn't a plain function-directory name (e.g. ".." or
  // "foo/bar"). All real pawtograder functions match this pattern; rejecting
  // the rest prevents path traversal under /home/deno/functions and the
  // eszip dir.
  if (!/^[a-zA-Z0-9_-]+$/.test(serviceName)) {
    return new Response(JSON.stringify({ msg: "invalid function name" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }

  const servicePath = `/home/deno/functions/${serviceName}`;

  const eszip = await loadEszip(serviceName);

  const createWorker = () => {
    const opts: Record<string, unknown> = {
      servicePath,
      memoryLimitMb: MEMORY_LIMIT_MB,
      lowMemoryMultiplier: LOW_MEMORY_MULTIPLIER,
      workerTimeoutMs: WORKER_TIMEOUT_MS,
      cpuTimeSoftLimitMs: CPU_SOFT_MS,
      cpuTimeHardLimitMs: CPU_HARD_MS,
      noModuleCache: false,
      importMapPath: null,
      envVars
    };
    if (eszip) {
      // Pre-bundled path: load the vendored, pre-transpiled module graph from
      // the eszip. The entrypoint key matches how the bundle was built in the
      // Dockerfile (--entrypoint /home/deno/functions/<name>/index.ts).
      opts.maybeEszip = eszip;
      opts.maybeEntrypoint = `file:///home/deno/functions/${serviceName}/index.ts`;
    }
    // @ts-ignore EdgeRuntime is provided by supabase/edge-runtime
    return EdgeRuntime.userWorkers.create(opts);
  };

  // Reuse the pooled worker for this function; on retirement, route to a fresh
  // one (create() won't hand back a retired worker). Mirrors the stock
  // callWorker() retry loop.
  const callWorker = async (attempt = 0): Promise<Response> => {
    try {
      const worker = await createWorker();
      return await worker.fetch(req);
    } catch (e) {
      const name = (e as { name?: string })?.name ?? "";
      const msg = (e as Error)?.message ?? String(e);

      // Worker was retired (memory / CPU / wall-clock limit) before it could
      // serve this request — retry on a fresh worker rather than failing.
      if ((name === "WorkerAlreadyRetired" || /retired/i.test(msg)) && attempt < MAX_RETIRED_RETRIES) {
        return await callWorker(attempt + 1);
      }

      // Worker died mid-request (supervisor hit a hard limit). The request is
      // unrecoverable here; surface 503 + Connection: close so the caller
      // (pg_net / cron / client) retries on its own cadence instead of us
      // hammering a fresh worker with the same expensive request.
      if (name === "WorkerRequestCancelled" || /cancel{1,2}ed/i.test(msg)) {
        return new Response(JSON.stringify({ msg: "worker request cancelled" }), {
          status: 503,
          headers: { "content-type": "application/json", "Connection": "close" }
        });
      }

      // Log the real error server-side, but return a fixed generic message — the
      // raw error can carry worker/runtime internals (paths, stack frames) and
      // this gateway is public-facing (CodeQL: information exposure via stack trace).
      console.error(`error invoking ${serviceName}:`, e);
      return new Response(JSON.stringify({ msg: "internal edge function error" }), {
        status: 500,
        headers: { "content-type": "application/json" }
      });
    }
  };

  return await callWorker();
});
