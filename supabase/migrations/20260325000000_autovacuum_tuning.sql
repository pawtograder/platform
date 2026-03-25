-- Autovacuum tuning to prevent worker starvation and stop-the-world vacuums.
--
-- Root cause (2026-03-25 incident): the default 3 autovacuum workers got
-- monopolised by multi-GB append-only tables, starving smaller hot tables.
-- A queued anti-wraparound vacuum could not acquire a worker in time and was
-- canceled, eventually forcing a stop-the-world vacuum with a RAM spike.
--
-- Strategy:
--   1. Fast-track hot, frequently-updated tables (low cost_delay, high cost_limit)
--   2. Throttle cold, giant, append-only tables (high cost_delay, low cost_limit)
--      so workers cycle through them slowly and yield to higher-priority work.

-- =============================================================================
-- HOT TABLES — aggressive vacuum so dead tuples are cleaned up quickly
-- =============================================================================

-- gradebook_column_students: heaviest write amplification (trigger cascade),
-- 36% HOT update ratio due to default fillfactor. Never vacuumed before incident.
ALTER TABLE public.gradebook_column_students SET (
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_vacuum_threshold = 50,
  autovacuum_analyze_scale_factor = 0.005,
  autovacuum_analyze_threshold = 50,
  autovacuum_vacuum_cost_delay = 2,
  autovacuum_vacuum_cost_limit = 1000,
  fillfactor = 70
);

-- gradebook_row_recalc_state: constant upserts from recalc queue
ALTER TABLE public.gradebook_row_recalc_state SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 50,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_vacuum_cost_delay = 2,
  autovacuum_vacuum_cost_limit = 1000
);

-- submission_reviews: 1-4 rows created per submission insert via trigger cascade
ALTER TABLE public.submission_reviews SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 50,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_vacuum_cost_delay = 2,
  autovacuum_vacuum_cost_limit = 1000
);

-- realtime_channel_subscriptions: high churn, 0% HOT updates, severe index bloat
ALTER TABLE public.realtime_channel_subscriptions SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 50,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_vacuum_cost_delay = 2,
  autovacuum_vacuum_cost_limit = 1000
);

-- grader_results: one per submission, no prior tuning
ALTER TABLE public.grader_results SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 50,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_vacuum_cost_delay = 2,
  autovacuum_vacuum_cost_limit = 1000
);

-- =============================================================================
-- COLD / GIANT TABLES — throttle so workers don't camp on them for ages
-- Higher cost_delay (20ms) and lower cost_limit (200) = worker yields often,
-- freeing slots for hot tables.
-- =============================================================================

-- workflow_events: 6.6 GB, append-only, 0 dead tuples at time of incident
ALTER TABLE public.workflow_events SET (
  autovacuum_vacuum_scale_factor = 0.1,
  autovacuum_vacuum_cost_delay = 20,
  autovacuum_vacuum_cost_limit = 200
);

-- submission_files: 6.5 GB, append-only
ALTER TABLE public.submission_files SET (
  autovacuum_vacuum_scale_factor = 0.1,
  autovacuum_vacuum_cost_delay = 20,
  autovacuum_vacuum_cost_limit = 200
);

-- grader_result_output: 4.6 GB, append-only
ALTER TABLE public.grader_result_output SET (
  autovacuum_vacuum_scale_factor = 0.1,
  autovacuum_vacuum_cost_delay = 20,
  autovacuum_vacuum_cost_limit = 200
);

-- grader_result_tests: 2.3 GB, append-only
ALTER TABLE public.grader_result_tests SET (
  autovacuum_vacuum_scale_factor = 0.1,
  autovacuum_vacuum_cost_delay = 20,
  autovacuum_vacuum_cost_limit = 200
);

-- =============================================================================
-- CRON: purge auth.audit_log_entries older than 90 days
-- =============================================================================
-- auth.audit_log_entries is 973 MB and growing with xid_age 141M/200M.
-- No retention setting in the Supabase console.
-- Purge existing backlog now, then cron keeps it trimmed daily.

DELETE FROM auth.audit_log_entries
WHERE created_at < now() - interval '90 days';

VACUUM (ANALYZE) auth.audit_log_entries;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'purge-auth-audit-log-entries'
  ) THEN
    PERFORM cron.schedule(
      'purge-auth-audit-log-entries',
      '15 4 * * *',  -- daily at 04:15 UTC
      'DELETE FROM auth.audit_log_entries WHERE created_at < now() - interval ''90 days'''
    );
  END IF;
END
$$;
