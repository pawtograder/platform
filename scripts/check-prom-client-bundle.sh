#!/usr/bin/env bash
# Fail if prom-client reached the CLIENT bundle.
#
# lib/metrics.ts does `await import("prom-client")` behind an isNode() guard.
# The guard is a RUNTIME check; whether the module ends up in a browser chunk is
# a BUILD-TIME decision webpack makes purely from the import graph. So the
# moment any "use client" module imports lib/metrics.ts (or anything that
# re-exports it, e.g. lib/routeMetrics.ts), Next splits prom-client into a
# client chunk and every visitor downloads a Node process-metrics library. The
# guard makes the failure silent rather than preventing it.
#
# That is not hypothetical: instrumenting lib/edgeFunctions.ts invokeEdgeFunction
# would have done exactly this — 32 of its 37 importers are "use client". See
# docs/operations/metrics-gap-remediation.md §4.
#
# Run AFTER `npm run build`. A missing .next/static/chunks is a hard failure, not
# a pass: a guard that silently succeeds when it has nothing to inspect is worse
# than no guard.
set -euo pipefail

CHUNKS="${1:-.next/static/chunks}"

if [ ! -d "$CHUNKS" ]; then
  echo "check-prom-client-bundle: $CHUNKS does not exist." >&2
  echo "Run 'npm run build' first — this check is meaningless without a production build." >&2
  exit 1
fi

hits="$(grep -rl "prom-client" "$CHUNKS" || true)"

if [ -n "$hits" ]; then
  echo "check-prom-client-bundle: FAIL — prom-client is in the client bundle." >&2
  echo "$hits" >&2
  echo >&2
  echo "Something under a \"use client\" boundary now imports @/lib/metrics or" >&2
  echo "@/lib/routeMetrics (directly or transitively). Metrics helpers are" >&2
  echo "server-only; move the call site to a route handler or an SSR loader." >&2
  exit 1
fi

echo "check-prom-client-bundle: OK — no prom-client in $CHUNKS ($(find "$CHUNKS" -type f | wc -l) files scanned)."
