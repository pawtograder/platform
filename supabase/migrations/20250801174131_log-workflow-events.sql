-- Create table to log GitHub workflow events
CREATE TABLE IF NOT EXISTS "workflow_events" (
    "id" BIGSERIAL PRIMARY KEY,
    "workflow_run_id" BIGINT NOT NULL,
    "repository_name" TEXT NOT NULL,
    "github_repository_id" BIGINT,
    "repository_id" BIGINT REFERENCES "repositories"("id"),
    "class_id" BIGINT REFERENCES "classes"("id"),
    "workflow_name" TEXT,
    "workflow_path" TEXT,
    "event_type" TEXT NOT NULL CHECK (event_type IN ('requested', 'in_progress', 'completed', 'cancelled')),
    "status" TEXT,
    "conclusion" TEXT,
    "head_sha" TEXT,
    "head_branch" TEXT,
    "run_number" INTEGER,
    "run_attempt" INTEGER,
    "actor_login" TEXT,
    "triggering_actor_login" TEXT,
    "created_at" TIMESTAMPTZ DEFAULT NOW(),
    "started_at" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ,
    "run_started_at" TIMESTAMPTZ,
    "run_updated_at" TIMESTAMPTZ,
    "pull_requests" JSONB,
    "payload" JSONB
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS "idx_workflow_events_workflow_run_id" ON "workflow_events" ("workflow_run_id");
CREATE INDEX IF NOT EXISTS "idx_workflow_events_repository_name" ON "workflow_events" ("repository_name");
CREATE INDEX IF NOT EXISTS "idx_workflow_events_repository_id" ON "workflow_events" ("repository_id");
CREATE INDEX IF NOT EXISTS "idx_workflow_events_class_id" ON "workflow_events" ("class_id");
CREATE INDEX IF NOT EXISTS "idx_workflow_events_event_type" ON "workflow_events" ("event_type");
CREATE INDEX IF NOT EXISTS "idx_workflow_events_head_sha" ON "workflow_events" ("head_sha");
CREATE INDEX IF NOT EXISTS "idx_workflow_events_created_at" ON "workflow_events" ("created_at");
CREATE INDEX IF NOT EXISTS "idx_workflow_events_status" ON "workflow_events" ("status");

-- Add RLS policies
ALTER TABLE "workflow_events" ENABLE ROW LEVEL SECURITY;

-- Allow service role to manage all workflow events
CREATE POLICY "workflow_events_service_role_all" ON "workflow_events"
    FOR ALL USING (auth.role() = 'service_role');

-- Allow authenticated users to read workflow events (you may want to restrict this further based on your needs)
CREATE POLICY "workflow_events_authenticated_read" ON "workflow_events"
    FOR SELECT USING (auth.role() = 'authenticated');

-- Allow instructors to read workflow events for their classes when class_id is not null
CREATE POLICY "workflow_events_instructor_read" ON "workflow_events"
    FOR SELECT USING (
        auth.role() = 'authenticated' 
        AND class_id IS NOT NULL 
        AND authorizeforclassinstructor(class_id)
    );

-- Create view that pivots workflow events by workflow_run_id and event_type

CREATE OR REPLACE VIEW "workflow_events_summary" 
WITH (security_invoker='true') 
AS
SELECT 
    workflow_run_id,
    we.class_id,
    workflow_name,
    workflow_path,
    head_sha,
    head_branch,
    run_number,
    run_attempt,
    actor_login,
    triggering_actor_login,
    r.assignment_id,
    r.profile_id,
    -- Pivot columns for event types
    MAX(CASE WHEN event_type = 'requested' THEN updated_at END) AS requested_at,
    MAX(CASE WHEN event_type = 'in_progress' THEN updated_at END) AS in_progress_at,
    MAX(CASE WHEN event_type = 'completed' THEN updated_at END) AS completed_at,
    -- Calculated time columns
    CASE 
      WHEN MAX(CASE WHEN event_type = 'requested' THEN updated_at END) IS NOT NULL 
           AND MAX(CASE WHEN event_type = 'in_progress' THEN updated_at END) IS NOT NULL
      THEN EXTRACT(EPOCH FROM (MAX(CASE WHEN event_type = 'in_progress' THEN updated_at END) - MAX(CASE WHEN event_type = 'requested' THEN updated_at END)))
      ELSE NULL
    END AS queue_time_seconds,
    CASE 
      WHEN MAX(CASE WHEN event_type = 'in_progress' THEN updated_at END) IS NOT NULL 
           AND MAX(CASE WHEN event_type = 'completed' THEN updated_at END) IS NOT NULL
      THEN EXTRACT(EPOCH FROM (MAX(CASE WHEN event_type = 'completed' THEN updated_at END) - MAX(CASE WHEN event_type = 'in_progress' THEN updated_at END)))
      ELSE NULL
    END AS run_time_seconds
FROM workflow_events we
INNER JOIN repositories r ON we.repository_id = r.id
GROUP BY 
    workflow_run_id,
    run_attempt,
    we.class_id,
    workflow_name,
    workflow_path,
    head_sha,
    head_branch,
    run_number,
    run_attempt,
    actor_login,
    triggering_actor_login,
    r.assignment_id,
    r.profile_id;

    -- Drop existing table if it exists (to flatten migrations)
DROP TABLE IF EXISTS "public"."workflow_run_error" CASCADE;

-- Create workflow_run_error table to track errors during workflow execution
-- This table stores workflow information directly without foreign key dependencies
CREATE TABLE "public"."workflow_run_error" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "created_at" TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    
    -- Core identifiers
    "submission_id" BIGINT,
    "class_id" BIGINT NOT NULL,
    "repository_id" BIGINT NOT NULL,
    "autograder_regression_test_id" BIGINT,
    
    -- Workflow run information
    "run_number" BIGINT,
    "run_attempt" INTEGER,
    
    -- Error details
    "name" TEXT NOT NULL,
    "data" JSONB,
    "is_private" BOOLEAN NOT NULL DEFAULT false
);

-- Create indexes for efficient querying
CREATE INDEX "idx_workflow_run_error_submission_id" ON "public"."workflow_run_error" ("submission_id");
CREATE INDEX "idx_workflow_run_error_class_id" ON "public"."workflow_run_error" ("class_id");
CREATE INDEX "idx_workflow_run_error_repository_id" ON "public"."workflow_run_error" ("repository_id");
CREATE INDEX "idx_workflow_run_error_created_at" ON "public"."workflow_run_error" ("created_at");
CREATE INDEX "idx_workflow_run_error_is_private" ON "public"."workflow_run_error" ("is_private");
CREATE INDEX "idx_workflow_run_error_autograder_regression_test_id" ON "public"."workflow_run_error" ("autograder_regression_test_id");

-- Create composite index for common query patterns
CREATE INDEX "idx_workflow_run_error_class_submission" ON "public"."workflow_run_error" ("class_id", "submission_id");
CREATE INDEX "idx_workflow_run_error_class_repository" ON "public"."workflow_run_error" ("class_id", "repository_id");

-- Add foreign key constraints
ALTER TABLE "public"."workflow_run_error"
    ADD CONSTRAINT "workflow_run_error_submission_id_fkey"
    FOREIGN KEY ("submission_id")
    REFERENCES "public"."submissions"("id")
    ON DELETE CASCADE;

ALTER TABLE "public"."workflow_run_error"
    ADD CONSTRAINT "workflow_run_error_class_id_fkey"
    FOREIGN KEY ("class_id")
    REFERENCES "public"."classes"("id")
    ON DELETE CASCADE;

ALTER TABLE "public"."workflow_run_error"
    ADD CONSTRAINT "workflow_run_error_repository_id_fkey"
    FOREIGN KEY ("repository_id")
    REFERENCES "public"."repositories"("id")
    ON DELETE CASCADE;

ALTER TABLE "public"."workflow_run_error"
    ADD CONSTRAINT "workflow_run_error_autograder_regression_test_id_fkey"
    FOREIGN KEY ("autograder_regression_test_id")
    REFERENCES "public"."autograder_regression_test"("id")
    ON DELETE CASCADE;

-- Add length constraint for error name
ALTER TABLE "public"."workflow_run_error"
    ADD CONSTRAINT "workflow_run_error_name_length"
    CHECK (length("name") >= 1 AND length("name") <= 500);

-- Enable Row Level Security
ALTER TABLE "public"."workflow_run_error" ENABLE ROW LEVEL SECURITY;

-- Create RLS policies
-- Allow service role to manage all workflow run errors
CREATE POLICY "workflow_run_error_service_role_all" ON "public"."workflow_run_error"
    FOR ALL USING (auth.role() = 'service_role');

-- Allow select if user is authorized as class grader OR error is not private and user is authorized for the submission
CREATE POLICY "workflow_run_error_select" ON "public"."workflow_run_error"
    FOR SELECT USING (
        auth.role() = 'authenticated'
        AND (
            authorizeforclassgrader("class_id")
            OR (
                NOT "is_private"
                AND "submission_id" IS NOT NULL
                AND authorize_for_submission("submission_id")
            )
        )
    );

-- Grant permissions to roles
GRANT ALL ON TABLE "public"."workflow_run_error" TO "anon";
GRANT ALL ON TABLE "public"."workflow_run_error" TO "authenticated";
GRANT ALL ON TABLE "public"."workflow_run_error" TO "service_role";

-- Create function to validate assignment slug
CREATE OR REPLACE FUNCTION validate_assignment_slug()
RETURNS TRIGGER AS $$
BEGIN
    -- Check if slug is 'handout' or 'solution' (case insensitive)
    IF LOWER(NEW.slug) IN ('handout', 'solution') THEN
        RAISE EXCEPTION 'Assignment slug cannot be "handout" or "solution". These are reserved slugs used for repository creation.'
            USING ERRCODE = 'check_violation';
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to validate assignment slug before insert
CREATE TRIGGER trigger_validate_assignment_slug
    BEFORE INSERT ON "public"."assignments"
    FOR EACH ROW
    EXECUTE FUNCTION validate_assignment_slug();