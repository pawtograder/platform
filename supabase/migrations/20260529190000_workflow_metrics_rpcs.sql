-- Workflow metrics RPCs called by the web app's /api/metrics route.
--
-- These aggregate public.workflow_runs / public.workflow_run_error into
-- Prometheus-friendly tabular outputs. Kept here so the SQL is reviewed
-- alongside other schema changes and lives in the migration history.
--
-- Each function:
--   - takes window_hours (default 1) so callers can pull both 1h and 24h
--     gauges from the same routine,
--   - returns rows with class_id::text so prom-client labels are stable,
--   - is STABLE (deterministic over the window) and SECURITY DEFINER so
--     the application role can call it without table-level grants.

CREATE OR REPLACE FUNCTION public.metrics_workflow_runs_by_conclusion(window_hours numeric DEFAULT 1)
RETURNS TABLE (class_id text, conclusion text, count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT class_id::text,
         COALESCE(conclusion, 'unknown') AS conclusion,
         COUNT(*)::bigint AS count
  FROM public.workflow_runs
  WHERE completed_at > NOW() - make_interval(hours => window_hours::int)
  GROUP BY class_id, COALESCE(conclusion, 'unknown')
$$;

COMMENT ON FUNCTION public.metrics_workflow_runs_by_conclusion(numeric) IS
  'Counts of completed autograder workflow runs in the last N hours, grouped by class and conclusion. Driver for web_workflow_runs_recent.';

CREATE OR REPLACE FUNCTION public.metrics_workflow_queue_percentiles(window_hours numeric DEFAULT 1)
RETURNS TABLE (class_id text, p50 numeric, p95 numeric, p99 numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT class_id::text,
         COALESCE(percentile_cont(0.50) WITHIN GROUP (ORDER BY queue_time_seconds), 0) AS p50,
         COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY queue_time_seconds), 0) AS p95,
         COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY queue_time_seconds), 0) AS p99
  FROM public.workflow_runs
  WHERE in_progress_at > NOW() - make_interval(hours => window_hours::int)
    AND queue_time_seconds IS NOT NULL
  GROUP BY class_id
$$;

COMMENT ON FUNCTION public.metrics_workflow_queue_percentiles(numeric) IS
  'P50/P95/P99 of queue duration (requested_at → in_progress_at) for autograder workflow runs in the last N hours, by class.';

CREATE OR REPLACE FUNCTION public.metrics_workflow_run_percentiles(window_hours numeric DEFAULT 1)
RETURNS TABLE (class_id text, p50 numeric, p95 numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT class_id::text,
         COALESCE(percentile_cont(0.50) WITHIN GROUP (ORDER BY run_time_seconds), 0) AS p50,
         COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY run_time_seconds), 0) AS p95
  FROM public.workflow_runs
  WHERE completed_at > NOW() - make_interval(hours => window_hours::int)
    AND run_time_seconds IS NOT NULL
  GROUP BY class_id
$$;

COMMENT ON FUNCTION public.metrics_workflow_run_percentiles(numeric) IS
  'P50/P95 of grader run duration (in_progress_at → completed_at) for autograder workflow runs in the last N hours, by class.';

CREATE OR REPLACE FUNCTION public.metrics_workflow_errors_by_name(window_hours numeric DEFAULT 1)
RETURNS TABLE (class_id text, name text, count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT class_id::text,
         name,
         COUNT(*)::bigint AS count
  FROM public.workflow_run_error
  WHERE created_at > NOW() - make_interval(hours => window_hours::int)
  GROUP BY class_id, name
  ORDER BY count DESC
  LIMIT 200
$$;

COMMENT ON FUNCTION public.metrics_workflow_errors_by_name(numeric) IS
  'Top 200 workflow_run_error rows in the last N hours, grouped by class and error name. Cap exists to bound prom-client cardinality.';

-- service_role is the role the web app calls these as (Supabase admin client).
GRANT EXECUTE ON FUNCTION public.metrics_workflow_runs_by_conclusion(numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.metrics_workflow_queue_percentiles(numeric)  TO service_role;
GRANT EXECUTE ON FUNCTION public.metrics_workflow_run_percentiles(numeric)    TO service_role;
GRANT EXECUTE ON FUNCTION public.metrics_workflow_errors_by_name(numeric)     TO service_role;
