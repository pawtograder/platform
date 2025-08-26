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


