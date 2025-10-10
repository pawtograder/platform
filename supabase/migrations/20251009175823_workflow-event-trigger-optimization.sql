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