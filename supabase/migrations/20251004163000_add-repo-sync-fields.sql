-- Migration to add fields for tracking handout sync status
-- Adds desired_handout_sha and sync_data fields to repositories table

-- Add comment to the synced_handout_sha column to document its purpose
COMMENT ON COLUMN public.repositories.synced_handout_sha IS 
'The SHA of the last template repository commit that was synced to this student repository. 
Used by the PushChangesToRepoFromHandout script to determine what changes need to be pushed.';

-- Add comment to the latest_template_sha column
COMMENT ON COLUMN public.assignments.latest_template_sha IS 
'The SHA of the most recent commit in the template repository. 
Updated automatically when the template repo receives a push via webhook.
Used to determine if student repositories need to be updated.';


-- Add desired_handout_sha field to track what SHA instructors want to sync to
ALTER TABLE public.repositories
ADD COLUMN IF NOT EXISTS desired_handout_sha text;

-- Add sync_data field to track PR information and sync status
ALTER TABLE public.repositories
ADD COLUMN IF NOT EXISTS sync_data jsonb DEFAULT '{}'::jsonb;

-- Add updated_at column for realtime optimization (if not exists)
ALTER TABLE public.repositories
ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Create trigger to automatically update updated_at on changes
DROP TRIGGER IF EXISTS set_updated_at_on_repositories ON public.repositories;
CREATE TRIGGER set_updated_at_on_repositories 
    BEFORE UPDATE ON public.repositories 
    FOR EACH ROW 
    EXECUTE FUNCTION public.set_updated_at();

-- Add comments to document the fields
COMMENT ON COLUMN public.repositories.desired_handout_sha IS 
'The SHA of the template repository commit that instructors want to sync to this repo. 
When this differs from synced_handout_sha, a sync is needed.';

COMMENT ON COLUMN public.repositories.sync_data IS 
'JSON data tracking the current sync operation:
{
  "pr_number": 123,
  "pr_url": "https://github.com/org/repo/pull/123",
  "pr_state": "open" | "closed" | "merged",
  "branch_name": "sync-to-abc1234",
  "last_sync_attempt": "2024-01-01T00:00:00Z",
  "last_sync_error": "error message if failed"
}';

-- Create an index on desired_handout_sha for filtering repos that need sync
CREATE INDEX IF NOT EXISTS idx_repositories_desired_handout_sha 
ON public.repositories(desired_handout_sha) 
WHERE desired_handout_sha IS NOT NULL;

-- Create RPC function to queue repository syncs
CREATE OR REPLACE FUNCTION public.queue_repository_syncs(
    p_repository_ids bigint[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_class_id bigint;
    v_repo_record RECORD;
    v_queued_count integer := 0;
    v_skipped_count integer := 0;
    v_error_count integer := 0;
    v_errors jsonb[] := '{}';
BEGIN
    -- Check if user is authenticated
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;
    
    -- Verify all repositories belong to the same class and user has instructor access
    SELECT DISTINCT r.class_id INTO v_class_id
    FROM public.repositories r
    WHERE r.id = ANY(p_repository_ids);
    
    IF v_class_id IS NULL THEN
        RAISE EXCEPTION 'No repositories found with provided IDs';
    END IF;
    
    -- Check for multiple classes (not allowed)
    IF (SELECT COUNT(DISTINCT r.class_id) 
        FROM public.repositories r 
        WHERE r.id = ANY(p_repository_ids)) > 1 THEN
        RAISE EXCEPTION 'All repositories must belong to the same class';
    END IF;
    
    -- Verify user is an instructor for this class
    IF NOT public.authorizeforclassinstructor(v_class_id) THEN
        RAISE EXCEPTION 'Only instructors can queue repository syncs';
    END IF;
    
    -- Queue sync for each repository
    FOR v_repo_record IN
        SELECT 
            r.id,
            r.repository,
            r.synced_handout_sha,
            r.desired_handout_sha,
            r.class_id,
            a.id as assignment_id,
            a.template_repo,
            a.latest_template_sha,
            a.title as assignment_title
        FROM public.repositories r
        JOIN public.assignments a ON r.assignment_id = a.id
        WHERE r.id = ANY(p_repository_ids)
          AND a.template_repo IS NOT NULL
          AND a.template_repo != ''
          AND a.latest_template_sha IS NOT NULL
          AND r.is_github_ready = true
    LOOP
        BEGIN
            -- Set desired_handout_sha to latest_template_sha if not already set
            IF v_repo_record.desired_handout_sha IS NULL OR 
               v_repo_record.desired_handout_sha != v_repo_record.latest_template_sha THEN
                
                -- Update desired_handout_sha
                UPDATE public.repositories
                SET desired_handout_sha = v_repo_record.latest_template_sha
                WHERE id = v_repo_record.id;
                
                -- Queue the sync job
                PERFORM pgmq_public.send(
                    'async_calls',
                    jsonb_build_object(
                        'method', 'sync_repo_to_handout',
                        'args', jsonb_build_object(
                            'repository_id', v_repo_record.id,
                            'repository_full_name', v_repo_record.repository,
                            'template_repo', v_repo_record.template_repo,
                            'from_sha', v_repo_record.synced_handout_sha,
                            'to_sha', v_repo_record.latest_template_sha,
                            'assignment_title', v_repo_record.assignment_title
                        ),
                        'class_id', v_repo_record.class_id,
                        'repo_id', v_repo_record.id
                    )
                );
                
                v_queued_count := v_queued_count + 1;
            ELSE
                v_skipped_count := v_skipped_count + 1;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            v_error_count := v_error_count + 1;
            v_errors := array_append(v_errors, jsonb_build_object(
                'repository_id', v_repo_record.id,
                'repository', v_repo_record.repository,
                'error', SQLERRM
            ));
        END;
    END LOOP;
    
    RETURN jsonb_build_object(
        'success', true,
        'queued_count', v_queued_count,
        'skipped_count', v_skipped_count,
        'error_count', v_error_count,
        'errors', v_errors
    );
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION public.queue_repository_syncs(bigint[]) TO authenticated;

-- Add comment
COMMENT ON FUNCTION public.queue_repository_syncs IS 
'Queue sync jobs for the specified repositories to their latest template commit.
Only instructors can call this function.
Repositories that already have the latest template SHA synced will be skipped.
Returns a summary of queued, skipped, and error counts.';

-- Create broadcast function for repositories (ID-only for efficiency)
CREATE OR REPLACE FUNCTION public.broadcast_repositories_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    target_class_id bigint;
    staff_payload jsonb;
BEGIN
    -- Get the class_id from the record
    IF TG_OP = 'INSERT' THEN
        target_class_id := NEW.class_id;
    ELSIF TG_OP = 'UPDATE' THEN
        target_class_id := COALESCE(NEW.class_id, OLD.class_id);
    ELSIF TG_OP = 'DELETE' THEN
        target_class_id := OLD.class_id;
    END IF;

    IF target_class_id IS NOT NULL THEN
        -- Create lightweight payload with ID only (not full data)
        staff_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', CASE
                WHEN TG_OP = 'DELETE' THEN OLD.id
                ELSE NEW.id
            END,
            'class_id', target_class_id,
            'timestamp', NOW()
        );

        -- Use safe_broadcast if available, otherwise use realtime.send directly
        IF public.channel_has_subscribers('class:' || target_class_id || ':staff') THEN
            PERFORM realtime.send(
                staff_payload,
                'broadcast',
                'class:' || target_class_id || ':staff',
                true
            );
        END IF;
    END IF;

    -- Return the appropriate record
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$;

-- Drop existing trigger if it exists to ensure clean creation
DROP TRIGGER IF EXISTS broadcast_repositories_change ON public.repositories;

-- Create trigger for repositories table
CREATE TRIGGER broadcast_repositories_change
    AFTER INSERT OR UPDATE OR DELETE ON public.repositories
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_repositories_change();

-- Add comment
COMMENT ON FUNCTION public.broadcast_repositories_change IS 
'Broadcast lightweight notifications (ID only, no data) to class staff channel when repositories change.
This enables real-time UI updates for sync status without sending full row data.';
