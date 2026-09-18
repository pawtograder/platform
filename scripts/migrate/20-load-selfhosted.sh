#!/usr/bin/env bash
# Step 2 — load auth + public into the self-hosted chart Postgres.
#
# Robust path for a large dump: COPY the archive onto the pod's data volume
# (verifiable + retryable), then run pg_restore LOCALLY inside the pod as the DB
# superuser (supabase_admin) over the unix socket. The DB-mutating step has no
# network in the loop, so an apiserver/exec blip can't leave a half-loaded DB.
#
#   --disable-triggers  => disables FK/trigger enforcement during the data load
#                          (superuser-only; supabase_admin qualifies). Table order
#                          and side-effect triggers therefore don't matter.
#   pg_dump's setval()  => restores every sequence/identity.
# UUIDs are preserved, so GitHub SSO on the new host reuses each identity.
#
# PRECONDITION: fresh instance whose auth.users is empty (run 15- first).
source "$(dirname "$0")/config.sh"
require kubectl

DUMP="$WORK_DIR/auth-public.dump"
[[ -f "$DUMP" ]] || { echo "run 10-dump-managed.sh first ($DUMP missing)" >&2; exit 1; }
POD="$(detect_db_pod)"; [[ -n "$POD" ]] || { echo "no primary Postgres pod in ns $NS" >&2; exit 1; }
REMOTE_DIR="/var/lib/postgresql/data/migrate"
REMOTE="$REMOTE_DIR/auth-public.dump"
JOBS="${PGRESTORE_JOBS:-4}"
echo ">> Target pod: $POD (ns $NS), as supabase_admin; restore jobs=$JOBS"

existing=$(admin_q -tAc 'select count(*) from auth.users' | tr -d '[:space:]')
echo ">> Target currently has $existing auth.users"
if [[ "${existing:-0}" -gt 1 && "${FORCE:-0}" != "1" ]]; then
  echo "   Refusing to load onto a non-empty instance — run 15-wipe-selfhosted.sh (or FORCE=1)." >&2
  exit 1
fi

echo ">> Copying dump into pod ($(du -h "$DUMP" | cut -f1)) — verifying size, retry on mismatch"
local_size=$(wc -c < "$DUMP")
kubectl -n "$NS" exec "$POD" -c postgres -- mkdir -p "$REMOTE_DIR"
for attempt in 1 2 3; do
  kubectl -n "$NS" cp "$DUMP" "$NS/$POD:$REMOTE" -c postgres
  remote_size=$(kubectl -n "$NS" exec "$POD" -c postgres -- sh -lc "wc -c < '$REMOTE'" | tr -d '[:space:]')
  echo "   attempt $attempt: local=$local_size remote=$remote_size"
  [[ "$local_size" == "$remote_size" ]] && { echo "   size OK"; break; }
  [[ "$attempt" == 3 ]] && { echo "   copy kept mismatching after 3 tries — aborting" >&2; exit 1; }
done

echo ">> Restoring in-pod (data-only, triggers disabled)"
# sh -lc so the nix profile PATH exposes pg_restore; libpq defaults to the local
# socket (same as the verified psql). Capture pg_restore's real exit via PIPESTATUS.
set +e
kubectl -n "$NS" exec "$POD" -c postgres -- sh -lc \
  "pg_restore --data-only --disable-triggers --no-owner --no-privileges \
     --jobs=$JOBS --verbose -U supabase_admin -d postgres '$REMOTE' 2>&1" \
  | tee "$WORK_DIR/restore.log" \
  | grep -Ei 'error|fatal|warning|processing data for|finished' | tail -40
rc=${PIPESTATUS[0]}
set -e
if [[ "$rc" -ne 0 ]]; then
  echo "!! pg_restore exited $rc — inspect $WORK_DIR/restore.log (grep -i error). Counts below may be partial." >&2
fi

if [[ "${KEEP_POD_DUMP:-0}" != "1" ]]; then
  echo ">> Removing dump from pod"
  kubectl -n "$NS" exec "$POD" -c postgres -- rm -f "$REMOTE"
fi

echo ">> Post-load sanity"
admin_q -tAc 'select count(*) from auth.users'        | sed 's/^/   auth.users:   /'
admin_q -tAc 'select count(*) from auth.identities'   | sed 's/^/   identities:   /'
admin_q -tAc 'select count(*) from public.classes'    | sed 's/^/   classes:      /'
admin_q -tAc 'select count(*) from public.user_roles' | sed 's/^/   enrollments:  /'
echo ">> Full log: $WORK_DIR/restore.log (grep -i error). Next: ./30-sync-storage.sh"
