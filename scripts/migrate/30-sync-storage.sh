#!/usr/bin/env bash
# Step 3 — copy storage bytes managed -> self-hosted via the Storage API.
#
# Layout-agnostic: downloads each object from the managed project and re-uploads
# it to the self-hosted instance at the SAME bucket/path, so the string paths in
# public data (avatar_url, submission files, ...) resolve, and the self-hosted
# storage-api builds its own storage.objects/prefixes rows correctly.
source "$(dirname "$0")/config.sh"
require node

[[ -f "$WORK_DIR/storage-objects.csv" ]] || { echo "run 10-dump-managed.sh first" >&2; exit 1; }
: "${MANAGED_API_URL:?could not derive managed API URL — set MANAGED_API_URL (or MANAGED_DB_URL) in managed.env}"
: "${MANAGED_SERVICE_ROLE_KEY:?set MANAGED_SERVICE_ROLE_KEY (managed project service_role key) in managed.env}"

# Safety: the two ends MUST differ. A self->self copy fails 100% (objects aren't
# on the target). This is the trap when .env.local points at the self-hosted box.
_mhost="${MANAGED_API_URL#*://}"; _mhost="${_mhost%%/*}"
_shost="${SELF_API_URL#*://}";   _shost="${_shost%%/*}"
if [[ "$_mhost" == "$_shost" ]]; then
  echo "ABORT: MANAGED and SELF API hosts are identical ($_mhost)." >&2
  echo "  Set MANAGED_SERVICE_ROLE_KEY (and MANAGED_API_URL if needed) in scripts/migrate/managed.env" >&2
  echo "  so the source is the supabase.com project, not the self-hosted instance." >&2
  exit 1
fi
echo ">> Source (managed): $_mhost   Target (self): $_shost"

echo ">> Copying $(($(wc -l < "$WORK_DIR/storage-objects.csv") - 1)) objects: managed -> self-hosted"
MANAGED_API_URL="$MANAGED_API_URL" \
MANAGED_SERVICE_ROLE_KEY="$MANAGED_SERVICE_ROLE_KEY" \
SELF_API_URL="$SELF_API_URL" \
SELF_SERVICE_ROLE_KEY="$(self_service_role)" \
CSV="$WORK_DIR/storage-objects.csv" \
CONCURRENCY="${CONCURRENCY:-8}" \
  node "$(dirname "$0")/copy-storage.mjs"
