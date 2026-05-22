-- Postgres coverage initialization. Idempotent; safe to run before every
-- coverage-mode E2E. Not added as a regular migration because the
-- plpgsql_check extension carries ~5-20% runtime overhead and is only
-- needed during coverage runs.
--
-- Invoke from the host with:
--   PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres \
--     -f scripts/coverage/init-pg.sql

CREATE EXTENSION IF NOT EXISTS plpgsql_check;

-- Profiler must be enabled per-session by callers. We just reset the
-- shared state here so each E2E run starts from zero.
SELECT plpgsql_check.plpgsql_profiler_reset_all();

-- A coverage run is opt-in: this GUC tells callers (the dump script) that
-- profiling was active for the most recent run, and any client driving
-- the DB during the E2E should set `plpgsql_check.profiler = on` in its
-- session. We do that in init-pg-session.sql below; init-pg.sql only
-- handles the shared/global reset.
