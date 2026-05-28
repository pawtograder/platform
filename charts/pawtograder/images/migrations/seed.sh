#!/usr/bin/env bash
# Apply supabase/seed.sql once: creates the Demo Class with id=1, plus
# canned auth.users / assignments / rubrics / submissions for previews
# and end-to-end tests.
#
# Idempotent: skips if the demo class already exists. Run as a Helm
# post-install,post-upgrade hook AFTER migrations completes — callers
# of `helm install/upgrade` must pass --wait-for-jobs, otherwise this
# hook fires while migrations is still running and the schema is empty.
# We hard-fail below if public.classes doesn't exist, to surface that
# case loudly instead of silently re-trying against a half-built DB.

set -euo pipefail

SEED_FILE="${SEED_FILE:-/seed.sql}"

if [ ! -f "$SEED_FILE" ]; then
  echo "[seed] no seed file at $SEED_FILE" >&2
  exit 1
fi

# Wait for postgres to accept connections (helm hook ordering should
# already cover this, but be defensive on cold installs).
for i in $(seq 1 60); do
  if pg_isready -q; then break; fi
  echo "[seed] waiting for postgres ($i/60)"
  sleep 2
done

# Skip if a demo class with id=1 is already present. seed.sql is not
# idempotent on its own — the INSERT INTO public.classes(id=1, ...) at
# the top would conflict on every re-run.
#
# Fail loudly if `public.classes` doesn't exist: that means migrations
# haven't completed (we run as a post-install hook and depend on
# --wait-for-jobs upstream). Swallowing the error would lead seed.sql
# to run against an empty schema and fail mid-transaction.
if ! psql -tAc "SELECT to_regclass('public.classes') IS NOT NULL" | grep -q '^t$'; then
  echo "[seed] public.classes does not exist — migrations have not completed yet" >&2
  exit 1
fi
exists="$(psql -tAc "SELECT 1 FROM public.classes WHERE id = 1 AND is_demo = true LIMIT 1")"
if [ "$exists" = "1" ]; then
  echo "[seed] demo class (id=1) already present — skipping"
  exit 0
fi

echo "[seed] applying $SEED_FILE"
psql -v ON_ERROR_STOP=1 --single-transaction -f "$SEED_FILE"
echo "[seed] done"
