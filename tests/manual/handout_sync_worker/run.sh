#!/usr/bin/env bash
#
# WP5 acceptance tests for the handout-sync worker (docs/handout-sync-git-build-plan.md, WP5).
#
#   tests/manual/handout_sync_worker/run.sh <isolated supabase dir> [deno test args...]
#
# The argument is the directory holding the scratch stack's supabase/config.toml (see the
# platform-isolated-test-stack recipe: a copy of supabase/ with its own project_id and ports, all
# migrations applied). The script reads the stack's URLs and service-role key from
# `supabase status` there and refuses the shared stacks: pawtograder-platform (5432x) and
# hw1-harness (5832x) are used by other worktrees, and these tests purge pgmq queues.
#
# Needs a non-snap Deno on PATH (the snap one cannot spawn the host's git), psql, openssl and
# git >= 2.43. Fixtures go under .test-tmp/ at the repo root. The kill -9 case waits out a real
# 120 s visibility timeout, so a full run takes about four minutes.
set -euo pipefail

SCRATCH="${1:?usage: run.sh <isolated supabase dir> [deno test args...]}"
shift

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
SUPABASE="${SUPABASE_CLI:-$REPO/node_modules/.bin/supabase}"

STATUS="$(cd "$SCRATCH" && "$SUPABASE" status -o env 2>/dev/null)"
value() { printf '%s\n' "$STATUS" | sed -n "s/^$1=\"\(.*\)\"$/\1/p"; }
DB_URL="$(value DB_URL)"
API_URL="$(value API_URL)"
KEY="$(value SERVICE_ROLE_KEY)"
if [ -z "$DB_URL" ] || [ -z "$API_URL" ] || [ -z "$KEY" ]; then
  echo "no running stack in $SCRATCH (supabase status gave no DB_URL/API_URL/SERVICE_ROLE_KEY)" >&2
  exit 2
fi

FORBIDDEN_PORT_RANGES=("54320 54329" "58320 58329")
CLIENT_PORT="$(psql -XAt -v ON_ERROR_STOP=1 "$DB_URL" -c '\echo :PORT')"
API_PORT="$(printf '%s' "$API_URL" | sed -E 's#.*:([0-9]+)/?$#\1#')"
for range in "${FORBIDDEN_PORT_RANGES[@]}"; do
  read -r lo hi <<<"$range"
  for p in "$CLIENT_PORT" "$API_PORT"; do
    if [ "$p" -ge "$lo" ] && [ "$p" -le "$hi" ]; then
      echo "refusing to run: port $p is inside the shared range $lo-$hi" >&2
      exit 2
    fi
  done
done

export WP5_DB_URL="$DB_URL" WP5_API_URL="$API_URL" WP5_SERVICE_ROLE_KEY="$KEY"
export GITSYNC_TEST_TMPDIR="$REPO/.test-tmp/gitsync-wp5"
cd "$REPO"
# The worker cases seed the class the backstop case reuses, so they run first.
deno test --no-check -A --config supabase/functions/deno.json "$@" \
  "$HERE/worker.scratch.test.ts" "$HERE/backstop.scratch.test.ts"
