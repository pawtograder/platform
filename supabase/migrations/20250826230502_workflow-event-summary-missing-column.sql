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
    wef.actor_login,
    wef.triggering_actor_login,
    r.assignment_id,
    r.profile_id,
    MAX(CASE WHEN wef.event_type = 'requested' THEN wef.updated_at END) AS requested_at,
    MAX(CASE WHEN wef.event_type = 'in_progress' THEN wef.updated_at END) AS in_progress_at,
    MAX(CASE WHEN wef.event_type = 'completed' THEN wef.updated_at END) AS completed_at
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