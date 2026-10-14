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
#   HARNESS_KEEP=1    leave the container running for inspection  (default: always removed)
#   HARNESS_MIGRATION_<n>  apply a scratch copy in place of the nth migration of the chain below.
#                     HARNESS_MIGRATION is an alias for n=1 and HARNESS_PIN_MIGRATION for n=2.
#                     Used to prove a scenario is not vacuous; see the chain comment below, and note
#                     that a run with any override in effect refuses to start unless the override
#                     actually changed the schema the scenarios will exercise.
#
# interrupt_check.sh in this directory verifies the interrupted-run path: non-zero exit AND no
# container left behind.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
# The migrations under test, applied in order. Two of them now: the allocator, and the pin_org
# argument that continuous refill needs. A future migration that touches
# pgmq_public.claim_org_slot_and_read belongs on the END of this list.
DEFAULT_MIGRATIONS=(
  "$REPO/supabase/migrations/20260912120000_per_org_async_leases.sql"
  "$REPO/supabase/migrations/20260914120000_async_lease_pin_org.sql"
)

# An override points this at a MODIFIED copy of one of those migrations, so a reviewer can revert a
# fix in a scratch copy and watch a scenario go red. That experiment is the only thing standing
# behind any claim that a concurrency scenario is not vacuous.
#
# THE TRAP IT USED TO SET, WHICH IS WHY THERE IS A GATE BELOW. The chain is applied in order and the
# pin_org migration drops and recreates claim_org_slot_and_read in full. So mutating a copy of the
# FIRST migration changed nothing the scenarios could observe: the committed allocator was restored
# a second later, the suite stayed at 198/198, and the non-vacuity experiment proved nothing while
# looking exactly like proof. Every "this scenario would catch the regression" claim resting on an
# override of the first migration was unproven for that reason.
#
# Two things now stop that recurring. Overrides are addressed by POSITION in the chain, so a third
# allocator migration needs no new variable and the last entry is always reachable. And a run with
# any override in effect proves, before it runs a single scenario, that the override actually
# changed the schema the scenarios will exercise.
MIGRATIONS=()
OVERRIDDEN_INDEXES=()
for ((mi = 0; mi < ${#DEFAULT_MIGRATIONS[@]}; mi++)); do
  mn=$((mi + 1))
  mvar="HARNESS_MIGRATION_$mn"
  movr="${!mvar:-}"
  # Back-compatible aliases for the first two positions.
  if [ -z "$movr" ] && [ "$mn" = "1" ]; then movr="${HARNESS_MIGRATION:-}"; fi
  if [ -z "$movr" ] && [ "$mn" = "2" ]; then movr="${HARNESS_PIN_MIGRATION:-}"; fi
  if [ -n "$movr" ] && [ "$movr" != "${DEFAULT_MIGRATIONS[$mi]}" ]; then
    MIGRATIONS+=("$movr")
    OVERRIDDEN_INDEXES+=("$mn")
  else
    MIGRATIONS+=("${DEFAULT_MIGRATIONS[$mi]}")
  fi
done

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

# EXIT does the cleanup; the signals only choose an exit status and let EXIT run.
#
# Trapping cleanup on INT and TERM as well looked equivalent and was not. `$?` inside the handler is
# the status of whatever finished last, so a signal arriving just after a successful command made
# cleanup exit 0: an interrupted run reported success, and CI would have accepted a validation run
# that never reached the assertions. Here the signal handlers exit with the conventional
# 128 + signal status, that status becomes `$?` in cleanup, and the container is still removed
# because EXIT still fires. tests/manual/per_org_async_leases/interrupt_check.sh asserts both halves.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

export PGPASSWORD=postgres
psql_args=(-X -q -h 127.0.0.1 -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1)
run_sql() { psql "${psql_args[@]}" "$@"; }
scalar()  { psql "${psql_args[@]}" -At -c "$1"; }

for m in "${MIGRATIONS[@]}"; do
  [ -f "$m" ] || { echo "!! migration not found: $m" >&2; exit 2; }
done

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
# filtered read is either unnecessary or subtly wrong, and that has to be reported rather than
# hidden.
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

for m in "${MIGRATIONS[@]}"; do
  echo ">> applying $(basename "$m") verbatim"
  run_sql -f "$m" >/dev/null
done

# ------------------------------------------------------------------------------------------------
# OVERRIDE FINGERPRINT. Only runs when an override is in effect, and costs nothing otherwise.
#
# The question it answers is the one the harness could not previously answer about itself: did the
# reviewer's mutation actually reach the code the scenarios are about to call? A later migration
# recreating the same function silently undoes an earlier one, and the only visible symptom was a
# green table -- which is precisely what the experiment was trying to distinguish from.
#
# So: build the DEFAULT chain in a second database in the same container, fingerprint both schemas,
# and refuse to run the scenarios unless they differ. That test knows nothing about which function
# was mutated or how many migrations there are, so it does not rot when the next one lands.
#
# Its reach is function bodies and index definitions in public and pgmq_public. A mutation confined
# to something outside that -- a comment, a grant -- is reported as neutralised even though it is
# not. That direction is the safe one: it stops a run rather than blessing one.
# ------------------------------------------------------------------------------------------------
FINGERPRINT_SQL="
  select string_agg(line, chr(10) order by line) from (
    select n.nspname || '.' || p.proname || '(' ||
           pg_get_function_identity_arguments(p.oid) || ')' || chr(9) ||
           md5(coalesce(p.prosrc, '')) as line
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'pgmq_public')
    union all
    select 'index ' || schemaname || '.' || indexname || chr(9) || md5(indexdef)
      from pg_indexes
     where schemaname in ('public', 'pgmq_public')
  ) f"

if [ "${#OVERRIDDEN_INDEXES[@]}" -gt 0 ]; then
  echo ">> override in effect at chain position(s): ${OVERRIDDEN_INDEXES[*]}"
  for i in "${OVERRIDDEN_INDEXES[@]}"; do
    d="${DEFAULT_MIGRATIONS[$((i - 1))]}"
    o="${MIGRATIONS[$((i - 1))]}"
    echo "     $i: $o"
    echo "        (in place of $(basename "$d"))"
    if cmp -s "$o" "$d"; then
      echo
      echo "################################################################################"
      echo "## OVERRIDE IS NOT A MUTATION"
      echo "##   $o"
      echo "##   is byte-identical to $(basename "$d"). Nothing was changed, so nothing can"
      echo "##   go red. Edit the scratch copy before re-running."
      echo "################################################################################"
      exit 2
    fi
  done

  echo ">> building the default chain in a reference database to prove the override reached the schema"
  run_sql -c "drop database if exists harness_ref" >/dev/null
  run_sql -c "create database harness_ref" >/dev/null
  ref_args=(-X -q -h 127.0.0.1 -p "$PORT" -U postgres -d harness_ref -v ON_ERROR_STOP=1)
  psql "${ref_args[@]}" -f "$HERE/00_prereqs.sql" >/dev/null
  refn=0
  for d in "${DEFAULT_MIGRATIONS[@]}"; do
    refn=$((refn + 1))
    [ -f "$d" ] || { echo "!! default migration not found: $d" >&2; exit 2; }
    psql "${ref_args[@]}" -f "$d" >/dev/null
    # Fingerprint after EACH step, so a failure can name the migration that overwrote the mutation
    # rather than leaving the reviewer to work it out.
    psql "${ref_args[@]}" -At -c "$FINGERPRINT_SQL" | LC_ALL=C sort > "$WORK/ref_fp.$refn"
  done

  psql "${psql_args[@]}" -At -c "$FINGERPRINT_SQL" | LC_ALL=C sort > "$WORK/mut_fp"
  # The SYMMETRIC difference, not one side of it: a mutation that deletes an object is as real as
  # one that rewrites it, and comm -13 alone would call the deletion "no change".
  # comm -3 prefixes file-2-only lines with a tab; strip that, then keep the identity column and
  # drop the md5.
  DIFFERING="$(LC_ALL=C comm -3 "$WORK/ref_fp.$refn" "$WORK/mut_fp" \
                 | sed 's/^\t//' | cut -f1 | LC_ALL=C sort -u)"

  if [ -z "$DIFFERING" ]; then
    echo
    echo "################################################################################"
    echo "## OVERRIDE WAS NEUTRALISED -- REFUSING TO RUN THE SCENARIOS"
    echo "##"
    echo "##   The schema built from the overridden chain is identical to the schema built"
    echo "##   from the committed one. A later migration recreated whatever you changed, so"
    echo "##   the scenarios would exercise the UNMODIFIED code and pass. A green table here"
    echo "##   would have meant nothing."
    echo "##"
    echo "##   Which migration last defines each allocator function:"
    grep '^pgmq_public\.' "$WORK/ref_fp.$refn" | cut -f1 | while read -r fn; do
      last=1
      for ((k = 1; k <= refn; k++)); do
        cur="$(grep -F "$fn"$'\t' "$WORK/ref_fp.$k" || true)"
        prev=""
        [ "$k" -gt 1 ] && prev="$(grep -F "$fn"$'\t' "$WORK/ref_fp.$((k - 1))" || true)"
        [ "$cur" != "$prev" ] && last=$k
      done
      echo "##     $fn"
      echo "##       last defined by chain position $last: $(basename "${DEFAULT_MIGRATIONS[$((last - 1))]}")"
    done
    echo "##"
    echo "##   Move the mutation to that position (HARNESS_MIGRATION_<n>), or mutate every"
    echo "##   position from yours onward."
    echo "################################################################################"
    exit 2
  fi

  echo ">> override reached the schema; objects that differ from the committed chain:"
  echo "$DIFFERING" | sed 's/^/     /'
fi

echo ">> harness plumbing"
run_sql -f "$HERE/05_harness.sql" >/dev/null
run_sql -c "select harness.expect('0 environment', 'pgmq version in $IMAGE', '$EXPECTED_PGMQ', '${PGMQ_VER:-<none>}')" >/dev/null

# The results table has to say which schema produced it. A mutated run and a clean run printed the
# same header, so a pasted table could not be told apart from the one it was supposed to contradict.
if [ "${#OVERRIDDEN_INDEXES[@]}" -gt 0 ]; then
  run_sql -c "select harness.note('0 environment', 'migration chain',
                   'OVERRIDDEN at position(s) ${OVERRIDDEN_INDEXES[*]} -- NOT the committed schema'),
                   harness.note('0 environment', 'schema objects changed by the override',
                   '$(echo "$DIFFERING" | tr '\n' ' ' | cut -c1-200)')" >/dev/null
else
  run_sql -c "select harness.note('0 environment', 'migration chain', 'committed, unmodified')" >/dev/null
fi

echo ">> scenarios 1,2,3,4,6,7,8,9 + cost"
run_sql -f "$HERE/10_scenarios.sql"

echo ">> scenario 19: a class whose github_org is the empty string"
run_sql -f "$HERE/50_blank_org_scenarios.sql"

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
# Scenario 18: a renewal's row lock interleaved with a claim by the same holder.
#
# This one cannot be staged from a single session. The bug needs one transaction holding the row
# lock on a holder's slot while ANOTHER transaction runs that holder's next claim, and calling the
# two in sequence passes against the broken allocator. So: two psql sessions, started together.
#
# TO CHECK THIS IS NOT VACUOUS, mutate the LAST migration in the chain -- the one that actually
# defines the allocator the scenarios call -- not the first:
#
#   HARNESS_MIGRATION_2=/tmp/old_allocator.sql tests/manual/per_org_async_leases/run.sh
#
# where the scratch copy restores the pre-fix pick: drop the FOR UPDATE from the `mine` CTE and let
# free_slot choose `(s.expires_at <= clock_timestamp() or s.holder = $1) order by (s.holder = $1)
# desc` under SKIP LOCKED. Ten checks go red, five of them in this scenario, including "rows in the
# pool bearing this holder" and both halves of the randomized race. Mutating position 1 instead
# proves nothing and the run now refuses to start; see the OVERRIDE FINGERPRINT block above.
# ------------------------------------------------------------------------------------------------
echo ">> scenario 18: renewal/claim race setup"
run_sql -f "$HERE/40_race_setup.sql"

echo ">> scenario 18: deterministic race (renewal holds the row lock across the claim)"
run_sql -f "$HERE/41_race_renew.sql" >/dev/null &
RENEW_PID=$!
run_sql -f "$HERE/42_race_claim.sql" >/dev/null &
CLAIM_PID=$!
wait "$RENEW_PID"
wait "$CLAIM_PID"
run_sql -f "$HERE/43_race_assert.sql"

# And the same overlap generated at random by many sessions, so a fix that merely narrows the
# window rather than closing it still fails here.
#
# Each holder is driven by a PAIR of sessions: one claiming, one renewing, both under the same
# holder string. That pairing is what makes this test non-vacuous. A single session doing claim then
# renew cannot reproduce the bug, because its own two statements are sequential.
RACE_WORKERS=$(( WORKERS / 2 ))
[ "$RACE_WORKERS" -ge 8 ] || RACE_WORKERS=8
RACE_ITERS=20

: > "$WORK/race_claim_body.sql"
for ((k = 1; k <= RACE_ITERS; k++)); do cat "$HERE/44_race_worker.sql" >> "$WORK/race_claim_body.sql"; done

# The renew half loops harder than the claim half, so a claim is likely to land inside a renewal's
# row lock rather than between two of them.
: > "$WORK/race_renew_body.sql"
for ((k = 1; k <= RACE_ITERS * 8; k++)); do cat "$HERE/46_race_renew_worker.sql" >> "$WORK/race_renew_body.sql"; done

cat > "$WORK/race_worker.sh" <<RACEWORKER
#!/usr/bin/env bash
set -euo pipefail
export PGPASSWORD=postgres
# \$1 is "claim" or "renew"; \$2 is the holder id.
exec psql -X -q -h 127.0.0.1 -p $PORT -U postgres -d postgres -v ON_ERROR_STOP=1 \\
  -v h="race-\$2" -f "$WORK/race_\$1_body.sql" -o /dev/null
RACEWORKER
chmod +x "$WORK/race_worker.sh"

echo ">> scenario 18: $RACE_WORKERS holders, each driven by a claim session and a renew session"
run_sql -c "select harness.reset('async_calls')" >/dev/null
run_sql -c "select harness.seed(101, 600), harness.seed(102, 600), harness.seed(103, 600)" >/dev/null
# Both halves of every pair start together, so the two statement streams interleave for real.
{
  seq 1 "$RACE_WORKERS" | sed 's/^/renew /'
  seq 1 "$RACE_WORKERS" | sed 's/^/claim /'
} | xargs -P "$(( RACE_WORKERS * 2 ))" -n 2 "$WORK/race_worker.sh"
run_sql -f "$HERE/45_race_storm_assert.sql"

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
