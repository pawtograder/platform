#!/usr/bin/env bash
# Step 1.5 (optional) — wipe TEST DATA from the self-hosted DB before loading.
#
# Truncates every base table in `public` and `auth` (partitioned parents cascade
# to their partitions) so the UUID-preserving load can't collide with rows left
# over from testing. KEEPS the schema, sequences' definitions, GoTrue's
# auth.schema_migrations, and the storage schema (buckets + any objects) intact.
#
# Runs as the DB superuser (supabase_admin) inside the pod — `postgres` is NOT a
# superuser here and does not own the auth.* tables, so it cannot truncate them.
#
# DESTRUCTIVE. Guarded: you must pass CONFIRM=1.
source "$(dirname "$0")/config.sh"
require kubectl

if [[ "${CONFIRM:-0}" != "1" ]]; then
  echo "Refusing to wipe without CONFIRM=1." >&2
  echo "This TRUNCATEs all public + auth tables in ns=$NS. Re-run: CONFIRM=1 $0" >&2
  exit 1
fi

echo ">> Target pod: $(detect_db_pod) (ns $NS), as supabase_admin"

echo ">> Before:"
admin_q -tAc 'select count(*) from auth.users'     | sed 's/^/   auth.users: /'
admin_q -tAc 'select count(*) from public.classes' | sed 's/^/   classes:    /'

echo ">> Truncating public + auth (excluding auth.schema_migrations)"
admin_psql -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE stmt text;
BEGIN
  SELECT 'TRUNCATE ' || string_agg(format('%I.%I', n.nspname, c.relname), ', ')
         || ' RESTART IDENTITY CASCADE'
    INTO stmt
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'auth')
    AND c.relkind IN ('r', 'p')          -- ordinary + partitioned parents
    AND c.relispartition = false         -- parent TRUNCATE cascades to partitions
    AND NOT (n.nspname = 'auth' AND c.relname = 'schema_migrations');
  IF stmt IS NOT NULL THEN
    EXECUTE stmt;
  END IF;
END $$;
SQL

echo ">> After:"
admin_q -tAc 'select count(*) from auth.users'     | sed 's/^/   auth.users: /'
admin_q -tAc 'select count(*) from public.classes' | sed 's/^/   classes:    /'
echo ">> Clean. Next: ./20-load-selfhosted.sh"
