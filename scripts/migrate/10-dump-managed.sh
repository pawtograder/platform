#!/usr/bin/env bash
# Step 1 — dump the managed project over the DIRECT Postgres connection.
#
# Produces, in .work/:
#   auth-public.dump   — custom-format, data-only, schemas auth + public
#   storage-objects.csv — (bucket_id,name) of every object to re-upload in step 3
#
# No read-only freeze needed: pg_dump takes one consistent snapshot and does not
# block writers. Any writes after the snapshot (i.e. the summer class you are NOT
# migrating) are simply not captured — which is exactly what you want.
source "$(dirname "$0")/config.sh"
require pg_dump; require psql

: "${MANAGED_DB_URL:?set MANAGED_DB_URL in scripts/migrate/managed.env (direct 5432 URL, not the pooler)}"

echo ">> Sanity: managed server version + migration head"
psql "$MANAGED_DB_URL" -tAc "select version();"
psql "$MANAGED_DB_URL" -tAc \
  "select max(version) from supabase_migrations.schema_migrations;" \
  | sed 's/^/   managed public migration head: /'

echo ">> Dumping auth + public (data-only, custom format)"
# --disable-triggers is applied at RESTORE time (step 2). Exclude GoTrue's own
# migration bookkeeping and the platform seed/bucket rows the chart already owns.
pg_dump "$MANAGED_DB_URL" \
  --format=custom \
  --data-only \
  --no-owner --no-privileges \
  --schema=auth --schema=public \
  --exclude-table-data='auth.schema_migrations' \
  --exclude-table-data='auth.audit_log_entries' \
  --exclude-table-data='auth.flow_state' \
  --exclude-table-data='auth.sessions' \
  --exclude-table-data='auth.refresh_tokens' \
  --exclude-table-data='public.audit*' \
  --exclude-table-data='storage.*' \
  --file="$WORK_DIR/auth-public.dump"
echo "   wrote $WORK_DIR/auth-public.dump ($(du -h "$WORK_DIR/auth-public.dump" | cut -f1))"

echo ">> Enumerating storage objects to re-upload"
# The bytes move via the Storage API in step 3; here we just capture the list.
buckets_sql=$(printf "'%s'," $BUCKETS); buckets_sql="${buckets_sql%,}"
psql "$MANAGED_DB_URL" -v ON_ERROR_STOP=1 -c \
  "\copy (select bucket_id, name from storage.objects where bucket_id in ($buckets_sql) order by bucket_id, name) to '$WORK_DIR/storage-objects.csv' with (format csv, header true)"
echo "   wrote $WORK_DIR/storage-objects.csv ($(($(wc -l < "$WORK_DIR/storage-objects.csv") - 1)) objects)"

echo ">> Done. Next: ./20-load-selfhosted.sh"
