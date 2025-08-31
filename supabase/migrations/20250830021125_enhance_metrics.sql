-- Enhanced metrics function with comprehensive system usage tracking
-- This migration updates the get_all_class_metrics function to include additional metrics
-- for better system monitoring, usage tracking, and issue detection
-- This migration is idempotent and can be re-applied safely

-- Drop existing function to ensure clean recreation
DROP FUNCTION IF EXISTS "public"."get_all_class_metrics"();

CREATE OR REPLACE FUNCTION "public"."get_all_class_metrics"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
DECLARE
  result jsonb := '[]'::jsonb;
  class_record record;
  class_metrics jsonb;
BEGIN
  -- Only allow service_role to call this function
  IF auth.role() != 'service_role' THEN
    RAISE EXCEPTION 'Access denied: function only available to service_role';
  END IF;

  -- Loop through all active (non-archived) classes
  FOR class_record IN 
    SELECT id, name, slug FROM "public"."classes" WHERE archived = false
  LOOP
    -- Build comprehensive metrics JSON for this class
    SELECT jsonb_build_object(
      'class_id', class_record.id,
      'class_name', class_record.name,
      'class_slug', class_record.slug,
      
      -- === WORKFLOW METRICS ===
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
      'workflow_errors_total', (
        SELECT COUNT(*) FROM "public"."workflow_run_error" 
        WHERE class_id = class_record.id
      ),
      'workflow_runs_timeout', (
        SELECT COUNT(*) FROM "public"."workflow_events_summary" 
        WHERE class_id = class_record.id 
          AND requested_at IS NOT NULL 
          AND completed_at IS NULL 
          AND in_progress_at IS NULL
          AND requested_at < (NOW() - INTERVAL '30 minutes')
      ),
      
      -- === WORKFLOW PERFORMANCE METRICS ===
      'workflow_avg_queue_time_seconds', (
        SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (in_progress_at - requested_at))), 0)
        FROM "public"."workflow_events_summary" 
        WHERE class_id = class_record.id 
          AND requested_at IS NOT NULL 
          AND in_progress_at IS NOT NULL
      ),
      'workflow_avg_run_time_seconds', (
        SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (completed_at - in_progress_at))), 0)
        FROM "public"."workflow_events_summary" 
        WHERE class_id = class_record.id 
          AND in_progress_at IS NOT NULL 
          AND completed_at IS NOT NULL
      ),
      
      -- === USER ENGAGEMENT METRICS ===
      'active_students_total', (
        SELECT COUNT(*) FROM "public"."user_roles" ur 
        WHERE ur.class_id = class_record.id::integer 
          AND ur.role = 'student'
      ),
      'active_instructors_total', (
        SELECT COUNT(*) FROM "public"."user_roles" ur
        WHERE ur.class_id = class_record.id::integer 
          AND ur.role = 'instructor'
      ),
      'active_graders_total', (
        SELECT COUNT(*) FROM "public"."user_roles" ur
        WHERE ur.class_id = class_record.id::integer 
          AND ur.role = 'grader'
      ),
      'students_active_7d', (
        SELECT COUNT(DISTINCT ur.private_profile_id) 
        FROM "public"."user_roles" ur
        WHERE ur.class_id = class_record.id::integer 
          AND ur.role = 'student'
          AND (
            EXISTS (SELECT 1 FROM "public"."submissions" s WHERE s.profile_id = ur.private_profile_id AND s.created_at >= (NOW() - INTERVAL '7 days'))
            OR EXISTS (SELECT 1 FROM "public"."discussion_threads" dt WHERE dt.author = ur.private_profile_id AND dt.created_at >= (NOW() - INTERVAL '7 days'))
            OR EXISTS (SELECT 1 FROM "public"."help_requests" hr WHERE hr.created_by = ur.private_profile_id AND hr.created_at >= (NOW() - INTERVAL '7 days'))
          )
      ),
      'students_active_24h', (
        SELECT COUNT(DISTINCT ur.private_profile_id) 
        FROM "public"."user_roles" ur
        WHERE ur.class_id = class_record.id::integer 
          AND ur.role = 'student'
          AND (
            EXISTS (SELECT 1 FROM "public"."submissions" s WHERE s.profile_id = ur.private_profile_id AND s.created_at >= (NOW() - INTERVAL '24 hours'))
            OR EXISTS (SELECT 1 FROM "public"."discussion_threads" dt WHERE dt.author = ur.private_profile_id AND dt.created_at >= (NOW() - INTERVAL '24 hours'))
            OR EXISTS (SELECT 1 FROM "public"."help_requests" hr WHERE hr.created_by = ur.private_profile_id AND hr.created_at >= (NOW() - INTERVAL '24 hours'))
          )
      ),
      
      -- === ASSIGNMENT METRICS ===
      'assignments_total', (
        SELECT COUNT(*) FROM "public"."assignments" 
        WHERE class_id = class_record.id AND archived_at IS NULL
      ),
      'assignments_active', (
        SELECT COUNT(*) FROM "public"."assignments" 
        WHERE class_id = class_record.id 
          AND archived_at IS NULL
          AND release_date <= NOW() 
          AND due_date > NOW()
      ),
      
      -- === SUBMISSION METRICS ===
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
      'submissions_graded', (
        SELECT COUNT(DISTINCT s.id) FROM "public"."submissions" s
        INNER JOIN "public"."submission_reviews" sr ON sr.submission_id = s.id
        WHERE s.class_id = class_record.id 
          AND s.is_active = true
          AND sr.completed_at IS NOT NULL
      ),
      'submissions_pending_grading', (
        SELECT COUNT(*) FROM "public"."submissions" s
        WHERE s.class_id = class_record.id 
          AND s.is_active = true
          AND NOT EXISTS (
            SELECT 1 FROM "public"."submission_reviews" sr 
            WHERE sr.submission_id = s.id AND sr.completed_at IS NOT NULL
          )
      ),
      
      -- === GRADING METRICS ===
      'submission_reviews_total', (
        SELECT COUNT(*) FROM "public"."submission_reviews" 
        WHERE class_id = class_record.id AND completed_at IS NOT NULL
      ),
      'submission_reviews_recent_7d', (
        SELECT COUNT(*) FROM "public"."submission_reviews" 
        WHERE class_id = class_record.id 
          AND completed_at IS NOT NULL
          AND completed_at >= (NOW() - INTERVAL '7 days')
      ),
      'avg_grading_turnaround_hours', (
        SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (sr.completed_at - s.created_at)) / 3600), 0)
        FROM "public"."submission_reviews" sr
        INNER JOIN "public"."submissions" s ON s.id = sr.submission_id
        WHERE sr.class_id = class_record.id 
          AND sr.completed_at IS NOT NULL
          AND s.created_at >= (NOW() - INTERVAL '30 days')
      ),
      
      -- === COMMENT METRICS ===
      'submission_comments_total', (
        SELECT (
          COALESCE((SELECT COUNT(*) FROM "public"."submission_comments" WHERE class_id = class_record.id), 0) +
          COALESCE((SELECT COUNT(*) FROM "public"."submission_artifact_comments" WHERE class_id = class_record.id), 0) +
          COALESCE((SELECT COUNT(*) FROM "public"."submission_file_comments" WHERE class_id = class_record.id), 0) +
          COALESCE((SELECT COUNT(*) FROM "public"."submission_regrade_request_comments" WHERE class_id = class_record.id), 0)
        )
      ),
      
      -- === REGRADE REQUEST METRICS ===
      'regrade_requests_total', (
        SELECT COUNT(*) FROM "public"."submission_regrade_requests" 
        WHERE class_id = class_record.id
      ),
      'regrade_requests_recent_7d', (
        SELECT COUNT(*) FROM "public"."submission_regrade_requests" 
        WHERE class_id = class_record.id 
          AND created_at >= (NOW() - INTERVAL '7 days')
      ),
      
      -- === DISCUSSION METRICS ===
      'discussion_threads_total', (
        SELECT COUNT(*) FROM "public"."discussion_threads" 
        WHERE class_id = class_record.id
      ),
      'discussion_posts_recent_7d', (
        SELECT COUNT(*) FROM "public"."discussion_threads" 
        WHERE class_id = class_record.id 
          AND created_at >= (NOW() - INTERVAL '7 days')
      ),
      
      -- === HELP REQUEST METRICS ===
      'help_requests_total', (
        SELECT COUNT(*) FROM "public"."help_requests" 
        WHERE class_id = class_record.id
      ),
      'help_requests_open', (
        SELECT COUNT(*) FROM "public"."help_requests" 
        WHERE class_id = class_record.id AND status = 'open'
      ),
      'help_requests_resolved_24h', (
        SELECT COUNT(*) FROM "public"."help_requests" 
        WHERE class_id = class_record.id 
          AND status = 'resolved'
          AND resolved_at >= (NOW() - INTERVAL '24 hours')
      ),
      'help_requests_avg_resolution_minutes', (
        SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 60), 0)
        FROM "public"."help_requests" 
        WHERE class_id = class_record.id 
          AND status = 'resolved'
          AND resolved_at IS NOT NULL
          AND created_at >= (NOW() - INTERVAL '30 days')
      ),
      'help_request_messages_total', (
        SELECT COUNT(*) FROM "public"."help_request_messages" 
        WHERE class_id = class_record.id
      ),
      
      -- === NOTIFICATION METRICS ===
      'notifications_unread', (
        SELECT COUNT(*) FROM "public"."notifications" 
        WHERE class_id = class_record.id AND viewed_at IS NULL
      ),
      
      -- === SYSTEM COMPLEXITY METRICS ===
      'gradebook_columns_total', (
        SELECT COUNT(*) FROM "public"."gradebook_columns" 
        WHERE class_id = class_record.id
      ),
      
      -- === LATE TOKEN USAGE METRICS ===
      'late_token_usage_total', (
        SELECT COALESCE(SUM(tokens_consumed), 0) 
        FROM "public"."assignment_due_date_exceptions" adde
        INNER JOIN "public"."assignments" a ON a.id = adde.assignment_id
        WHERE a.class_id = class_record.id
      ),
      'late_tokens_per_student_limit', (
        SELECT late_tokens_per_student FROM "public"."classes" 
        WHERE id = class_record.id
      ),
      
      -- === VIDEO MEETING METRICS ===
      'video_meeting_sessions_total', (
        SELECT COUNT(*) FROM "public"."video_meeting_sessions" 
        WHERE class_id = class_record.id
      ),
      'video_meeting_sessions_recent_7d', (
        SELECT COUNT(*) FROM "public"."video_meeting_sessions" 
        WHERE class_id = class_record.id 
          AND started >= (NOW() - INTERVAL '7 days')
      ),
      'video_meeting_participants_total', (
        SELECT COUNT(*) FROM "public"."video_meeting_session_users" 
        WHERE class_id = class_record.id
      ),
      'video_meeting_participants_recent_7d', (
        SELECT COUNT(*) FROM "public"."video_meeting_session_users" 
        WHERE class_id = class_record.id 
          AND joined_at >= (NOW() - INTERVAL '7 days')
      ),
      'video_meeting_avg_duration_minutes', (
        SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (ended - started)) / 60), 0)
        FROM "public"."video_meeting_sessions" 
        WHERE class_id = class_record.id 
          AND started IS NOT NULL 
          AND ended IS NOT NULL
          AND started >= (NOW() - INTERVAL '30 days')
      ),
      'video_meeting_unique_users_7d', (
        SELECT COUNT(DISTINCT private_profile_id) 
        FROM "public"."video_meeting_session_users" 
        WHERE class_id = class_record.id 
          AND joined_at >= (NOW() - INTERVAL '7 days')
      ),
      
      -- === SIS SYNC ERROR METRICS ===
      'sis_sync_errors_recent', (
        SELECT COUNT(*) FROM "public"."sis_sync_status" 
        WHERE course_id = class_record.id 
          AND sync_enabled = true 
          AND last_sync_status = 'error'
      )
      
    ) INTO class_metrics;
    
    -- Add this class's metrics to the result array
    result := result || jsonb_build_array(class_metrics);
  END LOOP;

  RETURN result;
END;
$$;

-- Update function ownership and permissions
ALTER FUNCTION "public"."get_all_class_metrics"() OWNER TO "postgres";

-- Ensure only service_role can execute this function
REVOKE ALL ON FUNCTION "public"."get_all_class_metrics"() FROM "authenticated";
REVOKE ALL ON FUNCTION "public"."get_all_class_metrics"() FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."get_all_class_metrics"() TO "service_role";

-- Drop existing table and related objects if they exist (for idempotent re-application)
DROP TABLE IF EXISTS "public"."video_meeting_session_users" CASCADE;

-- Create table for tracking video meeting session user participation
CREATE TABLE IF NOT EXISTS "public"."video_meeting_session_users" (
    "id" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "private_profile_id" "uuid" NOT NULL,
    "class_id" bigint NOT NULL,
    "video_meeting_session_id" bigint NOT NULL,
    "joined_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "left_at" timestamp with time zone,
    "chime_attendee_id" text,
    CONSTRAINT "video_meeting_session_users_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "video_meeting_session_users_video_meeting_session_id_fkey" FOREIGN KEY ("video_meeting_session_id") REFERENCES "public"."video_meeting_sessions"("id") ON DELETE CASCADE,
    CONSTRAINT "video_meeting_session_users_private_profile_id_fkey" FOREIGN KEY ("private_profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE,
    CONSTRAINT "video_meeting_session_users_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE CASCADE
);

-- Create indexes for efficient querying (will be recreated since table was dropped)
CREATE INDEX "video_meeting_session_users_video_meeting_session_id_idx" ON "public"."video_meeting_session_users" USING btree ("video_meeting_session_id");
CREATE INDEX "video_meeting_session_users_private_profile_id_idx" ON "public"."video_meeting_session_users" USING btree ("private_profile_id");
CREATE INDEX "video_meeting_session_users_class_id_idx" ON "public"."video_meeting_session_users" USING btree ("class_id");
CREATE INDEX "video_meeting_session_users_joined_at_idx" ON "public"."video_meeting_session_users" USING btree ("joined_at");
CREATE INDEX "video_meeting_session_users_chime_attendee_id_idx" ON "public"."video_meeting_session_users" USING btree ("chime_attendee_id");

-- Create unique index to prevent duplicate entries for the same attendee in the same session
CREATE UNIQUE INDEX "video_meeting_session_users_session_attendee_unique_idx" ON "public"."video_meeting_session_users" USING btree ("video_meeting_session_id", "chime_attendee_id");

-- Create composite index for efficient metrics queries filtering by class_id and joined_at
CREATE INDEX "video_meeting_session_users_class_id_joined_at_idx" ON "public"."video_meeting_session_users" USING btree ("class_id", "joined_at");

-- Create unique partial index to prevent multiple concurrent active joins per user-session
CREATE UNIQUE INDEX "video_meeting_session_users_session_profile_active_unique_idx" ON "public"."video_meeting_session_users" USING btree ("video_meeting_session_id", "private_profile_id") WHERE "left_at" IS NULL;

-- Set table ownership
ALTER TABLE "public"."video_meeting_session_users" OWNER TO "postgres";

-- Enable RLS
ALTER TABLE "public"."video_meeting_session_users" ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist (for idempotent re-application)
DROP POLICY IF EXISTS "Users can view their own video meeting participation" ON "public"."video_meeting_session_users";
DROP POLICY IF EXISTS "System can insert video meeting participation records" ON "public"."video_meeting_session_users";
DROP POLICY IF EXISTS "System can update video meeting participation records" ON "public"."video_meeting_session_users";

-- Create RLS policies
CREATE POLICY "System can insert video meeting participation records" ON "public"."video_meeting_session_users"
    FOR INSERT WITH CHECK (auth.role() = 'service_role');


CREATE POLICY "System can update video meeting participation records" ON "public"."video_meeting_session_users"
    FOR UPDATE USING (auth.role() = 'service_role');

-- Grant permissions
REVOKE ALL ON TABLE "public"."video_meeting_session_users" FROM "anon";
GRANT ALL ON TABLE "public"."video_meeting_session_users" TO "authenticated";
GRANT ALL ON TABLE "public"."video_meeting_session_users" TO "service_role";

REVOKE ALL ON SEQUENCE "public"."video_meeting_session_users_id_seq" FROM "anon","authenticated";
GRANT ALL ON SEQUENCE "public"."video_meeting_session_users_id_seq" TO "service_role";
