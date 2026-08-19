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

// Per-request access log: one line per request tagged with the function name so
// logs are filterable BY function in Loki/Grafana/`scripts/edge-logs.sh`
// (`{component="functions"} |= "[fn=<name>]"`). All functions land in this one
// pod's stdout behind the demuxer, so without this tag you can't isolate one.
// `<name>` here is `serviceName` (the path segment) and matches the Prometheus
// `function` label (deno_http_requests_total{function=...}) the dashboard's $fn
// dropdown is built from. Set EDGE_ACCESS_LOG=0 to silence it (no rebuild).
const ACCESS_LOG = (Deno.env.get("EDGE_ACCESS_LOG") ?? "1") !== "0";

// Resident eszip bytes, keyed by function name, bounded by total BYTES held.
//
// 2026-08-19: this was an unbounded `Map<string, Promise<Uint8Array>>` and it
// was the edge tier's memory problem. Every eszip a pod had ever served stayed
// pinned in this main isolate, which lives as long as the pod, so RSS was
// "floor + whatever the pod happened to have served" and it climbed for days:
// 87Mi at startup, 667Mi at 1h, 1868-2408Mi at ~5d. The giveaway was that the
// spread across SAME-AGE pods tracked distinct functions served, not uptime and
// not request count — four 25-minute-old pods sat at 210/336/398/486Mi holding
// 2/3/3/4 functions. The ceiling is the whole bundle (`[bundle] done: 55 eszips,
// 2.2G total`, see the Dockerfile), and 2.2G of cache plus 8 admitted isolates
// at 256Mi each does not fit in the 4Gi container limit. That is the OOMKill:
// the limit was never a backstop, it was a deadline.
//
// Three structures now, because the three cases have genuinely different
// lifetimes and conflating them is what made the leak invisible:
//   * `inflight` preserves the ORIGINAL coalescing property this cache existed
//     for: concurrent first-requests for one function share a single disk read
//     instead of each allocating its own ~40MB buffer. Entries are dropped on
//     settle, so it holds at most `--max-parallelism` promises.
//   * `missing` is the negative cache. No eszip on disk means fall back to raw
//     servicePath; remembering that costs a string and saves a stat per
//     request, so it is kept for the pod's life. Note it is now populated ONLY
//     on NotFound — the old code cached the null from ANY read error, so one
//     transient EIO downgraded a function to raw servicePath permanently.
//   * `resident` is the positive cache: an LRU bounded by BYTES, not by entry
//     count. Entries run 19-59MB and averaging them is how you get surprised.
// Eviction is always safe: an in-progress worker creation already holds its own
// reference to the Uint8Array, so evicting only drops OURS.
const ESZIP_CACHE_MAX_BYTES = Number(
  Deno.env.get("EDGE_ESZIP_CACHE_MAX_BYTES") ?? 512 * 1024 * 1024
);
const inflight = new Map<string, Promise<Uint8Array | null>>();
const missing = new Set<string>();
const resident = new Map<string, Uint8Array>();
let residentBytes = 0;

const mb = (n: number) => (n / 1048576).toFixed(1);

// Mark `name` most-recently-used. Map iterates in insertion order, so
// delete + re-set is the entire LRU.
function touch(name: string, bytes: Uint8Array): void {
  resident.delete(name);
  resident.set(name, bytes);
}

function admit(name: string, bytes: Uint8Array): void {
  // A single eszip larger than the whole budget is served but never cached;
  // admitting it would evict everything else to hold one entry.
  if (bytes.byteLength > ESZIP_CACHE_MAX_BYTES) return;
  // Re-admission shouldn't happen (`inflight` coalesces, and a hit returns
  // early), but double-counting here would silently raise the bound this whole
  // structure exists to enforce, so account for it rather than assume.
  const existing = resident.get(name);
  if (existing) residentBytes -= existing.byteLength;
  touch(name, bytes);
  residentBytes += bytes.byteLength;
  // Evict oldest-first until back inside budget. The entry just admitted is
  // newest, so it cannot be evicted out from under this request.
  for (const victim of resident.keys()) {
    if (residentBytes <= ESZIP_CACHE_MAX_BYTES) break;
    const evicted = resident.get(victim)!;
    resident.delete(victim);
    residentBytes -= evicted.byteLength;
    console.log(
      `[eszip] evicted ${victim} (${mb(evicted.byteLength)}MB), resident ` +
        `${mb(residentBytes)}MB / ${mb(ESZIP_CACHE_MAX_BYTES)}MB, ${resident.size} functions`
    );
  }
}

// Snapshot the process env ONCE at startup. It's static for the lifetime of the
// pod, and this runs on the gateway hot path — recomputing it per request would
// churn allocations needlessly. Workers created below all receive this same array.
const envVars = Object.entries(Deno.env.toObject()) as [string, string][];

function loadEszip(name: string): Promise<Uint8Array | null> {
  const hit = resident.get(name);
  if (hit) {
    touch(name, hit);
    return Promise.resolve(hit);
  }
  if (missing.has(name)) return Promise.resolve(null);

  let pending = inflight.get(name);
  if (!pending) {
    pending = Deno.readFile(`${ESZIP_DIR}/${name}.eszip`)
      .then((bytes): Uint8Array | null => {
        admit(name, bytes);
        return bytes;
      })
      .catch((e) => {
        if (e instanceof Deno.errors.NotFound) {
          missing.add(name);
        } else {
          // Transient — deliberately NOT remembered, so the next request retries.
          console.error(`failed to read eszip for ${name}:`, (e as Error)?.message ?? e);
        }
        return null;
      })
      .finally(() => {
        inflight.delete(name);
      });
    inflight.set(name, pending);
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

  const createWorker = async () => {
    // Loaded HERE rather than once per request, so this reference lives only for
    // the duration of create() instead of for the whole request.
    //
    // It used to be hoisted above callWorker, which meant the closure held a
    // 19-59MB buffer for as long as worker.fetch() ran — up to the 400s worker
    // lifetime. Bundles the LRU has evicted, or that were too big to admit, are
    // not counted by residentBytes, so a cold burst could hold well over
    // eszipCacheMaxMb in buffers the budget knew nothing about. Narrowing the
    // window to create() does not make that term zero, but it takes it from
    // "the length of a request" to "the length of an admission", and the
    // remainder is covered by eszipColdLoadHeadroomMb in the chart's budget
    // assertion. A cache hit returns the already-counted buffer, so the steady
    // state after warmup costs nothing extra.
    const eszip = await loadEszip(serviceName);
    const opts: Record<string, unknown> = {
      servicePath,
      memoryLimitMb: MEMORY_LIMIT_MB,
      lowMemoryMultiplier: LOW_MEMORY_MULTIPLIER,
      workerTimeoutMs: WORKER_TIMEOUT_MS,
      cpuTimeSoftLimitMs: CPU_SOFT_MS,
      cpuTimeHardLimitMs: CPU_HARD_MS,
      noModuleCache: false,
      importMapPath: null,
      // Tell the isolate which function it's serving so its own logs can be
      // tagged (see _shared/HandlerUtils.ts). Passed as an env var rather than a
      // request header so the request object handed to worker.fetch() is left
      // completely untouched — reconstructing the Request breaks functions that
      // rely on its underlying stream resource (e.g. `metrics`). Safe because
      // the worker is created against this function's servicePath, so it only
      // ever serves `serviceName`.
      envVars: [...envVars, ["EDGE_FUNCTION_NAME", serviceName] as [string, string]]
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
      console.error(`[fn=${serviceName}] error invoking ${serviceName}:`, e);
      return new Response(JSON.stringify({ msg: "internal edge function error" }), {
        status: 500,
        headers: { "content-type": "application/json" }
      });
    }
  };

  const startedAt = Date.now();
  const res = await callWorker();
  if (ACCESS_LOG) {
    console.log(`[fn=${serviceName}] ${req.method} ${url.pathname} -> ${res.status} ${Date.now() - startedAt}ms`);
  }
  return res;
});
