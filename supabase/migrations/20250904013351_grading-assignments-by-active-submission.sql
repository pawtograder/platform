-- Migration: Update grading review assignments when submission is_active changes from true to false
-- This ensures that review assignments always point to the currently active submission

-- Create the trigger function
CREATE OR REPLACE FUNCTION "public"."update_review_assignments_on_submission_deactivation"()
RETURNS "trigger"
LANGUAGE "plpgsql" SECURITY DEFINER
SET search_path TO public,pg_temp
AS $$
DECLARE
    new_active_submission_id bigint;
    updated_count integer;
BEGIN
    -- Only proceed if is_active changed from true to false
    IF OLD.is_active = true AND NEW.is_active = false THEN
        
        -- Find the new active submission for the same assignment and student/group
        IF OLD.assignment_group_id IS NOT NULL THEN
            -- Group submission: find active submission for the same assignment_group_id
            SELECT id INTO new_active_submission_id
            FROM public.submissions
            WHERE assignment_id = OLD.assignment_id
              AND assignment_group_id = OLD.assignment_group_id
              AND is_active = true
              AND id != OLD.id  -- Exclude the submission being deactivated
            LIMIT 1;
        ELSE
            -- Individual submission: find active submission for the same profile_id
            SELECT id INTO new_active_submission_id
            FROM public.submissions
            WHERE assignment_id = OLD.assignment_id
              AND profile_id = OLD.profile_id
              AND assignment_group_id IS NULL
              AND is_active = true
              AND id != OLD.id  -- Exclude the submission being deactivated
            LIMIT 1;
        END IF;
        
        -- If we found a new active submission, update review assignments
        IF new_active_submission_id IS NOT NULL THEN
            UPDATE public.review_assignments
            SET submission_id = new_active_submission_id
            WHERE submission_id = OLD.id;
            
            GET DIAGNOSTICS updated_count = ROW_COUNT;
            
            -- Log the update for debugging (optional)
            RAISE NOTICE 'Updated % review_assignments from submission_id % to %', 
                updated_count, OLD.id, new_active_submission_id;
        ELSE
            -- Log when no new active submission is found
            RAISE NOTICE 'No new active submission found for deactivated submission_id %', OLD.id;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$;

-- Create the trigger
CREATE CONSTRAINT TRIGGER "trigger_update_review_assignments_on_submission_deactivation"
    AFTER UPDATE OF "is_active" ON "public"."submissions"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION "public"."update_review_assignments_on_submission_deactivation"();

-- Add comment explaining the trigger
COMMENT ON FUNCTION "public"."update_review_assignments_on_submission_deactivation"() IS 
'Updates review_assignments to point to the new active submission when a submission is deactivated (is_active changes from true to false). This ensures grading review assignments always reference the currently active submission for a student/group.';

COMMENT ON TRIGGER "trigger_update_review_assignments_on_submission_deactivation" ON "public"."submissions" IS 
'Automatically updates review_assignments when a submission becomes inactive to maintain referential integrity with the active submission.';

-- Update submission_set_active function to check effective due date with extensions
-- Only allow changes before the effective due date (with extensions) OR if user has grader authorization
CREATE OR REPLACE FUNCTION "public"."submission_set_active"("_submission_id" bigint) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET search_path TO public,pg_temp
    AS $$
DECLARE
    submission_record RECORD;
    effective_due_date_with_extensions timestamp with time zone;
    current_timestamp_value timestamp with time zone;
BEGIN
    -- Get the submission details
    SELECT * INTO submission_record 
    FROM public.submissions 
    WHERE id = _submission_id;
    
    -- Check if submission exists
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    
    -- Prevent NOT-GRADED submissions from becoming active
    IF submission_record.is_not_graded THEN
        RETURN FALSE;
    END IF;
    
    -- Get current time
    current_timestamp_value := NOW();
    
    -- Calculate effective due date with extensions for this submission
    effective_due_date_with_extensions := public.calculate_final_due_date(
        submission_record.assignment_id, 
        submission_record.profile_id, 
        submission_record.assignment_group_id
    );
    
    -- Check authorization: allow if before due date OR user has grader permissions
    IF current_timestamp_value > effective_due_date_with_extensions THEN
        -- Past due date - check if user has grader authorization
        IF NOT public.authorizeforclassgrader(submission_record.class_id) THEN
            -- Not authorized and past due date
            RAISE EXCEPTION 'Cannot set submission active: past effective due date (%) and user lacks grader authorization', 
                effective_due_date_with_extensions;
        END IF;
    END IF;
    
    -- Atomically set this submission as active and all others as inactive
    -- Use CTE with row locking and null-safe equality for nullable comparisons
    WITH locked_submissions AS (
        SELECT id
        FROM public.submissions 
        WHERE assignment_id = submission_record.assignment_id 
        AND (profile_id IS NOT DISTINCT FROM submission_record.profile_id 
             OR assignment_group_id IS NOT DISTINCT FROM submission_record.assignment_group_id)
        FOR UPDATE
    )
    UPDATE public.submissions 
    SET is_active = (id = _submission_id)
    WHERE id IN (SELECT id FROM locked_submissions);
    
    RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION "public"."submission_set_active"("_submission_id" bigint) IS 
'Sets a submission as active, but only allows changes before the effective due date (including extensions) OR if the user has grader authorization for the class.';
