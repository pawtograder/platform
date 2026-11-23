/// <reference lib="deno.ns" />
/* eslint-disable no-console -- the container log is this file's only output */
/**
 * The lane's stand-in for the edge runtime, which it doesn't start (run-e2e.sh passes `-x edge-runtime`).
 * Runs each function the cloud workspaces journey reaches, unmodified: its own index.ts and deno.json under
 * Deno, on a port of its own (DENO_SERVE_ADDRESS), and routes `/functions/v1/<name>` to it.
 *
 * It runs in the `functions` container, in the loopback container's network namespace, so the functions
 * reach Supabase, Forgejo and Coder at the same 127.0.0.1 URLs the browser uses, and Forgejo's push hooks
 * reach it at 127.0.0.1:FUNCTIONS_PORT. The browser's calls come through the spec, which routes
 * `<SUPABASE_URL>/functions/v1/**` to the published port.
 *
 * GET /health answers 200 once every function is listening.
 */
const FUNCTIONS = [
  "workspace-open",
  "workspace-status",
  "forgejo-repo-webhook",
  "autograder-create-submission",
  "autograder-submit-feedback"
];

const root = Deno.env.get("FUNCTIONS_DIR") ?? "/supabase/functions";
const port = Number(Deno.env.get("FUNCTIONS_PORT") ?? "3150");
const ports = new Map<string, number>();

FUNCTIONS.forEach((name, i) => {
  const fnPort = port + 1 + i;
  ports.set(name, fnPort);
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--no-lock", "--config", "deno.json", "index.ts"],
    cwd: `${root}/${name}`,
    env: { DENO_SERVE_ADDRESS: `tcp:127.0.0.1:${fnPort}` },
    stdout: "inherit",
    stderr: "inherit"
  }).spawn();
  child.status.then((s) => console.error(`[functions-router] ${name} exited with ${s.code}`));
});

async function listening(fnPort: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${fnPort}/`, { signal: AbortSignal.timeout(2000) });
    await res.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

Deno.serve({ hostname: "0.0.0.0", port }, async (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/health") {
    const down = [];
    for (const [name, fnPort] of ports) if (!(await listening(fnPort))) down.push(name);
    return Response.json({ down }, { status: down.length ? 503 : 200 });
  }
  const m = url.pathname.match(/^\/functions\/v1\/([^/]+)(\/.*)?$/);
  const fnPort = m ? ports.get(m[1]) : undefined;
  if (!m || fnPort === undefined) {
    return Response.json({ error: `The lane doesn't serve ${url.pathname}` }, { status: 404 });
  }
  const started = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${fnPort}/${m[1]}${m[2] ?? ""}${url.search}`, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: "manual"
    });
    console.log(`[functions-router] ${req.method} ${m[1]} ${res.status} ${Date.now() - started}ms`);
    return res;
  } catch (e) {
    console.error(`[functions-router] ${req.method} ${m[1]} failed`, e);
    return Response.json({ error: `${m[1]} is unreachable: ${e}` }, { status: 502 });
  }
});
