#!/usr/bin/env bash
#
# Proof harness for supabase/migrations/20260912120000_per_org_async_leases.sql.
#
#   tests/manual/per_org_async_leases/run.sh
#
# That is the whole invocation. It needs docker and a psql client on PATH and nothing else.
#
# WHAT IT DOES. Starts a THROWAWAY supabase/postgres:17.4.1.075 container -- the exact prod image --
# on 127.0.0.1:55439, under a container name derived from this shell's PID, and removes it on the way
# out whether the run passed, failed or was interrupted. It never connects to anything else: the port
# is deliberately not 54322 (local Supabase) and not 5432, and the container is removed by name, so
# there is no path by which this touches a database you care about.
#
# Then: create the minimum prerequisites (00_prereqs.sql), apply the migration file VERBATIM, install
# the assertion plumbing (05_harness.sql), run the nine scenarios, and print a pass/fail table. Exit
# status is non-zero if any check failed.
#
# WHAT THE STUB DOES AND DOES NOT PROVE. public.classes here is `(id bigint primary key, github_org
# text)` and nothing else -- the two columns the allocator reads. That is enough to prove the
# allocator's LOGIC: the class_id -> github_org join, the sentinel bucket for messages that do not
# resolve, the ordering, the caps, the locking. It does NOT prove anything about the real table's RLS
# (the RPCs are SECURITY INVOKER and service_role has BYPASSRLS in Supabase, which is untestable
# here because this container has no PostgREST), about planner behaviour at production table
# statistics, or about how the join performs when classes has thousands of rows instead of seven.
# The demand-aggregate timing below is measured against a real 2500-message queue but a seven-row
# classes, so read it as a floor.
#
# Environment knobs (all optional):
#   HARNESS_PORT      host port for the throwaway container      (default 55439)
#   HARNESS_WORKERS   parallel psql sessions in the storm        (default 48, clamped to the
#                                                                 server's max_connections)
#   HARNESS_ITERS     claims per storm session                   (default 40)
#   HARNESS_KEEP=1    leave the container running for poking at  (default: always removed)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIGRATION="$REPO/supabase/migrations/20260912120000_per_org_async_leases.sql"

IMAGE="supabase/postgres:17.4.1.075"
EXPECTED_PGMQ="1.4.4"
PORT="${HARNESS_PORT:-55439}"
WORKERS="${HARNESS_WORKERS:-48}"
ITERS="${HARNESS_ITERS:-40}"
CONTAINER="pawtograder-orglease-harness-$$"
WORK="$(mktemp -d -t orglease-harness-XXXXXX)"

cleanup() {
  local rc=$?
  if [ "${HARNESS_KEEP:-0}" = "1" ]; then
    echo ">> HARNESS_KEEP=1: leaving container $CONTAINER on port $PORT"
  else
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
  exit "$rc"
}
trap cleanup EXIT INT TERM

export PGPASSWORD=postgres
psql_args=(-X -q -h 127.0.0.1 -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1)
run_sql() { psql "${psql_args[@]}" "$@"; }
scalar()  { psql "${psql_args[@]}" -At -c "$1"; }

[ -f "$MIGRATION" ] || { echo "!! migration not found: $MIGRATION" >&2; exit 2; }

echo ">> starting throwaway $IMAGE as $CONTAINER on 127.0.0.1:$PORT"
docker run -d --rm \
  --name "$CONTAINER" \
  -e POSTGRES_PASSWORD=postgres \
  -p "127.0.0.1:$PORT:5432" \
  "$IMAGE" >/dev/null

printf '>> waiting for postgres'
for _ in $(seq 1 120); do
  if psql "${psql_args[@]}" -At -c 'select 1' >/dev/null 2>&1; then ready=1; break; fi
  printf '.'; sleep 1
done
echo
[ "${ready:-0}" = "1" ] || { echo "!! postgres never came up" >&2; docker logs "$CONTAINER" | tail -40; exit 2; }

# ------------------------------------------------------------------------------------------------
# The version this whole migration is written against. pgmq gained pgmq.read's `conditional`
# argument in 1.5.0; on 1.4.4 there is no such thing, which is exactly why the migration reimplements
# pgmq.read's CTE rather than passing a filter to it. If this image ever ships something else, the
# filtered read is either unnecessary or subtly wrong, and that has to be shouted about, not papered
# over.
# ------------------------------------------------------------------------------------------------
PGMQ_VER="$(scalar "select default_version from pg_available_extensions where name = 'pgmq'")"
if [ "$PGMQ_VER" != "$EXPECTED_PGMQ" ]; then
  echo
  echo "################################################################################"
  echo "## PGMQ VERSION MISMATCH"
  echo "##   expected: $EXPECTED_PGMQ   found: ${PGMQ_VER:-<none>}   in image $IMAGE"
  echo "##   The migration mirrors the body of pgmq.read as it exists in $EXPECTED_PGMQ."
  echo "##   Re-read pgmq.read in this version before trusting any result below."
  echo "################################################################################"
  echo
  VERSION_OK=false
else
  echo ">> pgmq $PGMQ_VER confirmed in $IMAGE"
  VERSION_OK=true
fi

echo ">> prerequisites"
run_sql -f "$HERE/00_prereqs.sql" >/dev/null

echo ">> applying $(basename "$MIGRATION") verbatim"
run_sql -f "$MIGRATION" >/dev/null

echo ">> harness plumbing"
run_sql -f "$HERE/05_harness.sql" >/dev/null
run_sql -c "select harness.expect('0 environment', 'pgmq version in $IMAGE', '$EXPECTED_PGMQ', '${PGMQ_VER:-<none>}')" >/dev/null

echo ">> scenarios 1,2,3,4,6,7,8,9 + cost"
run_sql -f "$HERE/10_scenarios.sql"

# ------------------------------------------------------------------------------------------------
# Scenario 5: genuinely parallel sessions.
# ------------------------------------------------------------------------------------------------
MAXCONN="$(scalar 'show max_connections')"
LIMIT=$(( MAXCONN - 20 ))
[ "$WORKERS" -le "$LIMIT" ] || { echo ">> clamping workers $WORKERS -> $LIMIT (max_connections=$MAXCONN)"; WORKERS=$LIMIT; }

echo ">> scenario 5: storm setup"
run_sql -f "$HERE/20_storm_setup.sql"

# Each claim has to be its own transaction, so the body is the claim statement repeated rather than
# a loop inside one. A release every fourth claim keeps the slots churning between holders.
: > "$WORK/storm_body.sql"
for ((k = 1; k <= ITERS; k++)); do
  cat "$HERE/21_storm_claim.sql" >> "$WORK/storm_body.sql"
  if (( k % 4 == 0 )); then cat "$HERE/22_storm_release.sql" >> "$WORK/storm_body.sql"; fi
done
cat "$HERE/22_storm_release.sql" >> "$WORK/storm_body.sql"

cat > "$WORK/worker.sh" <<WORKER
#!/usr/bin/env bash
set -euo pipefail
export PGPASSWORD=postgres
exec psql -X -q -h 127.0.0.1 -p $PORT -U postgres -d postgres -v ON_ERROR_STOP=1 \\
  -v h="storm-\$1" -f "$WORK/storm_body.sql" -o /dev/null
WORKER
chmod +x "$WORK/worker.sh"

echo ">> scenario 5: $WORKERS parallel sessions x $ITERS claims = $((WORKERS * ITERS)) concurrent claim calls"
STORM_START=$(date +%s.%N)
seq 1 "$WORKERS" | xargs -P "$WORKERS" -n 1 "$WORK/worker.sh"
STORM_END=$(date +%s.%N)
STORM_SECS=$(awk -v a="$STORM_START" -v b="$STORM_END" 'BEGIN{printf "%.2f", b-a}')
RATE=$(awk -v n="$((WORKERS * ITERS))" -v s="$STORM_SECS" 'BEGIN{printf "%.0f", n/s}')
echo ">> storm finished in ${STORM_SECS}s (${RATE} claim calls/sec through the allocator)"
run_sql -c "select harness.note('5 concurrency', 'parallel sessions', '$WORKERS'),
                   harness.note('5 concurrency', 'claim calls issued', '$((WORKERS * ITERS))'),
                   harness.note('5 concurrency', 'wall clock (s)', '$STORM_SECS'),
                   harness.note('5 concurrency', 'claim calls/sec', '$RATE')" >/dev/null

echo ">> scenario 5: assertions"
run_sql -f "$HERE/30_storm_assert.sql"

# ------------------------------------------------------------------------------------------------
echo
echo "================================ RESULTS ================================"
psql "${psql_args[@]}" -c "
  select case when ok then 'PASS' else 'FAIL' end as status,
         scenario, check_name, expected, actual
    from harness.results
   order by seq"

FAILED="$(scalar 'select count(*) from harness.results where not ok')"
if [ "$FAILED" != "0" ] || [ "$VERSION_OK" != "true" ]; then
  echo "!! $FAILED check(s) failed"
  exit 1
fi
echo ">> all checks passed"
