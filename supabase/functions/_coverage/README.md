# Edge Function Coverage Bootstrap

`serve.ts` replaces `supabase functions serve` during coverage runs so that
all edge functions execute inside a single Deno process that we can launch
with `--coverage=DIR`.

## Why this exists

`supabase functions serve` runs `edge-runtime` (a Supabase fork of Deno)
which does not implement V8 coverage collection. The CLI also does not
forward arbitrary Deno flags. The only way to collect coverage today is to
bypass the CLI and run our functions under stock Deno.

## How it works

1. Before importing any function module, the bootstrap monkey-patches
   `Deno.serve` so each function's top-level `Deno.serve(handler)` call
   captures its handler into a registry instead of binding a port.
2. The bootstrap walks `supabase/functions/*/index.ts` and dynamically
   imports each one.
3. It then starts a single real `Deno.serve` on `COVERAGE_FUNCTIONS_PORT`
   (default `9998`) and dispatches incoming requests by URL path:
   - `POST /functions/v1/<name>` → `<name>` handler (Supabase SDK shape)
   - `POST /<name>` → `<name>` handler (direct shape)
   - `GET /__health__` → liveness check
   - `GET /__functions__` → list of registered handlers

## Run it (coverage mode)

```bash
mkdir -p coverage/edge
deno run \
  --allow-env --allow-net --allow-read --allow-write --allow-sys \
  --allow-import \
  --coverage=coverage/edge \
  --env-file=.env.local \
  --import-map=supabase/functions/_coverage/deno.json \
  supabase/functions/_coverage/serve.ts
```

After Playwright finishes:

```bash
deno coverage coverage/edge --lcov --output=coverage/edge.lcov
```

## What we lose vs. real edge-runtime

- Per-worker isolation, CPU/wallclock limits, `EdgeRuntime.waitUntil`.
- JWT verification. All 47 functions currently set `verify_jwt = false`
  in `supabase/config.toml`; if any flips to `true` later, add the check
  to `serve.ts` before dispatch.
- Coverage for functions invoked by `pg_net` from inside Postgres — those
  still go through Kong to the original edge-runtime container. Planned
  for v2 (Kong reroute).
