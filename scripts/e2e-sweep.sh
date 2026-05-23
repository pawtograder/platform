#!/bin/bash
# Run the full Playwright suite N times sequentially. Between iterations:
#   - Clear the GitHub circuit breaker (otherwise the create-submission tests
#     trip it on their first run and downstream submission flows fail fast).
#   - Move that iteration's test-results aside so the next run starts clean
#     and we keep traces/db-state for failure diagnosis.
#   - Append a one-line summary to logs/sweep-summary.txt.
#
# Usage: ./scripts/e2e-sweep.sh <iterations>
# Outputs:
#   logs/sweep-iN.log         per-run Playwright output
#   sweep-results-iN/         per-run test-results dir
#   logs/sweep-summary.txt    one line per run with pass/fail counts
#   .e2e-sweep.done           sentinel after all runs complete

set -uo pipefail

n="${1:?usage: $0 <iterations>}"
mkdir -p logs
rm -f .e2e-sweep.done logs/sweep-summary.txt
rm -rf sweep-results-i*

start_all=$(date +%s)
for i in $(seq 1 "$n"); do
  echo "[sweep] iter ${i}/${n} start=$(date -Is)" | tee -a logs/sweep-summary.txt

  # Clear GitHub circuit breaker. Trip is from create-submission tests'
  # cloneRepository hitting the dummy App; if previous iteration tripped it,
  # this iteration's downstream tests would fast-fail without retry.
  docker exec -i supabase_db_pawtograder-platform psql -U postgres -d postgres -c \
    "UPDATE public.github_circuit_breakers SET state='closed', open_until=now() WHERE state='open';" \
    > /dev/null 2>&1 || true

  rm -rf test-results playwright-report
  start=$(date +%s)
  BASE_URL=http://localhost:3001 \
    npx playwright test --project=chromium \
    > "logs/sweep-i${i}.log" 2>&1
  pw_exit=$?
  end=$(date +%s)

  # Move per-run test-results aside so they don't get clobbered by the next run.
  if [ -d test-results ]; then
    mv test-results "sweep-results-i${i}"
  fi

  # Summary: tally passed/failed/skipped/did-not-run. Pull them from the
  # tail of the log where Playwright prints the totals block.
  summary=$(tail -40 "logs/sweep-i${i}.log" | grep -E "^\s*[0-9]+\s+(passed|failed|skipped|did not run)" | tr -d ' ' | tr '\n' ' ' || true)
  echo "[sweep] iter ${i}/${n} exit=${pw_exit} elapsed=$((end - start))s ${summary}" | tee -a logs/sweep-summary.txt
done

end_all=$(date +%s)
echo "[sweep] DONE n=${n} total=$((end_all - start_all))s" | tee -a logs/sweep-summary.txt

echo "0" > .e2e-sweep.done
