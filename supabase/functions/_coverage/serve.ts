// Coverage-mode replacement for `supabase functions serve`.
//
// The Supabase edge-runtime (a forked Deno) does not support `--coverage`
// and the `functions serve` CLI does not forward Deno flags. To collect
// V8 coverage for our edge functions we run this single Deno process —
// under `deno run --coverage=DIR` — which imports every function module,
// captures each module's `Deno.serve(handler)` registration, then routes
// incoming requests by URL path to the matching captured handler.
//
// Limitations vs. real edge-runtime:
//   - No per-worker isolation, CPU/wallclock limits, or `EdgeRuntime.waitUntil`.
//   - No JWT verification. All 47 functions currently have verify_jwt = false
//     in config.toml; if any future function flips to true, replicate the
//     check here before dispatching.
//   - Requests originating from inside Postgres (pg_net) still target the
//     edge-runtime container — they will NOT hit this bootstrap unless
//     Kong is rerouted (planned for v2).

import { join } from "https://deno.land/std@0.224.0/path/mod.ts";

const FUNCTIONS_DIR = new URL("..", import.meta.url).pathname;
const PORT = Number(Deno.env.get("COVERAGE_FUNCTIONS_PORT") ?? 9998);

// Directories we never load as functions.
const SKIP_DIRS = new Set(["_shared", "_coverage"]);

type Handler = (req: Request, info?: unknown) => Response | Promise<Response>;
const handlers = new Map<string, Handler>();

// Monkey-patch Deno.serve *before* importing any function modules.
// Each function calls Deno.serve(handler) at module top level; we capture
// the handler reference instead of letting it bind a port.
const realServe = Deno.serve.bind(Deno);
let currentlyLoading = "";

const stubServer = {
  finished: new Promise<void>(() => {}),
  shutdown: async () => {},
  ref: () => {},
  unref: () => {},
  addr: { hostname: "127.0.0.1", port: 0, transport: "tcp" as const }
};

// deno-lint-ignore no-explicit-any
(Deno as any).serve = (...args: unknown[]): unknown => {
  // Supported signatures we need to accept:
  //   Deno.serve(handler)
  //   Deno.serve(options, handler)
  //   Deno.serve({ handler, ...options })
  let handler: Handler | undefined;
  if (args.length === 1) {
    const a = args[0];
    if (typeof a === "function") handler = a as Handler;
    else if (a && typeof a === "object" && "handler" in (a as Record<string, unknown>)) {
      handler = (a as { handler: Handler }).handler;
    }
  } else if (args.length >= 2) {
    handler = args[1] as Handler;
  }
  if (!handler) {
    throw new Error(
      `[coverage-bootstrap] could not extract handler from Deno.serve() in function "${currentlyLoading}"`
    );
  }
  if (!currentlyLoading) {
    console.warn(`[coverage-bootstrap] Deno.serve called outside of a function load — ignoring`);
    return stubServer;
  }
  handlers.set(currentlyLoading, handler);
  return stubServer;
};

async function listFunctionDirs(): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(FUNCTIONS_DIR)) {
    if (!entry.isDirectory) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".")) continue;
    try {
      await Deno.stat(join(FUNCTIONS_DIR, entry.name, "index.ts"));
      names.push(entry.name);
    } catch {
      // No index.ts — skip.
    }
  }
  return names.sort();
}

async function loadAll(): Promise<{ failed: string[] }> {
  const names = await listFunctionDirs();
  const failed: string[] = [];
  console.log(`[coverage-bootstrap] loading ${names.length} functions`);
  for (const name of names) {
    currentlyLoading = name;
    try {
      await import(`../${name}/index.ts`);
    } catch (err) {
      console.error(`[coverage-bootstrap] failed to load ${name}:`, err);
      failed.push(name);
    }
  }
  currentlyLoading = "";
  console.log(`[coverage-bootstrap] registered ${handlers.size} handlers`);
  if (failed.length > 0) {
    console.error(`[coverage-bootstrap] ${failed.length} function(s) failed to load: ${failed.join(", ")}`);
  }
  return { failed };
}

const { failed } = await loadAll();
// In CI we want bootstrap startup to fail visibly if any function
// module errored at import time — silent partial registration produces
// misleading "function not covered" results that look like a test
// problem. Set ALLOW_PARTIAL_LOAD=1 for local debugging when a
// dependency is intentionally missing (e.g., GITHUB_PRIVATE_KEY_STRING).
if (failed.length > 0 && Deno.env.get("ALLOW_PARTIAL_LOAD") !== "1") {
  console.error(`[coverage-bootstrap] aborting: ${failed.length} module(s) failed to load`);
  Deno.exit(1);
}

realServe({ port: PORT, hostname: "0.0.0.0" }, async (req) => {
  const url = new URL(req.url);
  // Accept both shapes the Supabase JS SDK and direct callers use:
  //   /functions/v1/<name>[/...]
  //   /<name>[/...]
  const m = url.pathname.match(/^\/(?:functions\/v1\/)?([^/]+)(\/.*)?$/);
  if (!m) return new Response("not found", { status: 404 });
  const [, name] = m;
  if (name === "__health__") return new Response("ok");
  if (name === "__functions__") {
    return new Response(JSON.stringify({ functions: [...handlers.keys()] }), {
      headers: { "content-type": "application/json" }
    });
  }
  const handler = handlers.get(name);
  if (!handler) {
    return new Response(`unknown function: ${name}`, { status: 404 });
  }
  try {
    return await handler(req, {});
  } catch (err) {
    // Log the real error server-side; return a generic body to the
    // caller so we don't leak stack traces (flagged by CodeQL).
    console.error(`[coverage-bootstrap] handler ${name} threw:`, err);
    return new Response(JSON.stringify({ error: "internal server error" }), {
      status: 500,
      headers: { "content-type": "application/json" }
    });
  }
});

console.log(`[coverage-bootstrap] listening on http://0.0.0.0:${PORT}`);
