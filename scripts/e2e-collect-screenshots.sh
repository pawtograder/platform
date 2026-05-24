#!/bin/bash
# Collect all Argos screenshots from test-results into a labeled directory so
# two consecutive E2E runs can be diffed for visual flakes.
#
# Usage: ./scripts/e2e-collect-screenshots.sh <run-label>
# Reads from ./test-results/**/argos/**/*.png
# Writes to  ./screenshots-<run-label>/<flattened-test-path>/<screenshot>.png

set -euo pipefail

label="${1:?usage: $0 <run-label>}"
src="test-results"
dst="screenshots-${label}"

rm -rf "$dst"
mkdir -p "$dst"

if [ ! -d "$src" ]; then
  echo "No test-results directory found." >&2
  exit 1
fi

count=0
while IFS= read -r png; do
  rel="${png#$src/}"
  # rel like "discussion-threads-..-test-name-chromium/argos/Some Screenshot.png"
  dir="$(dirname "$rel")"
  # Strip the trailing /argos so each test gets a single folder
  flat="${dir%/argos}"
  flat="${flat%/argos/*}"
  mkdir -p "$dst/$flat"
  cp "$png" "$dst/$flat/"
  count=$((count + 1))
done < <(find "$src" -path "*/argos/*.png" -type f)

echo "Collected $count screenshots into $dst/"
