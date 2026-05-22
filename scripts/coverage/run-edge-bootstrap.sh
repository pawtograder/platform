#!/usr/bin/env bash
# Launch the edge function coverage bootstrap under Deno with --coverage.
# Listens on $COVERAGE_FUNCTIONS_PORT (default 9998).
#
# IMPORTANT: do NOT run `supabase functions serve` concurrently with this —
# the bootstrap is the replacement for it during coverage runs.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

mkdir -p coverage/edge

PORT="${COVERAGE_FUNCTIONS_PORT:-9998}"
ENV_FILE="${COVERAGE_ENV_FILE:-.env.local}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[run-edge-bootstrap] env file $ENV_FILE not found; the edge bootstrap requires the same env as 'supabase functions serve'" >&2
  exit 1
fi

exec deno run \
  --allow-env --allow-net --allow-read --allow-write --allow-sys \
  --coverage=coverage/edge \
  --env-file="$ENV_FILE" \
  --import-map=supabase/functions/_coverage/deno.json \
  supabase/functions/_coverage/serve.ts
