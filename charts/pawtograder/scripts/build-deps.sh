#!/usr/bin/env bash
# Helm 3 `dependency build` refuses https repos without a `helm repo add` entry.

set -euo pipefail

CHART="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

grep -q '^dependencies:' "$CHART/Chart.yaml" || exit 0

i=0
for url in $(awk '$1 == "repository:" && $2 ~ /^https?:/ { print $2 }' "$CHART/Chart.yaml" | sort -u); do
  i=$((i + 1))
  helm repo add "pawtograder-dep-$i" "$url" --force-update >/dev/null
done

helm dependency build "$CHART" --skip-refresh >/dev/null
