#!/usr/bin/env bash
# Runs one bug reporter test group for the nightly and release workflows
# (.github/workflows/_bug-reporter-e2e.yml) and keeps its output apart from the other groups.
#
#   scripts/bugReport/ci-playwright.sh <group> [playwright test args...]
#
# Writes to $BUG_REPORT_RESULTS/<group>/ (default bug-report-results/<group>/):
#   html/           the Playwright HTML report
#   test-results/   attachments, traces, and screenshots
#   results.json    the JSON report
#   output.log      the console output
#   measurements.log  the `[bug-report ...]` lines the specs print (K1-K3, F7 evidence, sizes)
#
# The reporters are set here rather than taken from playwright.config.ts, which leaves Argos out:
# these runs are not visual baselines and have no Argos token.
#
# Fails when every selected test was skipped. Most of these specs skip themselves when an env var
# or a secret is missing, and a group that ran nothing must not pass.
set -uo pipefail

group="$1"
shift
dir="${BUG_REPORT_RESULTS:-bug-report-results}/${group}"
mkdir -p "$dir"

PLAYWRIGHT_HTML_OUTPUT_DIR="$dir/html" \
  PLAYWRIGHT_HTML_REPORT="$dir/html" \
  PLAYWRIGHT_HTML_OPEN=never \
  PLAYWRIGHT_JSON_OUTPUT_NAME="$dir/results.json" \
  npx playwright test --reporter=line,html,json --output="$dir/test-results" "$@" 2>&1 | tee "$dir/output.log"
rc=${PIPESTATUS[0]}

grep -E '^\[bug-report' "$dir/output.log" > "$dir/measurements.log" || true

ran=$(node -e '
  try {
    const s = require(require("node:path").resolve(process.argv[1])).stats ?? {};
    console.log((s.expected ?? 0) + (s.unexpected ?? 0) + (s.flaky ?? 0));
  } catch {
    console.log(0);
  }
' "$dir/results.json")
if [ "$rc" -eq 0 ] && [ "$ran" -eq 0 ]; then
  echo "::error title=Bug reporter ${group}: nothing ran::Every selected test was skipped. Check the skip reasons in ${dir}/output.log (a missing env var or secret, usually)."
  exit 1
fi
exit "$rc"
