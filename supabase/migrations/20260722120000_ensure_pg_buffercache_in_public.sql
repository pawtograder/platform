-- Guarantee pg_buffercache lives in `public`, regardless of prior state.
--
-- 20260722000000_enable_pg_buffercache used `CREATE EXTENSION IF NOT EXISTS
-- pg_buffercache WITH SCHEMA public`. That is correct only when the extension
-- is ABSENT: IF NOT EXISTS makes the statement a no-op when pg_buffercache
-- already exists, and the WITH SCHEMA clause is then ignored — so on an install
-- where a base image / Supabase tooling pre-created pg_buffercache in another
-- schema (e.g. `extensions`), it would stay there. public.database_ram_metrics()
-- runs `SET search_path = pg_catalog, public` and references `pg_buffercache`
-- unqualified; if the view is outside public its pg_extension existence check
-- passes but the query then ERRORs — worse than the original warning.
--
-- This migration closes every path: relocate to public if it exists elsewhere,
-- create in public if absent, no-op if already in public. (This is a no-op on
-- deployments that applied the previous migration cleanly, e.g. prod.)
DO $$
DECLARE cur_schema text;
BEGIN
  SELECT n.nspname INTO cur_schema
  FROM pg_extension e
  JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'pg_buffercache';

  IF cur_schema IS NULL THEN
    EXECUTE 'CREATE EXTENSION pg_buffercache WITH SCHEMA public';
  ELSIF cur_schema <> 'public' THEN
    -- pg_buffercache is relocatable; move it so the unqualified reference resolves.
    EXECUTE 'ALTER EXTENSION pg_buffercache SET SCHEMA public';
  END IF;
END $$;
