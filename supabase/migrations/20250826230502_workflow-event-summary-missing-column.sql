-- Drop dependent functions first
DROP FUNCTION IF EXISTS "public"."get_workflow_events_summary_for_class"(bigint);
DROP FUNCTION IF EXISTS "public"."get_workflow_statistics"(bigint, integer);
DROP FUNCTION IF EXISTS "public"."refresh_workflow_events_summary"();

-- Now we can drop the materialized view
DROP MATERIALIZED VIEW IF EXISTS "public"."workflow_events_summary";
-- Create materialized view for pre-computed results (service_role access only)
CREATE MATERIALIZED VIEW "public"."workflow_events_summary" AS
WITH workflow_events_filtered AS (
  -- Aggressive pre-filtering for queue_time_seconds, run_time_seconds queries
  -- Only include events that can contribute to timing calculations
  SELECT 
    we.workflow_run_id,
    we.run_attempt,
    we.class_id,
    we.workflow_name,
    we.workflow_path,
    we.head_sha,
    we.head_branch,
    we.run_number,
    we.actor_login,
    we.triggering_actor_login,
    we.repository_id,
    we.event_type,
    we.updated_at,
    we.conclusion
  FROM "public"."workflow_events" we
  -- Semijoin to ensure workflow runs have at least a 'requested' event
  -- This is more index-friendly than EXISTS subquery
  JOIN (
    SELECT DISTINCT workflow_run_id, run_attempt, class_id
    FROM "public"."workflow_events" 
    WHERE event_type = 'requested'
  ) requested_events ON (
    we.workflow_run_id = requested_events.workflow_run_id 
    AND we.run_attempt = requested_events.run_attempt 
    AND we.class_id = requested_events.class_id
  )
  WHERE we.class_id IS NOT NULL
    -- Only include events that are needed for timing calculations
    AND we.event_type IN ('requested', 'in_progress', 'completed')
    -- Use precise timestamp to avoid midnight truncation edge cases
    AND we.updated_at >= (NOW() - INTERVAL '6 months')
),
aggregated_events AS (
  SELECT 
    wef.workflow_run_id,
    wef.run_attempt,
    wef.class_id,
    wef.workflow_name,
    wef.workflow_path,
    wef.head_sha,
    wef.head_branch,
    wef.run_number,
    MAX(CASE WHEN wef.event_type = 'requested' THEN wef.actor_login END) AS actor_login,
    MAX(CASE WHEN wef.event_type = 'requested' THEN wef.triggering_actor_login END) AS triggering_actor_login,
    r.assignment_id,
    r.profile_id,
    MAX(CASE WHEN wef.event_type = 'requested' THEN wef.updated_at END) AS requested_at,
    MAX(CASE WHEN wef.event_type = 'in_progress' THEN wef.updated_at END) AS in_progress_at,
    MAX(CASE WHEN wef.event_type = 'completed' THEN wef.updated_at END) AS completed_at,
    MAX(CASE WHEN wef.event_type = 'completed' THEN wef.conclusion END) AS conclusion
  FROM workflow_events_filtered wef
  JOIN "public"."repositories" r ON (wef.repository_id = r.id)
  GROUP BY 
    wef.workflow_run_id, 
    wef.run_attempt, 
    wef.class_id, 
    wef.workflow_name, 
    wef.workflow_path, 
    wef.head_sha, 
    wef.head_branch, 
    wef.run_number, 
    wef.actor_login, 
    wef.triggering_actor_login, 
    r.assignment_id, 
    r.profile_id
)
SELECT 
  workflow_run_id,
  class_id,
  workflow_name,
  workflow_path,
  head_sha,
  head_branch,
  run_number,
  run_attempt,
  actor_login,
  triggering_actor_login,
  assignment_id,
  profile_id,
  requested_at,
  in_progress_at,
  completed_at,
  conclusion,
  CASE
    WHEN (requested_at IS NOT NULL AND in_progress_at IS NOT NULL) 
    THEN EXTRACT(epoch FROM (in_progress_at - requested_at))
    ELSE NULL
  END AS queue_time_seconds,
  CASE
    WHEN (in_progress_at IS NOT NULL AND completed_at IS NOT NULL) 
    THEN EXTRACT(epoch FROM (completed_at - in_progress_at))
    ELSE NULL
  END AS run_time_seconds
FROM aggregated_events;


-- Create indexes on the materialized view for fast querying
CREATE INDEX IF NOT EXISTS "idx_workflow_events_summary_class_id" 
ON "public"."workflow_events_summary" USING "btree" ("class_id");

CREATE INDEX IF NOT EXISTS "idx_workflow_events_summary_requested_at" 
ON "public"."workflow_events_summary" USING "btree" ("requested_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_workflow_events_summary_class_requested" 
ON "public"."workflow_events_summary" USING "btree" ("class_id", "requested_at" DESC);

-- Create a unique index to enable concurrent refresh
CREATE UNIQUE INDEX IF NOT EXISTS "idx_workflow_events_summary_unique" 
ON "public"."workflow_events_summary" USING "btree" ("workflow_run_id", "run_attempt", "class_id");

-- Grant permissions ONLY to service_role (no public access)
REVOKE ALL ON TABLE "public"."workflow_events_summary" FROM "anon";
REVOKE ALL ON TABLE "public"."workflow_events_summary" FROM "authenticated";
GRANT ALL ON TABLE "public"."workflow_events_summary" TO "service_role";

-- Recreate dependent functions

-- 1) refresh_workflow_events_summary function
CREATE OR REPLACE FUNCTION "public"."refresh_workflow_events_summary"()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Refresh the materialized view concurrently if possible
  -- Falls back to regular refresh if concurrent refresh fails
  BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY "public"."workflow_events_summary";
  EXCEPTION WHEN OTHERS THEN
    -- If concurrent refresh fails (e.g., no unique index), do regular refresh
    REFRESH MATERIALIZED VIEW "public"."workflow_events_summary";
  END;
END;
$$;

-- Grant execute permission on the refresh function
GRANT EXECUTE ON FUNCTION "public"."refresh_workflow_events_summary"() TO "service_role";

-- 2) get_workflow_events_summary_for_class function
CREATE OR REPLACE FUNCTION public.get_workflow_events_summary_for_class(p_class_id bigint)
RETURNS SETOF public.workflow_events_summary
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Authorization: only instructors for the class may access
  IF NOT public.authorizeforclassinstructor(p_class_id) THEN
    RAISE EXCEPTION 'Access denied: You must be an instructor to view workflow events'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Efficient bounded query; relies on underlying view/indexes
  RETURN QUERY
  SELECT *
  FROM public.workflow_events_summary
  WHERE class_id = p_class_id
  ORDER BY COALESCE(completed_at, in_progress_at, requested_at) DESC NULLS LAST,
           run_number DESC,
           run_attempt DESC
  LIMIT 1000;
END;
$$;

-- Ensure only intended roles can execute
REVOKE ALL ON FUNCTION public.get_workflow_events_summary_for_class(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_workflow_events_summary_for_class(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_workflow_events_summary_for_class(bigint) TO service_role;

-- 3) get_workflow_statistics function
CREATE OR REPLACE FUNCTION "public"."get_workflow_statistics"(
  p_class_id bigint,
  p_duration_hours integer DEFAULT 24
)
RETURNS TABLE(
  class_id bigint,
  duration_hours integer,
  total_runs bigint,
  completed_runs bigint,
  failed_runs bigint,
  in_progress_runs bigint,
  avg_queue_time_seconds numeric,
  avg_run_time_seconds numeric,
  error_count bigint,
  error_rate numeric,
  success_rate numeric,
  period_start timestamptz,
  period_end timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period_start timestamptz;
  v_period_end timestamptz;
BEGIN
  -- Set explicit search_path to harden SECURITY DEFINER
  
  -- Check authorization using existing function
  IF NOT authorizeforclassgrader(p_class_id) THEN
    RAISE EXCEPTION 'Access denied: insufficient permissions for class %', p_class_id;
  END IF;

  -- Calculate time period, clamp start to respect MV retention (6 months)
  v_period_end := NOW();
  v_period_start := GREATEST(
    v_period_end - (p_duration_hours || ' hours')::interval,
    NOW() - INTERVAL '6 months'
  );

  -- Return statistics from materialized view, always return a row even if no data
  RETURN QUERY
  WITH workflow_stats AS (
    SELECT 
      wes.workflow_run_id,
      wes.run_attempt,
      wes.run_number,
      wes.class_id,
      wes.requested_at,
      wes.in_progress_at,
      wes.completed_at,
      wes.conclusion,
      wes.queue_time_seconds,
      wes.run_time_seconds
    FROM "public"."workflow_events_summary" wes
    WHERE wes.class_id = p_class_id
      AND wes.requested_at >= v_period_start
      AND wes.requested_at <= v_period_end
  ),
  error_stats AS (
    SELECT COUNT(*)::bigint as total_error_count
    FROM "public"."workflow_run_error" wre
    WHERE wre.class_id = p_class_id
      AND wre.created_at >= v_period_start
      AND wre.created_at <= v_period_end
  ),
  base_stats AS (
    SELECT 
      COUNT(*)::bigint as total_runs,
      COUNT(CASE WHEN ws.conclusion = 'success' THEN 1 END)::bigint as completed_runs,
      COUNT(CASE WHEN ws.conclusion IS NOT NULL AND ws.conclusion <> 'success' THEN 1 END)::bigint as failed_runs,
      COUNT(CASE WHEN ws.in_progress_at IS NOT NULL AND ws.completed_at IS NULL THEN 1 END)::bigint as in_progress_runs,
      AVG(ws.queue_time_seconds) as avg_queue_time_seconds,
      AVG(ws.run_time_seconds) as avg_run_time_seconds
    FROM workflow_stats ws
  )
  SELECT 
    p_class_id as class_id,
    p_duration_hours as duration_hours,
    COALESCE(bs.total_runs, 0::bigint) as total_runs,
    COALESCE(bs.completed_runs, 0::bigint) as completed_runs,
    COALESCE(bs.failed_runs, 0::bigint) as failed_runs,
    COALESCE(bs.in_progress_runs, 0::bigint) as in_progress_runs,
    COALESCE(ROUND((bs.avg_queue_time_seconds)::numeric, 2), 0.00) as avg_queue_time_seconds,
    COALESCE(ROUND((bs.avg_run_time_seconds)::numeric, 2), 0.00) as avg_run_time_seconds,
    COALESCE(es.total_error_count, 0::bigint) as error_count,
    CASE 
      WHEN COALESCE(bs.total_runs, 0) > 0 THEN ROUND((COALESCE(es.total_error_count, 0)::numeric / bs.total_runs::numeric) * 100, 2)
      ELSE 0.00
    END as error_rate,
    CASE 
      WHEN COALESCE(bs.total_runs, 0) > 0 THEN ROUND((bs.completed_runs::numeric / bs.total_runs::numeric) * 100, 2)
      ELSE 0.00
    END as success_rate,
    v_period_start as period_start,
    v_period_end as period_end
  FROM (SELECT 1) dummy -- Ensure we always return a row
  LEFT JOIN base_stats bs ON true
  LEFT JOIN error_stats es ON true;
END;
$$;

-- Grant execute permission to authenticated users (authorization handled inside function)
GRANT EXECUTE ON FUNCTION public.get_workflow_statistics(bigint, integer) TO service_role;
GRANT EXECUTE ON FUNCTION "public"."get_workflow_statistics"(bigint, integer) TO "authenticated";
REVOKE ALL ON FUNCTION public.get_workflow_statistics(bigint, integer) FROM PUBLIC;
