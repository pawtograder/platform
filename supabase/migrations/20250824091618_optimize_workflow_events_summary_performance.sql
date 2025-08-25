-- Optimize workflow_events_summary view performance
-- 
-- Performance issues identified:
-- 1. GroupAggregate on 101,563 rows taking 342ms
-- 2. HAVING clause filtering after aggregation (removing 12,140 rows post-group)
-- 3. Incremental Sort taking 258ms 
-- 4. Missing composite indexes for common query patterns
--
-- Solutions:
-- 1. Add composite indexes optimized for common filtering patterns (class_id + updated_at)
-- 2. Add index for workflow_run_id + run_attempt grouping
-- 3. Consider partial indexes for recent data if needed

-- Create composite index for class_id + updated_at to optimize time-based filtering
-- This will help with the common pattern: WHERE class_id = X AND requested_at >= Y
CREATE INDEX IF NOT EXISTS "idx_workflow_events_class_id_updated_at" 
ON "public"."workflow_events" USING "btree" ("class_id", "updated_at" DESC);

-- Create composite index for the GROUP BY columns to optimize aggregation
-- This covers the main grouping keys: workflow_run_id, run_attempt, class_id
CREATE INDEX IF NOT EXISTS "idx_workflow_events_grouping_keys" 
ON "public"."workflow_events" USING "btree" ("workflow_run_id", "run_attempt", "class_id");

-- Create composite index for event_type + updated_at to optimize the CASE WHEN aggregations
-- This will help with the MAX(CASE WHEN event_type = 'requested' THEN updated_at) patterns
CREATE INDEX IF NOT EXISTS "idx_workflow_events_event_type_updated_at" 
ON "public"."workflow_events" USING "btree" ("event_type", "updated_at" DESC);

-- Create a covering index that includes frequently accessed columns
-- This can help avoid table lookups for the most common query patterns
CREATE INDEX IF NOT EXISTS "idx_workflow_events_class_covering" 
ON "public"."workflow_events" USING "btree" ("class_id", "workflow_run_id", "run_attempt") 
INCLUDE ("event_type", "updated_at", "workflow_name", "workflow_path", "head_sha", "head_branch", "run_number", "actor_login", "triggering_actor_login", "repository_id");

-- Optional: Create partial index for recent workflow events (last 6 months)
-- This can significantly speed up queries that typically focus on recent data
-- Uncomment if most queries focus on recent data:
-- CREATE INDEX IF NOT EXISTS "idx_workflow_events_recent_class_updated" 
-- ON "public"."workflow_events" USING "btree" ("class_id", "updated_at" DESC)
-- WHERE "updated_at" >= (CURRENT_DATE - INTERVAL '6 months');

-- Analyze the table to update statistics after index creation
ANALYZE "public"."workflow_events";

-- Additional optimization: Create a materialized view for maximum performance
-- This addresses the remaining bottleneck where HAVING clause filtering happens after expensive GROUP BY
-- Materialized view will be service_role only, with controlled access via security definer functions

-- First, drop the existing view/materialized view to replace it with a materialized view
-- Handle both cases to make migration idempotent across environments
DROP VIEW IF EXISTS "public"."workflow_events_summary";

-- Create supporting partial index for efficient semijoin lookup
-- This index optimizes the "has requested event" check by pre-filtering on event_type
CREATE INDEX IF NOT EXISTS "idx_workflow_events_requested_lookup" 
ON "public"."workflow_events" USING "btree" ("event_type", "workflow_run_id", "run_attempt", "class_id") 
WHERE "event_type" = 'requested';

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
    we.updated_at
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

-- Create function to refresh the materialized view
CREATE OR REPLACE FUNCTION "public"."refresh_workflow_events_summary"()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Set explicit search_path to harden SECURITY DEFINER
  SET LOCAL search_path = pg_catalog, public;
  
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

-- Schedule automatic refresh every 5 minutes using pgron
-- Wrap in DO block to check for existing job and ensure idempotency
DO $$
BEGIN
  -- Only schedule if no existing job with this name is found
  IF NOT EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'refresh-workflow-events-summary'
  ) THEN
    PERFORM cron.schedule('refresh-workflow-events-summary', '*/5 * * * *', 'SELECT refresh_workflow_events_summary();');
  END IF;
END $$;

-- Create security definer function to provide controlled access to workflow statistics
-- This function uses authorizeforclassgrader to ensure proper access control
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
      wes.class_id,
      wes.requested_at,
      wes.in_progress_at,
      wes.completed_at,
      wes.queue_time_seconds,
      wes.run_time_seconds
    FROM "public"."workflow_events_summary" wes
    WHERE wes.class_id = p_class_id
      AND wes.requested_at >= v_period_start
      AND wes.requested_at <= v_period_end
  ),
  error_stats AS (
    SELECT COUNT(DISTINCT ws.workflow_run_id) as error_count
    FROM "public"."workflow_run_error" wre
    JOIN workflow_stats ws ON (
      wre.run_number = ws.run_number 
      AND (wre.run_attempt IS NULL OR wre.run_attempt = ws.run_attempt)
      AND wre.class_id = ws.class_id
    )
    WHERE wre.class_id = p_class_id
      AND wre.created_at >= v_period_start
      AND wre.created_at <= v_period_end
  ),
  base_stats AS (
    SELECT 
      COUNT(*)::bigint as total_runs,
      COUNT(CASE WHEN ws.completed_at IS NOT NULL THEN 1 END)::bigint as completed_runs,
      -- Failed runs: runs that are not completed but have at least one error
      COUNT(CASE WHEN ws.completed_at IS NULL AND es.error_count > 0 THEN 1 END)::bigint as failed_runs,
      COUNT(CASE WHEN ws.in_progress_at IS NOT NULL AND ws.completed_at IS NULL THEN 1 END)::bigint as in_progress_runs,
      AVG(ws.queue_time_seconds) as avg_queue_time_seconds,
      AVG(ws.run_time_seconds) as avg_run_time_seconds,
      es.error_count
    FROM workflow_stats ws
    CROSS JOIN error_stats es
    GROUP BY es.error_count
  )
  SELECT 
    p_class_id as class_id,
    p_duration_hours as duration_hours,
    COALESCE(bs.total_runs, 0::bigint) as total_runs,
    COALESCE(bs.completed_runs, 0::bigint) as completed_runs,
    COALESCE(bs.failed_runs, 0::bigint) as failed_runs,
    COALESCE(bs.in_progress_runs, 0::bigint) as in_progress_runs,
    COALESCE(ROUND(bs.avg_queue_time_seconds, 2), 0.00) as avg_queue_time_seconds,
    COALESCE(ROUND(bs.avg_run_time_seconds, 2), 0.00) as avg_run_time_seconds,
    COALESCE(bs.error_count, 0::bigint) as error_count,
    CASE 
      WHEN COALESCE(bs.total_runs, 0) > 0 THEN ROUND((COALESCE(bs.error_count, 0)::numeric / bs.total_runs::numeric) * 100, 2)
      ELSE 0.00
    END as error_rate,
    CASE 
      WHEN COALESCE(bs.total_runs, 0) > 0 THEN ROUND((bs.completed_runs::numeric / bs.total_runs::numeric) * 100, 2)
      ELSE 0.00
    END as success_rate,
    v_period_start as period_start,
    v_period_end as period_end
  FROM (SELECT 1) dummy -- Ensure we always return a row
  LEFT JOIN base_stats bs ON true;
END;
$$;

-- Grant execute permission to authenticated users (authorization handled inside function)
GRANT EXECUTE ON FUNCTION "public"."get_workflow_statistics"(bigint, integer) TO "authenticated";

-- Create security definer function to get all metrics for all classes (service_role only)
-- This function returns comprehensive metrics in JSON format for monitoring/metrics endpoints
CREATE OR REPLACE FUNCTION "public"."get_all_class_metrics"()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result jsonb := '[]'::jsonb;
  class_record record;
  class_metrics jsonb;
BEGIN
  -- Set explicit search_path to harden SECURITY DEFINER
  SET LOCAL search_path = public, pg_temp;
  
  -- Only allow service_role to call this function
  IF auth.role() != 'service_role' THEN
    RAISE EXCEPTION 'Access denied: function only available to service_role';
  END IF;

  -- Loop through all active (non-archived) classes
  FOR class_record IN 
    SELECT id, name, slug FROM "public"."classes" WHERE archived = false
  LOOP
    -- Build metrics JSON for this class
    SELECT jsonb_build_object(
      'class_id', class_record.id,
      'class_name', class_record.name,
      'class_slug', class_record.slug,
      
      -- Workflow metrics from materialized view
      'workflow_runs_total', (
        SELECT COUNT(*) FROM "public"."workflow_events_summary" 
        WHERE class_id = class_record.id
      ),
      'workflow_runs_completed', (
        SELECT COUNT(*) FROM "public"."workflow_events_summary" 
        WHERE class_id = class_record.id AND completed_at IS NOT NULL
      ),
      'workflow_runs_failed', (
        SELECT COUNT(*) FROM "public"."workflow_events_summary" 
        WHERE class_id = class_record.id 
          AND requested_at IS NOT NULL 
          AND completed_at IS NULL 
          AND in_progress_at IS NULL
      ),
      'workflow_runs_in_progress', (
        SELECT COUNT(*) FROM "public"."workflow_events_summary" 
        WHERE class_id = class_record.id 
          AND in_progress_at IS NOT NULL 
          AND completed_at IS NULL
      ),
      
      -- Workflow error metrics
      'workflow_errors_total', (
        SELECT COUNT(*) FROM "public"."workflow_run_error" 
        WHERE class_id = class_record.id
      ),
      
      -- Submission metrics
      'submissions_total', (
        SELECT COUNT(*) FROM "public"."submissions" 
        WHERE class_id = class_record.id AND is_active = true
      ),
      'submissions_recent_24h', (
        SELECT COUNT(*) FROM "public"."submissions" 
        WHERE class_id = class_record.id 
          AND is_active = true 
          AND created_at >= (NOW() - INTERVAL '24 hours')
      ),
      
      -- Discussion thread metrics
      'discussion_threads_total', (
        SELECT COUNT(*) FROM "public"."discussion_threads" 
        WHERE class_id = class_record.id
      ),
      
      -- Help request metrics
      'help_requests_total', (
        SELECT COUNT(*) FROM "public"."help_requests" 
        WHERE class_id = class_record.id
      ),
      'help_requests_open', (
        SELECT COUNT(*) FROM "public"."help_requests" 
        WHERE class_id = class_record.id AND status = 'open'
      )
      
    ) INTO class_metrics;
    
    -- Add this class's metrics to the result array
    result := result || jsonb_build_array(class_metrics);
  END LOOP;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION "public"."get_all_class_metrics"() FROM "authenticated";
REVOKE ALL ON FUNCTION "public"."get_all_class_metrics"() FROM "anon";
-- Grant execute permission ONLY to service_role
GRANT EXECUTE ON FUNCTION "public"."get_all_class_metrics"() TO "service_role";

-- Create a super-optimized view specifically for timing queries (queue_time_seconds, run_time_seconds)
-- This view is designed for queries that only need timing data and can be much faster
CREATE OR REPLACE VIEW "public"."workflow_timing_summary" WITH ("security_invoker"='true') AS
WITH timing_events AS (
  -- Ultra-aggressive filtering: only get the exact events needed for timing
  SELECT 
    we.workflow_run_id,
    we.run_attempt,
    we.class_id,
    we.event_type,
    we.updated_at,
    r.assignment_id,
    r.profile_id
  FROM "public"."workflow_events" we
  JOIN "public"."repositories" r ON (we.repository_id = r.id)
  WHERE we.class_id IS NOT NULL
    -- Only the 3 event types needed for timing calculations
    AND we.event_type IN ('requested', 'in_progress', 'completed')
    -- Aggressive time window - adjust based on your query patterns
    AND we.updated_at >= (CURRENT_DATE - INTERVAL '3 months')
),
timing_pivoted AS (
  SELECT 
    workflow_run_id,
    run_attempt,
    class_id,
    assignment_id,
    profile_id,
    MAX(CASE WHEN event_type = 'requested' THEN updated_at END) AS requested_at,
    MAX(CASE WHEN event_type = 'in_progress' THEN updated_at END) AS in_progress_at,
    MAX(CASE WHEN event_type = 'completed' THEN updated_at END) AS completed_at
  FROM timing_events
  GROUP BY workflow_run_id, run_attempt, class_id, assignment_id, profile_id
  -- Pre-filter: only include runs that have at least a 'requested' event
  HAVING MAX(CASE WHEN event_type = 'requested' THEN updated_at END) IS NOT NULL
)
SELECT 
  workflow_run_id,
  run_attempt,
  class_id,
  assignment_id,
  profile_id,
  requested_at,
  in_progress_at,
  completed_at,
  -- Optimized timing calculations
  CASE
    WHEN requested_at IS NOT NULL AND in_progress_at IS NOT NULL 
    THEN EXTRACT(epoch FROM (in_progress_at - requested_at))
    ELSE NULL
  END AS queue_time_seconds,
  CASE
    WHEN in_progress_at IS NOT NULL AND completed_at IS NOT NULL 
    THEN EXTRACT(epoch FROM (completed_at - in_progress_at))
    ELSE NULL
  END AS run_time_seconds
FROM timing_pivoted;

-- Grant permissions to the timing-specific view
GRANT ALL ON TABLE "public"."workflow_timing_summary" TO "anon";
GRANT ALL ON TABLE "public"."workflow_timing_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."workflow_timing_summary" TO "service_role";

-- 
-- Expected improvements from indexes:
-- 1. Faster filtering by class_id + time range
-- 2. More efficient GROUP BY operations  
-- 3. Optimized MAX() aggregations with CASE WHEN on event_type
-- 4. Reduced I/O through covering index for common columns
--
-- Expected improvements from optimized views:
-- 1. Pre-filtering reduces dataset size before expensive aggregation
-- 2. Simplified CASE WHEN expressions for better performance
-- 3. CTE structure allows PostgreSQL to optimize each step independently
-- 4. Time-based pre-filtering at base table level instead of post-aggregation
--
-- TIMING-SPECIFIC OPTIMIZATIONS (workflow_timing_summary):
-- 1. Ultra-aggressive filtering: only 3 event types ('requested', 'in_progress', 'completed')
-- 2. Shorter time window (3 months vs 6 months) for recent timing data
-- 3. Minimal column selection - only timing-related fields
-- 4. HAVING clause eliminates incomplete workflow runs early
-- 5. Optimized for queries selecting only queue_time_seconds, run_time_seconds
--
-- SECURITY AND ACCESS PATTERNS:
-- 1. workflow_events_summary (materialized view):
--    - Service role access only
--    - Refreshed every 5 minutes via pgron
--    - Maximum performance for internal operations
--
-- 2. get_workflow_statistics() function:
--    - Public interface with proper authorization
--    - Uses authorizeforclassgrader() for access control
--    - Returns computed statistics over configurable time periods
--    - Recommended for application use
--
-- 3. workflow_timing_summary (regular view):
--    - Fallback view with security_invoker=true
--    - Real-time data with RLS support
--    - Use for timing-specific queries when function doesn't meet needs
--
-- USAGE RECOMMENDATIONS:
-- - Use get_workflow_statistics(class_id, hours) for dashboard statistics
-- - Use workflow_timing_summary for real-time timing queries with RLS
-- - Direct materialized view access only for service_role operations

-- Update RLS policy for review assignment rubric parts to consolidate access rules
-- This replaces multiple policies with a single comprehensive policy using OR conditions
-- Drop existing policies first to avoid conflicts
DROP POLICY IF EXISTS "Assignees can view rubric parts for their reviews" ON "public"."review_assignment_rubric_parts";

CREATE POLICY "Assignees can view rubric parts for their reviews" ON "public"."review_assignment_rubric_parts" FOR SELECT TO "authenticated" USING (
    -- Allow class graders (instructors and TAs) to view rubric parts for their classes
  authorizeforclassgrader(class_id)
  OR
  (EXISTS ( SELECT 1
   FROM "public"."review_assignments" "ra"
  WHERE (("ra"."id" = "review_assignment_rubric_parts"."review_assignment_id") AND ("ra"."assignee_profile_id" = ( SELECT "user_roles"."private_profile_id"
           FROM "public"."user_roles"
          WHERE (("user_roles"."user_id" = "auth"."uid"()) AND ("user_roles"."class_id" = "review_assignment_rubric_parts"."class_id"))))))));

-- ========================================
-- Optimize discussion thread read status realtime notifications
-- ========================================

-- Problem: When a new discussion thread is created, the trigger creates read status records 
-- for ALL users in the class, which sends INSERT realtime notifications to everyone.
-- Solution: Keep read status creation but modify the read status trigger to not broadcast INSERTs.

-- Modify the read status broadcast trigger to only broadcast on UPDATE and DELETE, not INSERT
-- This eliminates the flood of INSERT notifications when new threads are created
DROP TRIGGER IF EXISTS "broadcast_discussion_thread_read_status_realtime" ON "public"."discussion_thread_read_status";

CREATE TRIGGER "broadcast_discussion_thread_read_status_realtime"
  AFTER UPDATE OR DELETE
  ON "public"."discussion_thread_read_status"
  FOR EACH ROW
  EXECUTE FUNCTION "public"."broadcast_discussion_thread_read_status_unified"();

-- Add comment explaining the optimization
COMMENT ON TRIGGER "broadcast_discussion_thread_read_status_realtime" ON "public"."discussion_thread_read_status" IS 
'Optimized trigger that only broadcasts UPDATE and DELETE operations, not INSERT. This eliminates unnecessary realtime notifications when new discussion threads create read status records for all users in the class.';

-- Mark as read for author, unread for others
CREATE OR REPLACE FUNCTION "public"."discussion_threads_notification"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
   body jsonb;
   subject jsonb;
   style text;
   root_subject text;
   reply_author_name text;
   current_user_id uuid;
BEGIN
   -- Set explicit search_path to harden SECURITY DEFINER
   SET search_path = public;
   CASE TG_OP
   WHEN 'INSERT' THEN
    -- Set root to its own ID if there is no root specified
      if NEW.root is null then
         update discussion_threads set root = id where id = NEW.id;
         NEW.root = NEW.id;
         root_subject = NEW.subject;
      else
        SELECT discussion_threads.subject from discussion_threads into root_subject WHERE id=NEW.root; 
      END if;
      SELECT name into reply_author_name from profiles where id=NEW.author; 

   -- Get current user ID, handling null case
      current_user_id := auth.uid();

   -- TODO: make this work for "draft" (ignore trigger on insert, catch on update)
      body := jsonb_build_object(
         'type', 'discussion_thread',
         'action', 'reply',
         'new_comment_number',NEW.ordinal,
         'new_comment_id',NEW.id,
         'root_thread_id',NEW.root,
         'reply_author_profile_id',NEW.author,
         'teaser', left(NEW.body, 40),
         'thread_name',root_subject,
         'reply_author_name',reply_author_name
      );
      subject := '{}';
      style := 'info';
      
      -- Only send notifications if we have a current user
      if current_user_id is not null then
        INSERT INTO notifications (class_id, subject, body, style, user_id)
          SELECT NEW.class_id, subject, body, style, user_id FROM discussion_thread_watchers
            WHERE discussion_thread_root_id = NEW.root and enabled=true and user_id!=current_user_id;
      end if;

   -- Set watch if there is not one already and we have a current user
      if current_user_id is not null then
        INSERT INTO discussion_thread_watchers (class_id, discussion_thread_root_id, user_id, enabled) 
        VALUES (NEW.class_id, NEW.root, current_user_id, true)
        ON CONFLICT (user_id, discussion_thread_root_id) DO NOTHING;
      end if;

      -- Mark as unread for everyone in the class, excluding the current user if one exists
      if current_user_id is not null then
        INSERT INTO discussion_thread_read_status (user_id,discussion_thread_id,discussion_thread_root_id) 
        select user_id, NEW.id as discussion_thread_id, NEW.root as discussion_thread_root_id 
        from user_roles 
        where class_id=NEW.class_id and user_id != current_user_id;

        INSERT INTO discussion_thread_read_status (user_id,discussion_thread_id,discussion_thread_root_id,read_at) 
        select user_id, NEW.id as discussion_thread_id, NEW.root as discussion_thread_root_id, NEW.created_at as read_at
        from user_roles 
        where class_id=NEW.class_id and user_id = current_user_id;
      else
        -- If no current user (seeding context), mark as unread for all users in the class
        INSERT INTO discussion_thread_read_status (user_id,discussion_thread_id,discussion_thread_root_id) 
        select user_id, NEW.id as discussion_thread_id, NEW.root as discussion_thread_root_id 
        from user_roles 
        where class_id=NEW.class_id;
      end if;
      
   ELSE
      RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
   END CASE;
   
   RETURN NEW;
END
$$;