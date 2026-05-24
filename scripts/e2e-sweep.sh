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
if ! [[ "$n" =~ ^[1-9][0-9]*$ ]]; then
  echo "usage: $0 <iterations> (positive integer)" >&2
  exit 2
fi
mkdir -p logs
rm -f .e2e-sweep.done logs/sweep-summary.txt
rm -rf sweep-results-i*

failed_iters=0
start_all=$(date +%s)
for ((i=1; i<=n; i++)); do
  echo "[sweep] iter ${i}/${n} start=$(date -Is)" | tee -a logs/sweep-summary.txt

  # Clear GitHub circuit breaker. Trip is from create-submission tests'
  # cloneRepository hitting the dummy App; if previous iteration tripped it,
  # this iteration's downstream tests would fast-fail without retry. We
  # log (rather than silence) failures so environment drift is visible.
  if ! docker exec -i supabase_db_pawtograder-platform psql -U postgres -d postgres -c \
      "UPDATE public.github_circuit_breakers SET state='closed', open_until=now() WHERE state='open';" \
      >> "logs/sweep-i${i}.log" 2>&1; then
    echo "[sweep] iter ${i}/${n} warn=failed_to_clear_github_circuit_breaker" | tee -a logs/sweep-summary.txt
  fi

  rm -rf test-results playwright-report
  start=$(date +%s)
  BASE_URL=http://localhost:3001 \
    npx playwright test --project=chromium \
    >> "logs/sweep-i${i}.log" 2>&1
  pw_exit=$?
  end=$(date +%s)
  if [ "$pw_exit" -ne 0 ]; then
    failed_iters=$((failed_iters + 1))
  fi

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
echo "[sweep] DONE n=${n} total=$((end_all - start_all))s failed_iters=${failed_iters}" | tee -a logs/sweep-summary.txt

# Sentinel records the failed-iteration count, not a constant "0", so
# automation reading .e2e-sweep.done can branch on real outcomes.
echo "${failed_iters}" > .e2e-sweep.done
if [ "$failed_iters" -gt 0 ]; then
  exit 1
fi
