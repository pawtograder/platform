# Code Coverage

End-to-end coverage tracking across the five layers we care about:

| Layer                   | Tool                                            | Output                    | Flag             |
| ----------------------- | ----------------------------------------------- | ------------------------- | ---------------- |
| Jest unit/integration   | Istanbul (built into Jest)                      | `coverage/jest/lcov.info` | `jest`           |
| Next.js server          | `NODE_V8_COVERAGE` + `c8 report`                | `coverage/server.lcov`    | `next-server`    |
| Next.js client          | Playwright `startJSCoverage` + `v8-to-istanbul` | `coverage/client.lcov`    | `next-client`    |
| Supabase Edge Functions | Deno `--coverage` via custom bootstrap          | `coverage/edge.lcov`      | `edge-functions` |
| Postgres (PL/pgSQL)     | `plpgsql_check` profiler + custom bridge        | `coverage/postgres.lcov`  | `postgres`       |

All five upload as separate flags to Codecov on every PR. v1 is **informational only** — the gates are configured but `informational: true` keeps them non-blocking until we've calibrated the thresholds against real PRs (see [Rollout](#rollout)).

## Running locally

Local coverage runs require a real local Supabase + the prod-mode Next build (port 3001). The shape mirrors the AGENTS.md "Prod E2E mode" path, with three extra steps: enable `plpgsql_check`, build with `NODE_V8_COVERAGE`, and replace `supabase functions serve` with the coverage bootstrap.

```bash
# 1. Local Supabase (per AGENTS.md — fresh start, no backup restore)
npx supabase stop --no-backup || true
docker volume ls --filter label=com.supabase.cli.project=pawtograder-platform -q | xargs -r docker volume rm
mv supabase/migrations/20260217000000_binary_submission_files.sql /tmp/
npx supabase start
docker exec -i supabase_db_pawtograder-platform psql -U postgres -d postgres < /tmp/20260217000000_binary_submission_files.sql
docker exec -i supabase_db_pawtograder-platform psql -U postgres -d postgres \
  -c "INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('20260217000000', 'binary_submission_files') ON CONFLICT DO NOTHING;"
mv /tmp/20260217000000_binary_submission_files.sql supabase/migrations/
docker exec -i supabase_db_pawtograder-platform psql -U postgres -d postgres \
  -c "SELECT public.audit_maintain_partitions();"

# 2. Add plpgsql_check to shared_preload_libraries (one-time per fresh DB)
npm run coverage:setup-pg

# 3. Build Next with coverage env baked in
export NEXT_PUBLIC_PAWTOGRADER_WEB_URL=http://localhost:3001
export NEXT_PUBLIC_COVERAGE_FUNCTIONS_URL=http://127.0.0.1:9998
export COVERAGE=1
rm -rf .next
npm run build

# 4. Start servers (three terminals)
#    Terminal A — Next.js with V8 coverage
PORT=3001 COVERAGE=1 NODE_V8_COVERAGE="$PWD/coverage/server" npm run start

#    Terminal B — Edge function bootstrap (NOT `supabase functions serve`)
npm run coverage:edge

#    Terminal C — Playwright
COVERAGE=1 BASE_URL=http://localhost:3001 npm run test:e2e

# 5. After Playwright finishes, stop A and B with Ctrl+C so V8 dumps flush,
#    then collect:
npm run coverage:collect

# Outputs land in coverage/*.lcov + coverage/jest/lcov.info.
```

## How the edge bootstrap works

`supabase functions serve` runs `edge-runtime` (a Supabase fork of Deno) which **does not** implement V8 coverage collection, and the CLI does not forward Deno flags. So we replace it during coverage runs with `supabase/functions/_coverage/serve.ts`, which:

1. Monkey-patches `Deno.serve` before importing any function module
2. Walks `supabase/functions/*/index.ts` and dynamically imports each one — each function's top-level `Deno.serve(handler)` call ends up registering the handler in a routing map instead of binding a port
3. Starts one real `Deno.serve` on `COVERAGE_FUNCTIONS_PORT` (default 9998) that dispatches by URL path

The Supabase JS clients (`utils/supabase/client.ts` and `utils/supabase/server.ts`) honor `NEXT_PUBLIC_COVERAGE_FUNCTIONS_URL` and patch the SDK's internal functions URL to point at this bootstrap.

See `supabase/functions/_coverage/README.md` for the full rationale.

## v1 limitations

Documented so we don't pretend coverage is complete.

1. **DB-trigger-driven function invocations don't get edge-function coverage.** When Postgres calls an edge function via `pg_net` (webhooks, async workers), the request goes through Kong → the original `edge-runtime` container, not our bootstrap. The bootstrap only catches functions invoked from the Next.js process. **v2 plan:** reroute Kong's `/functions/v1/*` upstream to point at the bootstrap. Requires touching the `supabase_kong_*` container's config and is best done as a Docker network/alias swap once we have the v1 numbers stable.
2. **Server-side V8 coverage attribution is per-process, not per-test.** Each test hits `/api/__coverage__` to flush, but V8 in Node merges flushes within a process. To get per-test attribution we'd need to restart `next start` between tests — not worth the time cost. Per-PR aggregate is fine.
3. ~~**Server Components are not in `server.lcov`.**~~ **Fixed (runtime +
   build capture).** Two problems, two captures, merged by
   `scripts/coverage/v8-server-to-lcov.ts`:
   - _vm-loaded bundles._ `NODE_V8_COVERAGE` does not instrument scripts
     loaded via the `vm` module — the path Next 15 uses for Server
     Component bundles. We instead use `node:inspector`'s
     `Profiler.startPreciseCoverage` from inside the Next process via
     `instrumentation.ts`; precise coverage sees vm-loaded scripts because
     it runs in the same V8 isolate. The workflow sends `SIGUSR2` at
     teardown, `instrumentation.ts` writes `coverage/server-cdp-<pid>.json`.
   - _prerendered server shells._ A Server Component on a route whose
     server output is static (e.g. a passthrough layout over a
     `"use client"` page) is **prerendered at `next build`** and served
     from the prerender cache at request time — so its render function
     never executes at runtime and the runtime dump shows it 0% covered.
     The coverage build runs with
     `NODE_OPTIONS=--require ./scripts/coverage/build-cdp-hook.cjs`, which
     attaches the same Profiler to the build process and its
     static-generation workers and writes `coverage/build-cdp-<pid>.json`.
     monocart sums counts across both dump families, so code that ran at
     build and/or at request time ends up covered.
4. **Client-side V8 coverage occasionally fails to source-map.** `v8-to-istanbul` (now `monocart-coverage-reports`) drops scripts whose source map can't be resolved (some RSC payloads, vendor chunks without maps). Expect ~5% of compiled chunks to silently disappear. Set `COVERAGE_DEBUG=1` to see them.
5. **`plpgsql_check` profiler must be in `shared_preload_libraries`.** Otherwise coverage is per-session and won't span Playwright's many connections. `npm run coverage:setup-pg` configures this and restarts the DB container; re-run after any `supabase stop --no-backup`.
6. **PL/pgSQL functions defined outside `supabase/migrations/*.sql` are skipped** by the coverage bridge — there's no source file to attribute to.
7. **No coverage for `webkit` Playwright project** — V8 coverage is Chromium-only. The webkit project still runs, just without coverage hooks.

## Rollout

- **Now (v1):** All flags upload on every PR. Codecov posts a comment with project + patch coverage. Status checks are `informational: true` so they do not block merges.
- **+2 weeks:** Review the actual patch-coverage distribution across PRs in this period. Adjust the 80% target if it produces too many false negatives.
- **+3 weeks:** Flip `informational: false` for `project.default` and `patch.default` in `codecov.yml`. Add the Codecov check to GitHub branch protection on `staging` as a required status.

## v2 / future

- **Reroute Kong to capture DB-trigger-driven edge invocations.** (Lifts limitation #1.)
- **pgTAP for explicit SQL tests.** When ready, add `supabase/tests/pgtap/*.sql`, run via `pg_prove` in the same coverage workflow, upload as an additional Codecov flag. pgTAP doesn't produce line coverage on its own — it complements `plpgsql_check` by exercising functions, RLS policies, and trigger semantics that Playwright can't easily reach. The plpgsql_check profiler observes which lines pgTAP runs, so we get more line coverage "for free" from adding pgTAP tests.
- **Per-test server-side attribution** by restarting Next between tests (only if a regression is hard to attribute and the team wants the breakdown).
- **Coverage diff in PR description**, mirrored to a Slack channel for visibility before flipping to required.

## CI

`.github/workflows/coverage.yml` runs two jobs in parallel on every PR:

- `jest` — fast (~5 min). Just unit/integration coverage.
- `e2e` — long (~60–90 min). Brings up local Supabase, builds Next with sourcemaps, starts everything with coverage flags, runs Playwright, collects per-layer lcov, uploads to Codecov.

The CODECOV_TOKEN secret is required (set at the repo level — public repos still use it for upload identity/rate limits).
