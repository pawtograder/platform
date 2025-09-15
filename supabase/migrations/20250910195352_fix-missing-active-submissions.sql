CREATE OR REPLACE FUNCTION "public"."submission_set_active"("_submission_id" bigint) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    submission_record RECORD;
BEGIN
    -- Get the submission details
    SELECT * INTO submission_record 
    FROM submissions 
    WHERE id = _submission_id;
    
    -- Check if submission exists
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    
    -- SECURITY CHECK: Verify user has permission to modify this submission
    IF NOT authorize_for_submission(_submission_id) THEN
        RETURN FALSE;
    END IF;
    
    -- Prevent NOT-GRADED submissions from becoming active
    IF submission_record.is_not_graded THEN
        RETURN FALSE;
    END IF;
    
    -- Set all other submissions for this assignment/student to inactive
    -- Handle individual vs group submissions separately to avoid cross-contamination
    IF submission_record.assignment_group_id IS NOT NULL THEN
        -- Group submission: deactivate other submissions for the same group
        UPDATE submissions 
        SET is_active = false 
        WHERE assignment_id = submission_record.assignment_id 
        AND assignment_group_id = submission_record.assignment_group_id
        AND id != _submission_id;
    ELSE
        -- Individual submission: deactivate other submissions for the same student
        UPDATE submissions 
        SET is_active = false 
        WHERE assignment_id = submission_record.assignment_id 
        AND profile_id = submission_record.profile_id
        AND assignment_group_id IS NULL  -- Ensure we only match individual submissions
        AND id != _submission_id;
    END IF;
    
    -- Set this submission as active
    UPDATE submissions 
    SET is_active = true 
    WHERE id = _submission_id;
    
    RETURN TRUE;
END;
$$;