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
# We prefer the Inspector path (coverage/server-cdp.json) because it
# captures Server Component bundles that Next 15 loads via the `vm`
# module — which `NODE_V8_COVERAGE` cannot see. The workflow's
# teardown step sends SIGUSR2 to Next, which makes
# instrumentation.ts call `Profiler.takePreciseCoverage` and write
# the dump.
#
# If the CDP dump isn't present (e.g., COVERAGE wasn't set during
# build, or instrumentation didn't run), fall back to the c8 +
# NODE_V8_COVERAGE path — it's much less complete but better than
# zero data.
if [[ -f coverage/server-cdp.json ]]; then
  echo "[collect] v8-server-to-lcov (Inspector CDP)"
  npx tsx scripts/coverage/v8-server-to-lcov.ts \
    || echo "[collect] WARN: server CDP conversion failed"
elif [[ -d coverage/server ]]; then
  echo "[collect] c8 report (NODE_V8_COVERAGE fallback)"
  # --exclude-after-remap so c8's include/exclude globs apply to the
  # *resolved* source paths (app/foo.tsx) instead of the *dist*
  # paths (.next/server/app/.../page.js).
  NODE_V8_COVERAGE="$ROOT/coverage/server" npx c8 report \
    --reporter=lcovonly \
    --report-dir=coverage \
    --src="$ROOT" \
    --exclude-after-remap \
    --include='app/**' --include='lib/**' --include='utils/**' --include='hooks/**' --include='components/**' \
    --exclude='**/*.d.ts' --exclude='**/node_modules/**' --exclude='.next/**' \
    || echo "[collect] WARN: c8 server report failed"
  if [[ -f coverage/lcov.info ]]; then
    mv coverage/lcov.info coverage/server.lcov
  fi
else
  echo "[collect] skip: no server coverage data (neither server-cdp.json nor coverage/server/)"
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
