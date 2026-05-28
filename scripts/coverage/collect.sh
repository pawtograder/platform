#!/usr/bin/env bash
# Per-layer coverage collection orchestrator. Run AFTER Playwright finishes.
# Produces (under coverage/):
#   - jest/lcov.info          (already written by `jest --coverage`)
#   - edge.lcov               (from deno coverage)
#   - server.lcov             (from c8 over NODE_V8_COVERAGE dir)
#   - client.lcov             (from v8-client-to-lcov.ts)
#   - postgres.lcov           (from dump-pg.ts)
#
# Each output is per-flag for Codecov; we do NOT merge them. Codecov merges
# server-side using flag-to-path mappings in codecov.yml.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

mkdir -p coverage

# --- Edge functions (Deno) -------------------------------------------------
if [[ -d coverage/edge ]]; then
  echo "[collect] deno coverage --lcov"
  deno coverage coverage/edge --lcov --output=coverage/edge.lcov \
    --include="supabase/functions/" \
    --exclude="supabase/functions/_coverage/" \
    --exclude="supabase/functions/_shared/.*\\.d\\.ts" \
    || echo "[collect] WARN: deno coverage failed"
else
  echo "[collect] skip: no coverage/edge dir (was the bootstrap run with --coverage?)"
fi

# --- Next.js server (Node Inspector via instrumentation.ts) --------------
# Coverage comes from coverage/server-cdp.json — written by
# instrumentation.ts on SIGUSR2 (see the workflow teardown step).
# Unlike the older NODE_V8_COVERAGE approach this captures vm-loaded
# Server Component bundles.
if compgen -G "coverage/server-cdp*.json" >/dev/null; then
  echo "[collect] v8-server-to-lcov (Inspector CDP)"
  npx tsx scripts/coverage/v8-server-to-lcov.ts \
    || echo "[collect] WARN: server CDP conversion failed"
else
  echo "[collect] skip: no coverage/server-cdp*.json (was instrumentation.ts active? did SIGUSR2 fire?)"
fi

# --- Next.js client (Chromium V8) -----------------------------------------
if [[ -d coverage/client ]]; then
  echo "[collect] v8-client-to-lcov"
  npx tsx scripts/coverage/v8-client-to-lcov.ts \
    --input coverage/client \
    --output coverage/client.lcov \
    --base-url "${BASE_URL:-http://localhost:3001}" \
    || echo "[collect] WARN: client conversion failed"
else
  echo "[collect] skip: no coverage/client dir (no per-test client dumps written)"
fi

# --- Postgres (plpgsql_check) ---------------------------------------------
# Gated on the sentinel written by setup-pg.sh. If you ran the E2E
# without enabling the Postgres profiler, this would just produce an
# empty lcov; skip cleanly.
if [[ -f coverage/.pg-ready ]]; then
  echo "[collect] dump-pg"
  npx tsx scripts/coverage/dump-pg.ts > coverage/postgres.lcov 2> coverage/postgres.log \
    || { echo "[collect] WARN: postgres dump failed — see coverage/postgres.log"; cat coverage/postgres.log; }
else
  echo "[collect] skip: coverage/.pg-ready missing (run \`npm run coverage:setup-pg\` first)"
fi

echo "[collect] done"
ls -la coverage/*.lcov coverage/jest/lcov.info 2>/dev/null || true
