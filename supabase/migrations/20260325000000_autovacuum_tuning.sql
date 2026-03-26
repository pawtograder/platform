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

-- submissions: 73 MB heap / 266 MB indexes, low HOT update ratio.
-- Already has autovacuum tuning but default fillfactor.
ALTER TABLE public.submissions SET (fillfactor = 70);

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

-- =============================================================================
-- MONITORING: vacuum health check RPC + proactive cron alert
-- =============================================================================

-- RPC callable via PostgREST: SELECT * FROM vacuum_health_check();
CREATE OR REPLACE FUNCTION public.vacuum_health_check()
RETURNS TABLE (
  check_name text,
  severity text,
  relname text,
  detail text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  -- Tables that need vacuum but haven't been vacuumed in over 1 hour
  SELECT
    'vacuum_overdue'::text,
    'warning'::text,
    s.relname::text,
    format('dead_tuples=%s threshold=%s last_autovacuum=%s',
      s.n_dead_tup,
      (50 + 0.20 * s.n_live_tup)::int,
      COALESCE(s.last_autovacuum::text, 'never'))
  FROM pg_stat_user_tables s
  WHERE s.n_dead_tup > (50 + 0.20 * s.n_live_tup)
    AND (s.last_autovacuum IS NULL OR s.last_autovacuum < now() - interval '1 hour')

  UNION ALL

  -- XID age approaching freeze limit (>75%)
  SELECT
    'xid_wraparound_risk'::text,
    CASE
      WHEN age(c.relfrozenxid) > 0.90 * current_setting('autovacuum_freeze_max_age')::bigint THEN 'critical'
      ELSE 'warning'
    END,
    c.relname::text,
    format('xid_age=%s freeze_max=%s pct=%s%% size=%s',
      age(c.relfrozenxid),
      current_setting('autovacuum_freeze_max_age'),
      round(100.0 * age(c.relfrozenxid) / current_setting('autovacuum_freeze_max_age')::bigint, 1),
      pg_size_pretty(pg_total_relation_size(c.oid)))
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r'
    AND age(c.relfrozenxid) > 0.75 * current_setting('autovacuum_freeze_max_age')::bigint

  UNION ALL

  -- Dead tuple ratio > 20% (bloat building up)
  SELECT
    'high_dead_tuple_ratio'::text,
    'warning'::text,
    s.relname::text,
    format('live=%s dead=%s ratio=%s%% size=%s',
      s.n_live_tup, s.n_dead_tup,
      round(100.0 * s.n_dead_tup / NULLIF(s.n_live_tup, 0), 1),
      pg_size_pretty(pg_total_relation_size(s.relid)))
  FROM pg_stat_user_tables s
  WHERE s.n_live_tup > 100
    AND s.n_dead_tup > 0.20 * s.n_live_tup

  UNION ALL

  -- Tables > 1 GB that have never been vacuumed (since stats reset)
  SELECT
    'never_vacuumed_large_table'::text,
    'warning'::text,
    s.relname::text,
    format('size=%s live=%s dead=%s',
      pg_size_pretty(pg_total_relation_size(s.relid)),
      s.n_live_tup, s.n_dead_tup)
  FROM pg_stat_user_tables s
  WHERE pg_total_relation_size(s.relid) > 1073741824  -- 1 GB
    AND s.last_autovacuum IS NULL
    AND s.vacuum_count = 0
    AND s.autovacuum_count = 0

  ORDER BY 2, 1, 3;
$$;

ALTER FUNCTION public.vacuum_health_check() OWNER TO postgres;
COMMENT ON FUNCTION public.vacuum_health_check() IS
  'Returns vacuum health warnings: overdue vacuums, XID wraparound risk, dead tuple bloat, and large unvacuumed tables.';

-- RPC: database RAM metrics for Prometheus scraping
-- Must enable in the Supabase console for this to work.
-- CREATE EXTENSION IF NOT EXISTS pg_buffercache;

CREATE OR REPLACE FUNCTION public.database_ram_metrics()
RETURNS TABLE (
  metric_name text,
  metric_labels jsonb,
  metric_value numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Buffer cache metrics require pg_buffercache extension
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_buffercache') THEN
    RETURN QUERY
    SELECT * FROM (
      SELECT
        'buffer_cache_bytes'::text AS mn,
        jsonb_build_object('relname', c.relname) AS ml,
        (count(*) * 8192)::numeric AS mv
      FROM pg_buffercache b
      JOIN pg_class c ON c.relfilenode = b.relfilenode
      WHERE b.reldatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
      GROUP BY c.relname
      HAVING count(*) * 8192 > 1048576
      ORDER BY count(*) DESC
      LIMIT 20
    ) bc;

    RETURN QUERY
    SELECT
      'buffer_cache_total_used_bytes'::text,
      '{}'::jsonb,
      (count(*) * 8192)::numeric
    FROM pg_buffercache
    WHERE reldatabase = (SELECT oid FROM pg_database WHERE datname = current_database());
  ELSE
    RAISE WARNING 'pg_buffercache extension not installed — buffer cache metrics unavailable. Enable it in the Supabase dashboard under Database > Extensions.';
  END IF;

  -- Connection count by state (no extension needed)
  RETURN QUERY
  SELECT
    'connections'::text,
    jsonb_build_object('state', COALESCE(state, 'unknown')),
    count(*)::numeric
  FROM pg_stat_activity
  WHERE datname = current_database()
  GROUP BY state;

  -- Table sizes for the biggest tables
  RETURN QUERY
  SELECT * FROM (
    SELECT
      'table_total_bytes'::text AS mn,
      jsonb_build_object('relname', relname) AS ml,
      pg_total_relation_size(relid)::numeric AS mv
    FROM pg_stat_user_tables
    WHERE pg_total_relation_size(relid) > 104857600
    ORDER BY pg_total_relation_size(relid) DESC
    LIMIT 20
  ) ts;

  -- Dead tuple counts for hot tables
  RETURN QUERY
  SELECT * FROM (
    SELECT
      'dead_tuples'::text AS mn,
      jsonb_build_object('relname', relname) AS ml,
      n_dead_tup::numeric AS mv
    FROM pg_stat_user_tables
    WHERE n_dead_tup > 100
    ORDER BY n_dead_tup DESC
    LIMIT 20
  ) dt;
END;
$$;

ALTER FUNCTION public.database_ram_metrics() OWNER TO postgres;
COMMENT ON FUNCTION public.database_ram_metrics() IS
  'Returns database RAM metrics: buffer cache usage by table, connection counts, table sizes, and dead tuple counts.';

-- Cron: run health check every 15 minutes, notify on any findings
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'vacuum-health-monitor'
  ) THEN
    PERFORM cron.schedule(
      'vacuum-health-monitor',
      '*/15 * * * *',
      'SELECT pg_notify(''vacuum_health_alert'', row_to_json(r)::text) FROM public.vacuum_health_check() r WHERE severity = ''critical'''
    );
  END IF;
END
$$;
