#!/usr/bin/env bash
# Helm 3 `dependency build` refuses https repos without a `helm repo add` entry.

set -euo pipefail

IF_MISSING=0
[ "${1:-}" = --if-missing ] && { IF_MISSING=1; shift; }
CHART="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

grep -q '^dependencies:' "$CHART/Chart.yaml" || exit 0
if [ "$IF_MISSING" = 1 ] && deps=$(helm dependency list "$CHART" 2>/dev/null) \
  && ! awk 'NR > 1 && NF && $NF != "ok" { m = 1 } END { exit !m }' <<<"$deps"; then
  exit 0
fi

i=0
for url in $(awk '$1 == "repository:" && $2 ~ /^https?:/ { print $2 }' "$CHART/Chart.yaml" | sort -u); do
  i=$((i + 1))
  helm repo add "pawtograder-dep-$i" "$url" --force-update >/dev/null
done

helm dependency build "$CHART" --skip-refresh >/dev/null
