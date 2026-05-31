#!/usr/bin/env bash
# Apply supabase/seed.sql once: creates the Demo Class with id=1, plus
# canned auth.users / assignments / rubrics / submissions for previews
# and end-to-end tests.
#
# seed.sql itself is NOT idempotent (it INSERTs into public.classes
# with id=1, which conflicts on re-run), so we gate it behind a
# "demo class exists?" check. The post-seed steps below ARE idempotent
# and run on every seed-job invocation — that's how password rotation
# propagates to existing preview namespaces without needing a reset.
#
# Run as a Helm post-install,post-upgrade hook AFTER migrations
# completes — callers of `helm install/upgrade` must pass
# --wait-for-jobs, otherwise this hook fires while migrations is still
# running and the schema is empty. We hard-fail below if public.classes
# doesn't exist, to surface that case loudly instead of silently
# re-trying against a half-built DB.

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

# Fail loudly if `public.classes` doesn't exist: that means migrations
# haven't completed (we run as a post-install hook and depend on
# --wait-for-jobs upstream). Swallowing the error would lead seed.sql
# to run against an empty schema and fail mid-transaction.
if ! psql -tAc "SELECT to_regclass('public.classes') IS NOT NULL" | grep -q '^t$'; then
  echo "[seed] public.classes does not exist — migrations have not completed yet" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Phase 1: seed.sql (gated on demo class absence)
# ---------------------------------------------------------------------------
demo_exists="$(psql -tAc "SELECT 1 FROM public.classes WHERE id = 1 AND is_demo = true LIMIT 1")"
if [ "$demo_exists" = "1" ]; then
  echo "[seed] demo class (id=1) already present — skipping seed.sql"
else
  echo "[seed] applying $SEED_FILE"
  psql -v ON_ERROR_STOP=1 --single-transaction -f "$SEED_FILE"
fi

# ---------------------------------------------------------------------------
# Phase 2: rewrite demo user passwords (idempotent — runs every seed)
# ---------------------------------------------------------------------------
# seed.sql hardcodes encrypted_password='dummyhash' on every auth.users
# row, which breaks password auth for demo accounts. Rewrite using
# pgcrypto's bcrypt so reviewers can log in with the documented
# sample emails + the shared password.
#
# Runs on EVERY seed-job invocation (not just first install) so that
# rotating the shared password via setup-openbao-preview-shared.sh
# --rotate propagates to existing preview namespaces on next helm
# upgrade — no namespace reset required.
#
# If SEED_USER_PASSWORD is unset (the chart didn't enable
# seed.externalSecret), leave the existing hash alone. Magic-link auth
# still works in that mode.

if [ -n "${SEED_USER_PASSWORD:-}" ]; then
  echo "[seed] rewriting auth.users encrypted_password for demo users (@pawtograder.net)"
  psql -v ON_ERROR_STOP=1 -v pw="$SEED_USER_PASSWORD" <<'SQL'
UPDATE auth.users
   SET encrypted_password = crypt(:'pw', gen_salt('bf'))
 WHERE email LIKE '%@pawtograder.net';
SQL
else
  echo "[seed] SEED_USER_PASSWORD unset — leaving auth.users.encrypted_password as dummyhash"
  echo "       (magic-link auth still works; password auth will fail)"
fi

# ---------------------------------------------------------------------------
# Phase 3: ensure one grader exists (idempotent — runs every seed)
# ---------------------------------------------------------------------------
# seed.sql promotes test1@ to instructor but leaves every other demo
# user as student. The PR comment surfaces one of each role, so tag
# foobar@ as grader. Only promotes if the row is currently 'student',
# so manual role tweaks aren't clobbered.

echo "[seed] ensuring a grader exists in the demo class (foobar@pawtograder.net)"
psql -v ON_ERROR_STOP=1 <<'SQL'
UPDATE public.user_roles ur
   SET role = 'grader'
  FROM auth.users u
 WHERE ur.user_id = u.id
   AND u.email = 'foobar@pawtograder.net'
   AND ur.role = 'student';
SQL

echo "[seed] done"
