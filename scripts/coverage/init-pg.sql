-- Postgres coverage initialization. Idempotent; safe to run before every
-- coverage-mode E2E. Not added as a regular migration because the
-- plpgsql_check extension carries ~5-20% runtime overhead and is only
-- needed during coverage runs.
--
-- Invoke from the host with:
--   PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres \
--     -f scripts/coverage/init-pg.sql

CREATE EXTENSION IF NOT EXISTS plpgsql_check;

-- plpgsql_check installs into the `public` schema in current Supabase
-- images. `public` is on the default search_path so we call the
-- function unqualified.
SELECT plpgsql_profiler_reset_all();

-- This file only resets the shared profiler state. Global profiler
-- enablement (`plpgsql_check.profiler = on`) is handled by setup-pg.sh,
-- which writes it to postgresql.auto.conf and restarts the container so
-- every subsequent session inherits the setting.
