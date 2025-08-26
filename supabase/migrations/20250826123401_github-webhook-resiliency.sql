-- Webhook resiliency and idempotency migration
-- 1) Track attempts and errors for webhook deliveries
ALTER TABLE public.webhook_process_status
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS event_name text,
  ADD COLUMN IF NOT EXISTS last_error text;

-- Ensure webhook_id is unique for upsert logic
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'webhook_process_status_webhook_id_key'
  ) THEN
    ALTER TABLE public.webhook_process_status
      ADD CONSTRAINT webhook_process_status_webhook_id_key UNIQUE (webhook_id);
  END IF;
END$$;

-- 2) Add unique keys to support idempotent inserts

-- repository_check_runs: one row per (repository_id, check_run_id, sha)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'repository_check_runs_repository_id_check_run_id_sha_key'
  ) THEN
    ALTER TABLE public.repository_check_runs
      ADD CONSTRAINT repository_check_runs_repository_id_check_run_id_sha_key UNIQUE (repository_id, check_run_id, sha);
  END IF;
END$$;

-- autograder_commits: one per (autograder_id, sha)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'autograder_commits_autograder_id_sha_key'
  ) THEN
    ALTER TABLE public.autograder_commits
      ADD CONSTRAINT autograder_commits_autograder_id_sha_key UNIQUE (autograder_id, sha);
  END IF;
END$$;

-- assignment_handout_commits: one per (assignment_id, sha)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'assignment_handout_commits_assignment_id_sha_key'
  ) THEN
    ALTER TABLE public.assignment_handout_commits
      ADD CONSTRAINT assignment_handout_commits_assignment_id_sha_key UNIQUE (assignment_id, sha);
  END IF;
END$$;

-- workflow_events: dedupe by (workflow_run_id, event_type, run_attempt)
-- First, remove duplicates keeping the most recent updated_at (fallback created_at)
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY workflow_run_id, event_type, run_attempt
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
    ) AS rn
  FROM public.workflow_events
)
DELETE FROM public.workflow_events we
USING ranked r
WHERE we.id = r.id AND r.rn > 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workflow_events_workflow_run_id_event_type_run_attempt_key'
  ) THEN
    ALTER TABLE public.workflow_events
      ADD CONSTRAINT workflow_events_workflow_run_id_event_type_run_attempt_key UNIQUE (workflow_run_id, event_type, run_attempt);
  END IF;
END$$;

-- workflow_run_error: dedupe by (repository_id, run_number, run_attempt, name)
-- Name is our error-type surrogate; adjust if separate column is later added.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workflow_run_error_repo_run_attempt_name_key'
  ) THEN
    ALTER TABLE public.workflow_run_error
      ADD CONSTRAINT workflow_run_error_repo_run_attempt_name_key UNIQUE (repository_id, run_number, run_attempt, name);
  END IF;
END$$;

-- 3) Helpful indexes
CREATE INDEX IF NOT EXISTS webhook_process_status_completed_idx ON public.webhook_process_status (completed);
CREATE INDEX IF NOT EXISTS webhook_process_status_attempt_count_idx ON public.webhook_process_status (attempt_count);
CREATE INDEX IF NOT EXISTS repository_check_runs_sha_idx ON public.repository_check_runs (sha);
CREATE INDEX IF NOT EXISTS autograder_commits_sha_idx ON public.autograder_commits (sha);
CREATE INDEX IF NOT EXISTS assignment_handout_commits_sha_idx ON public.assignment_handout_commits (sha);
CREATE INDEX IF NOT EXISTS workflow_events_run_id_idx ON public.workflow_events (workflow_run_id);
CREATE INDEX IF NOT EXISTS workflow_run_error_repo_run_attempt_idx ON public.workflow_run_error (repository_id, run_number, run_attempt);

-- 4) Security definer function to fetch recent workflow_events_summary rows for a class
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

-- 5) Updated get_workflow_statistics function with proper error counting
-- This replaces the previous version to count workflow_run_error records directly
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
AS $$
DECLARE
  v_period_start timestamptz;
  v_period_end timestamptz;
BEGIN
  -- Set explicit search_path to harden SECURITY DEFINER
  SET LOCAL search_path = public, pg_temp;
  
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
GRANT EXECUTE ON FUNCTION "public"."get_workflow_statistics"(bigint, integer) TO "authenticated";


