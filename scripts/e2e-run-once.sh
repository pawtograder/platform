#!/bin/bash
# Run the full Playwright E2E suite once and label its results.
#
# Usage: ./scripts/e2e-run-once.sh <run-label>
# After completion:
#   - logs/e2e-<label>.log holds the full Playwright output
#   - screenshots-<label>/ holds copies of all Argos PNGs from this run
#   - .e2e-<label>.done is touched (atomic completion signal)

set -uo pipefail

label="${1:?usage: $0 <run-label>}"
mkdir -p logs
rm -rf "test-results" "playwright-report" "screenshots-${label}"
rm -f ".e2e-${label}.done"

start=$(date +%s)
echo "[e2e-run-once] label=${label} start=$(date -Is)" > "logs/e2e-${label}.log"

BASE_URL=http://localhost:3001 \
  npx playwright test --project=chromium \
  >> "logs/e2e-${label}.log" 2>&1
pw_exit=$?

end=$(date +%s)
echo "[e2e-run-once] exit=${pw_exit} elapsed=$((end - start))s" >> "logs/e2e-${label}.log"

./scripts/e2e-collect-screenshots.sh "${label}" >> "logs/e2e-${label}.log" 2>&1 || true

echo "${pw_exit}" > ".e2e-${label}.done"
