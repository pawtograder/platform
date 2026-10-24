#!/usr/bin/env bash
# Agent mutation gauntlet (a11y-judge v2, Wave 5).
#
# Runs the agentic SR-driving task suite under each seeded defect, one
# (mutation, affected-task) pair at a time, 3 samples each, into per-mutation
# trajectory run dirs. Resumable (the host spec skips cells whose verdict.json
# already exists). Then aggregates the scorecard with evalReport.
#
# Usage: BASE_URL=http://localhost:3001 bash tools/a11y-judge/agent/gauntlet.sh
set -uo pipefail
cd "$(dirname "$0")/../../.."

SAMPLES="${A11Y_AGENT_SAMPLES:-3}"
CLEAN="${CLEAN_RUN:-a11y-trajectories/eval-clean}"

# mutation:task pairs. Each mutation is exercised on the task where its defect
# most directly affects the screen-reader user's ability to finish.
PAIRS=(
  "412-strip-labels:survey-complete"          # unlabeled controls -> 4.1.2
  "246-headings-generic:grade-assignment-name" # heading text gone -> needle unreachable
  "132-survey-options-first:survey-complete"   # options read before question -> 1.3.2
  "247-outline-none:survey-complete"           # visual-only focus loss -> honest SR blind spot
  "413-silent-toast:survey-complete"           # no announced submit confirmation -> 4.1.3
  "111-alt-degrade:discussion-subject"         # degraded alt text -> 1.1.1
)

for pair in "${PAIRS[@]}"; do
  mut="${pair%%:*}"
  task="${pair##*:}"
  echo "=== gauntlet: ${mut} x ${task} (${SAMPLES} samples) ==="
  A11Y_MUTATION="${mut}" \
  A11Y_AGENT_TASKS="${task}" \
  A11Y_AGENT_SAMPLES="${SAMPLES}" \
  A11Y_RUN_ID="gauntlet-${mut}" \
    npm run a11y:agent 2>&1 | tail -3
done

echo "=== aggregating scorecard ==="
GAUNTLET_ARGS=()
for pair in "${PAIRS[@]}"; do
  GAUNTLET_ARGS+=(--gauntlet "a11y-trajectories/gauntlet-${pair%%:*}")
done
npx tsx tools/a11y-judge/agent/evalReport.ts --clean "${CLEAN}" "${GAUNTLET_ARGS[@]}" \
  --out "${CLEAN}/eval.md"
