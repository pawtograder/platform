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