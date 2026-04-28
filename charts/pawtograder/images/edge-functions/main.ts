// Main service for the self-hosted Pawtograder edge-runtime image.
//
// edge-runtime accepts one HTTP request and routes it to a per-function
// worker based on the first path segment after `/`. All 49 pawtograder
// functions set `verify_jwt = false` and validate auth in-function, so
// this main service does no JWT verification — it's a thin demuxer.
//
// This file is COPYed into /home/deno/functions/main/index.ts at image
// build time.

console.log("pawtograder edge-functions main started");

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const pathParts = url.pathname.split("/").filter(Boolean);
  const serviceName = pathParts[0];

  if (!serviceName) {
    return new Response(
      JSON.stringify({ msg: "missing function name in request path" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const servicePath = `/home/deno/functions/${serviceName}`;

  try {
    const envVarsObj = Deno.env.toObject();
    const envVars = Object.keys(envVarsObj).map(
      (k) => [k, envVarsObj[k]] as [string, string],
    );

    // @ts-ignore EdgeRuntime is provided by supabase/edge-runtime
    const worker = await EdgeRuntime.userWorkers.create({
      servicePath,
      memoryLimitMb: 256,
      workerTimeoutMs: 5 * 60 * 1000,
      noModuleCache: false,
      importMapPath: null,
      envVars,
    });

    return await worker.fetch(req);
  } catch (e) {
    console.error(`error invoking ${serviceName}:`, e);
    return new Response(
      JSON.stringify({ msg: (e as Error).toString() }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
});
