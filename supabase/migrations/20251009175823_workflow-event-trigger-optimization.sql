ALTER TABLE workflow_runs SET (
    autovacuum_vacuum_scale_factor = 0.02,  -- Vacuum at 2% dead tuples (was default 0.2 = 20%)
    autovacuum_vacuum_threshold = 50,       -- Minimum 50 dead tuples to trigger
    autovacuum_analyze_scale_factor = 0.01, -- Analyze more frequently
    autovacuum_vacuum_cost_delay = 2,       -- Faster vacuum
    autovacuum_vacuum_cost_limit = 1000     -- More aggressive cleanup
);

ALTER TABLE submissions SET (
    autovacuum_vacuum_scale_factor = 0.02,  -- Vacuum at 2% dead tuples (was default 0.2 = 20%)
    autovacuum_vacuum_threshold = 50,       -- Minimum 50 dead tuples to trigger
    autovacuum_analyze_scale_factor = 0.01, -- Analyze more frequently
    autovacuum_vacuum_cost_delay = 2,       -- Faster vacuum
    autovacuum_vacuum_cost_limit = 1000     -- More aggressive cleanup
);

ALTER TABLE workflow_events 
    DROP CONSTRAINT IF EXISTS workflow_events_workflow_run_id_event_type_run_attempt_key;

-- Drop repository lookup index
DROP INDEX IF EXISTS idx_workflow_events_repository_id;

-- Drop the partial index (never used - 0 scans)
DROP INDEX IF EXISTS idx_workflow_events_requested_lookup;

DROP INDEX IF EXISTS idx_submission_files_class_id;
DROP INDEX IF EXISTS idx_submission_files_profile_id;
DROP INDEX IF EXISTS idx_submission_files_assignment_group_id;

-- FIX: Remove read() RPC stampede from pg_cron scheduler functions
-- PROBLEM: Dynamic worker counts led to overprovisioning.
-- SOLUTION: Always spawn exactly 2 workers, no queue size checks.

CREATE OR REPLACE FUNCTION public.invoke_github_async_worker_background_task()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare
  i integer;
begin
  -- FIXED: Always spawn exactly 2 workers (no queue size check to avoid read() RPC stampede)
  -- Previous code called pgmq_public.read() here which caused excessive RPC load
  for i in 1..2 loop
    perform public.call_edge_function_internal(
      '/functions/v1/github-async-worker',
      'POST',
      '{"Content-type":"application/json","x-supabase-webhook-source":"github-async-worker"}'::jsonb,
      '{}'::jsonb,
      3000,
      null, null, null, null, null
    );
  end loop;
end;
$$;

CREATE OR REPLACE FUNCTION public.invoke_email_batch_processor_background_task()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- FIXED: Spawn exactly 2 workers instead of 3 for better resource management
    PERFORM public.call_edge_function_internal(
        '/functions/v1/notification-queue-processor', 
        'POST', 
        '{"Content-type":"application/json"}', 
        '{}', 
        5000,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL
    );
    PERFORM public.call_edge_function_internal(
        '/functions/v1/notification-queue-processor', 
        'POST', 
        '{"Content-type":"application/json"}', 
        '{}', 
        5000,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.invoke_gradebook_recalculation_background_task()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
declare
    i integer;
BEGIN
    -- FIXED: Always spawn exactly 2 workers (already correct, but simplified)
    for i in 1..2 loop
        PERFORM public.call_edge_function_internal(
            '/functions/v1/gradebook-column-recalculate', 
            'POST', 
            '{"Content-type":"application/json","x-supabase-webhook-source":"gradebook_column_recalculate"}', 
            '{}', 
            5000,
            NULL,
            NULL,
            NULL,
            NULL,
            NULL
        );
    end loop;
END;
$$;

CREATE INDEX idx_rubric_check_refs_class_referencing_covering
ON public.rubric_check_references (class_id, referencing_rubric_check_id)
INCLUDE (referenced_rubric_check_id, id);
