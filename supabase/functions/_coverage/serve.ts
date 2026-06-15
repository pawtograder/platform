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
//   - No JWT verification. This is only sound for functions that set
//     verify_jwt = false in config.toml. Rather than trusting a comment to
//     stay accurate, we parse config.toml at load time and REFUSE to serve
//     any function that expects JWT (see assertNoJwtFunctions): otherwise a
//     future flip to verify_jwt = true would be served unauthenticated here
//     and the suite would stay green, silently masking the auth bypass.
//   - Requests originating from inside Postgres (pg_net) still target the
//     edge-runtime container — they will NOT hit this bootstrap unless
//     Kong is rerouted (planned for v2).

import { join } from "https://deno.land/std@0.224.0/path/mod.ts";

const FUNCTIONS_DIR = new URL("..", import.meta.url).pathname;
// `||` (not `??`) so an exported-but-empty COVERAGE_FUNCTIONS_PORT falls back
// to 9998 instead of Number("") === 0 (which would bind a random port and make
// the workflow's :9998 health check time out).
const PORT = Number(Deno.env.get("COVERAGE_FUNCTIONS_PORT") || 9998);

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

// In Deno 2.x `Deno.serve` is exposed as a getter-only accessor on the
// `Deno` namespace object, so a bare `Deno.serve = ...` assignment
// throws TypeError ("Cannot set property serve of #<Object> which has
// only a getter"). Object.defineProperty redefines the property in
// place. The descriptor must be configurable so the override sticks
// even if Deno re-defines it later in its bootstrap.
const patchedServe = (...args: unknown[]): unknown => {
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

Object.defineProperty(Deno, "serve", {
  value: patchedServe,
  writable: true,
  configurable: true
});

// Parse supabase/config.toml for the verify_jwt setting of every
// [functions.<name>] section. Supabase's default is verify_jwt = true, so a
// function is only safe to serve without auth here if it EXPLICITLY sets
// verify_jwt = false. Returns the set of names that do.
async function readVerifyJwtFalseSet(): Promise<Set<string>> {
  const safe = new Set<string>();
  const configPath = new URL("../../config.toml", import.meta.url).pathname;
  let text: string;
  try {
    text = await Deno.readTextFile(configPath);
  } catch (err) {
    throw new Error(`[coverage-bootstrap] cannot read config.toml at ${configPath}: ${err}`);
  }
  let currentFn = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const section = line.match(/^\[functions\.([^\]]+)\]$/);
    if (section) {
      currentFn = section[1].trim();
      continue;
    }
    if (line.startsWith("[")) {
      currentFn = ""; // left the functions section
      continue;
    }
    if (currentFn) {
      const m = line.match(/^verify_jwt\s*=\s*(true|false)\b/i);
      if (m && m[1].toLowerCase() === "false") safe.add(currentFn);
    }
  }
  return safe;
}

// Refuse to serve (and drop the captured handler for) any loaded function
// that does not explicitly opt out of JWT verification. Serving such a
// function unauthenticated here would hide an auth-bypass regression behind
// a green coverage run. ALLOW_JWT_FUNCTIONS=1 is an explicit local override.
async function assertNoJwtFunctions(): Promise<void> {
  const safe = await readVerifyJwtFalseSet();
  const requiresJwt = [...handlers.keys()].filter((name) => !safe.has(name)).sort();
  if (requiresJwt.length === 0) return;
  for (const name of requiresJwt) handlers.delete(name);
  console.error(
    `[coverage-bootstrap] REFUSING to serve ${requiresJwt.length} function(s) that require JWT ` +
      `(no \`verify_jwt = false\` in config.toml): ${requiresJwt.join(", ")}`
  );
  if (Deno.env.get("ALLOW_JWT_FUNCTIONS") !== "1") {
    console.error(
      "[coverage-bootstrap] aborting: this harness performs NO JWT verification, so serving " +
        "these would mask an auth bypass. Set verify_jwt = false in config.toml if intended, " +
        "or ALLOW_JWT_FUNCTIONS=1 to override for local debugging."
    );
    Deno.exit(1);
  }
}

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

// Deno's coverage dump (--coverage=DIR) runs on clean process exit.
// SIGINT/SIGTERM to a Deno process running an HTTP server does not by
// default trigger a clean exit (the runtime keeps the event loop
// alive). Register explicit signal handlers that call Deno.exit(0)
// so V8 flushes its coverage profile to disk before we tear down.
const shutdown = (sig: string) => {
  console.log(`[coverage-bootstrap] received ${sig}, exiting (coverage flush)`);
  Deno.exit(0);
};
Deno.addSignalListener("SIGINT", () => shutdown("SIGINT"));
Deno.addSignalListener("SIGTERM", () => shutdown("SIGTERM"));

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

// Gate before we bind the port: drop/abort on any function that expects JWT.
await assertNoJwtFunctions();

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
