#!/bin/bash
# Detachable production build wrapper for the Pawtograder Next.js app.
# Required so the build survives the Claude harness's per-call Bash timeout
# while still leaving a clean completion signal (.build.done) we can poll.

set -uo pipefail

rm -rf .next
rm -f .build.done

export NEXT_PUBLIC_PAWTOGRADER_WEB_URL=http://localhost:3001
NODE_OPTIONS=--max-old-space-size=8000 npm run build > logs/build.log 2>&1
exit_code=$?

echo "${exit_code}" > .build.done
