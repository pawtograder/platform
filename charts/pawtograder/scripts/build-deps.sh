#!/usr/bin/env bash
#
# build-deps.sh — fetch the chart's subcharts (Chart.yaml `dependencies`) into
# charts/ at the versions pinned in Chart.lock. charts/*.tgz is gitignored, so
# run this before any `helm lint|template|package|upgrade` against a checkout.
#
#   build-deps.sh [chart-dir]    # default: the chart this script lives in
#
# Helm 3 `dependency build` refuses https repositories it has no `helm repo add`
# entry for (OCI ones need none), so each is added first. A chart without
# dependencies (e.g. an older base ref in the render gates) is a no-op.
#
# Requires: helm 3.x, awk.

set -euo pipefail

CHART="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

grep -q '^dependencies:' "$CHART/Chart.yaml" || exit 0

i=0
for url in $(awk '$1 == "repository:" && $2 ~ /^https?:/ { print $2 }' "$CHART/Chart.yaml" | sort -u); do
  i=$((i + 1))
  helm repo add "pawtograder-dep-$i" "$url" --force-update >/dev/null
done

helm dependency build "$CHART" --skip-refresh >/dev/null
