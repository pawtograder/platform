#!/usr/bin/env bash
#
# Proof harness for supabase/migrations/20261109120000_handout_sync_queue_and_routing.sql.
#
#   tests/manual/handout_sync_routing/run.sh postgresql://postgres:postgres@127.0.0.1:<port>/postgres
#
# The database must be fully migrated up to, but not necessarily including, 20261109120000: the
# script loads the migration itself (after loading the revision of queue_repository_syncs it
# replaces, for the baseline), and the migration is idempotent, so a database that already has it
# works too. No seed is needed. Everything runs in one transaction that ends in ROLLBACK.
#
# The URL is required, and the shared local stacks are refused: pawtograder-platform (5432x) and
# hw1-harness (5832x) are used by other worktrees and sessions, and this script redefines functions
# inside its transaction. Use an isolated scratch stack (see the platform-isolated-test-stack
# recipe: a copy of supabase/ with its own project_id and ports).
#
# The guard connects and asks which port is in use rather than parsing the URL. A URL can name the
# port in a query string (?port=54322), leave it out and inherit PGPORT, or omit the path, and a
# pattern match on the string misses each of those.
#
# Exit status is non-zero if any check failed.
set -euo pipefail

DB_URL="${1:?usage: run.sh <postgres url of an isolated, migrated database>}"

# The URL with any password removed, for messages. A refusal is printed to the terminal and
# often to a log, and the URL it names may carry a real password.
SHOWN_URL="$(printf '%s' "$DB_URL" | sed -E 's#(://[^:/@?]*):[^@/?]*@#\1:***@#; s#([?&]password=)[^&]*#\1***#')"

# Inclusive port ranges of shared stacks this script must never touch.
FORBIDDEN_PORT_RANGES=("54320 54329" "58320 58329")

SERVER_PORT="$(psql -XAt -v ON_ERROR_STOP=1 "$DB_URL" -c 'show port')" || {
  echo "could not ask $SHOWN_URL for its port; refusing to run" >&2
  exit 2
}
# A docker-mapped Supabase stack's server reports the port inside its container (5432), never the
# host port 54322, so the server's answer alone would let the shared stack through. psql's :PORT
# is the host port it actually connected to, whatever mix of URL, query string and PGPORT supplied
# it, so both are checked.
CLIENT_PORT="$(psql -XAt -v ON_ERROR_STOP=1 "$DB_URL" -c '\echo :PORT')"
for range in "${FORBIDDEN_PORT_RANGES[@]}"; do
  read -r lo hi <<<"$range"
  for p in "$SERVER_PORT" "$CLIENT_PORT"; do
    if [ "$p" -ge "$lo" ] && [ "$p" -le "$hi" ]; then
      echo "refusing to run: $SHOWN_URL is port $p, inside the shared range $lo-$hi" >&2
      exit 2
    fi
  done
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
cd "$REPO"   # the script \i's migrations by repo-relative path
psql -X -v ON_ERROR_STOP=1 "$DB_URL" -f "$HERE/10_routing.sql"
