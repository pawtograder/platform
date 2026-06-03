// Main service for the self-hosted Pawtograder edge-runtime image.
//
// edge-runtime accepts one HTTP request and routes it to a per-function
// worker based on the first path segment after `/`. All 49 pawtograder
// functions set `verify_jwt = false` and validate auth in-function, so
// this main service does no JWT verification — it's a thin demuxer.
//
// It mirrors the worker lifecycle handling of supabase's stock main service
// (examples/main/index.ts): per-worker isolates are reused across requests
// and the runtime *retires* one when it nears its memory / CPU-time /
// wall-clock limit. The critical part is retrying `WorkerAlreadyRetired` on a
// fresh worker — without it, a request that lands on an about-to-die worker
// just fails, which is what made this self-hosted deploy fall over under load
// while supabase.com (same 150–256 MB ceiling) sustains it. CPU-time soft/hard
// limits let the runtime retire busy workers gracefully rather than only ever
// killing on a hard memory hit mid-request.
//
// All limits are env-tunable (no rebuild needed to adjust):
//   EDGE_WORKER_MEMORY_LIMIT_MB (default 256, matches supabase.com)
//   EDGE_WORKER_TIMEOUT_MS      (default 400000 = 400s worker lifetime)
//   EDGE_WORKER_CPU_SOFT_MS     (default 2000 — matches hosted's 2s; graceful retire → frequent recycling)
//   EDGE_WORKER_CPU_HARD_MS     (default 5000 — hard kill with headroom; CPU time excludes async I/O)
//
// This file is COPYed into /home/deno/functions/main/index.ts at image
// build time.

console.log("pawtograder edge-functions main started");

const MEMORY_LIMIT_MB = Number(Deno.env.get("EDGE_WORKER_MEMORY_LIMIT_MB")) || 256;
const WORKER_TIMEOUT_MS = Number(Deno.env.get("EDGE_WORKER_TIMEOUT_MS")) || 400 * 1000;
const CPU_SOFT_MS = Number(Deno.env.get("EDGE_WORKER_CPU_SOFT_MS")) || 2000;
const CPU_HARD_MS = Number(Deno.env.get("EDGE_WORKER_CPU_HARD_MS")) || 5000;
// Bound the retry recursion so a genuinely broken function can't loop forever.
const MAX_RETIRED_RETRIES = 5;

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
  // the rest prevents path traversal under /home/deno/functions.
  if (!/^[a-zA-Z0-9_-]+$/.test(serviceName)) {
    return new Response(JSON.stringify({ msg: "invalid function name" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }

  const servicePath = `/home/deno/functions/${serviceName}`;
  const envVarsObj = Deno.env.toObject();
  const envVars = Object.keys(envVarsObj).map((k) => [k, envVarsObj[k]] as [string, string]);

  const createWorker = () =>
    // @ts-ignore EdgeRuntime is provided by supabase/edge-runtime
    EdgeRuntime.userWorkers.create({
      servicePath,
      memoryLimitMb: MEMORY_LIMIT_MB,
      workerTimeoutMs: WORKER_TIMEOUT_MS,
      cpuTimeSoftLimitMs: CPU_SOFT_MS,
      cpuTimeHardLimitMs: CPU_HARD_MS,
      noModuleCache: false,
      importMapPath: null,
      envVars
    });

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

      console.error(`error invoking ${serviceName}:`, e);
      return new Response(JSON.stringify({ msg: msg }), {
        status: 500,
        headers: { "content-type": "application/json" }
      });
    }
  };

  return await callWorker();
});
