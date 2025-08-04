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