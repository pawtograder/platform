-- Enable pg_buffercache so public.database_ram_metrics() (added in
-- 20260325000000_autovacuum_tuning.sql) can report buffer-cache metrics instead
-- of RAISEing a WARNING on every call. The metrics edge function
-- (supabase/functions/metrics/index.ts) invokes database_ram_metrics() on every
-- Prometheus scrape, so a missing extension spams the postgres log with
-- "pg_buffercache extension not installed" once per scrape.
--
-- MUST be created in `public`: database_ram_metrics() runs with
-- `SET search_path = pg_catalog, public` and references `pg_buffercache`
-- unqualified. If the extension were installed elsewhere (e.g. the supabase
-- `extensions` schema), the pg_extension existence check would pass but the
-- `FROM pg_buffercache` query would then ERROR — worse than the warning.
--
-- pg_buffercache is a lightweight, read-only contrib extension (a view over
-- shared_buffers); it needs no shared_preload_libraries.
--
-- Idempotent across every prior state: `CREATE EXTENSION IF NOT EXISTS ... WITH
-- SCHEMA public` alone is a no-op that does NOT relocate when the extension
-- already exists in another schema — so on an install where a base image /
-- Supabase tooling pre-created pg_buffercache in e.g. `extensions`, it would
-- stay there and break the unqualified reference. Handle all cases: relocate to
-- public if it exists elsewhere, create in public if absent, no-op if already
-- there.
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
