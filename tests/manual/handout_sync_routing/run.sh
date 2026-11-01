#!/usr/bin/env bash
#
# Proof harness for supabase/migrations/20261101120000_handout_sync_queue_and_routing.sql.
#
#   tests/manual/handout_sync_routing/run.sh postgresql://postgres:postgres@127.0.0.1:<port>/postgres
#
# The database must be fully migrated up to, but not necessarily including, 20261101120000: the
# script loads the migration itself (after loading the revision of queue_repository_syncs it
# replaces, for the baseline), and the migration is idempotent, so a database that already has it
# works too. No seed is needed. Everything runs in one transaction that ends in ROLLBACK.
#
# The URL is required, and the shared local stack (port 54322) is refused: other worktrees and
# sessions use it, and this script redefines functions inside its transaction. Use an isolated
# scratch stack (see the platform-isolated-test-stack recipe: a copy of supabase/ with its own
# project_id and ports).
#
# Exit status is non-zero if any check failed.
set -euo pipefail

DB_URL="${1:?usage: run.sh <postgres url of an isolated, migrated database>}"
case "$DB_URL" in
  *:54322/*) echo "refusing to run against the shared local stack on 54322" >&2; exit 2 ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
cd "$REPO"   # the script \i's migrations by repo-relative path
psql -X -v ON_ERROR_STOP=1 "$DB_URL" -f "$HERE/10_routing.sql"
