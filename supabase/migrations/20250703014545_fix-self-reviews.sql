-- Drop the old, less efficient functions and triggers
DROP TRIGGER IF EXISTS self_review_insert_after_student_finish ON assignment_due_date_exceptions;
DROP FUNCTION IF EXISTS auto_assign_self_reviews_trigger();
DROP FUNCTION IF EXISTS check_assignment_deadlines_passed();
DROP FUNCTION IF EXISTS auto_assign_self_reviews(bigint, uuid);

-- Create a new function for finalizing submissions early
CREATE OR REPLACE FUNCTION finalize_submission_early(
    this_assignment_id bigint,
    this_profile_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    this_assignment public.assignments;
    this_group_id bigint;
    this_self_review_setting public.assignment_self_review_settings;
    this_active_submission_id bigint;
    existing_submission_review_id bigint;
    hours_to_subtract integer;
    minutes_to_subtract integer;
    utc_now TIMESTAMP := date_trunc('minute', now() + interval '59 second');
BEGIN
    -- Get the assignment first
    SELECT * INTO this_assignment FROM public.assignments WHERE id = this_assignment_id;
    
    -- Check if assignment exists
    IF this_assignment.id IS NULL THEN
        RETURN json_build_object('success', false, 'error', 'Assignment not found');
    END IF;
    
    -- Confirm this is a private profile for a student in this class, else abort
    IF NOT EXISTS (
        SELECT 1 FROM user_roles
        WHERE private_profile_id = this_profile_id
        AND role = 'student'
        AND class_id = this_assignment.class_id
        AND user_id = auth.uid()
    ) THEN
        RETURN json_build_object('success', false, 'error', 'Not authorized');
    END IF;
    
    -- Get the group of the student for this assignment
    SELECT assignment_group_id INTO this_group_id
    FROM public.assignment_groups_members
    WHERE profile_id = this_profile_id
    AND class_id = this_assignment.class_id
    AND assignment_id = this_assignment.id
    LIMIT 1;
    
    -- Get the self review setting
    SELECT * INTO this_self_review_setting
    FROM public.assignment_self_review_settings
    WHERE id = this_assignment.self_review_setting_id;
    
    -- If self reviews are not enabled for this assignment, abort
    IF this_self_review_setting.enabled IS NOT TRUE THEN
        RETURN json_build_object('success', false, 'error', 'Self reviews not enabled for this assignment');
    END IF;
    
    -- Check if there's already a negative due date exception (already finalized)
    IF EXISTS (
        SELECT 1 FROM assignment_due_date_exceptions
        WHERE assignment_id = this_assignment_id
        AND (
            (student_id = this_profile_id AND hours < 0) OR
            (assignment_group_id = this_group_id AND hours < 0)
        )
    ) THEN
        RETURN json_build_object('success', false, 'error', 'Submission already finalized');
    END IF;
    
    -- Calculate hours and minutes to subtract
    hours_to_subtract := -1 * EXTRACT(EPOCH FROM (this_assignment.due_date - utc_now)) / 3600;
    minutes_to_subtract := -1 * (EXTRACT(EPOCH FROM (this_assignment.due_date - utc_now)) % 3600) / 60;
    
    -- Insert the negative due date exception
    IF this_group_id IS NOT NULL THEN
        INSERT INTO assignment_due_date_exceptions (
            class_id,
            assignment_id,
            assignment_group_id,
            creator_id,
            hours,
            minutes,
            tokens_consumed
        ) VALUES (
            this_assignment.class_id,
            this_assignment_id,
            this_group_id,
            this_profile_id,
            hours_to_subtract,
            minutes_to_subtract,
            0
        );
    ELSE
        INSERT INTO assignment_due_date_exceptions (
            class_id,
            assignment_id,
            student_id,
            creator_id,
            hours,
            minutes,
            tokens_consumed
        ) VALUES (
            this_assignment.class_id,
            this_assignment_id,
            this_profile_id,
            this_profile_id,
            hours_to_subtract,
            minutes_to_subtract,
            0
        );
    END IF;
    
    -- Get the active submission id for this profile
    SELECT id INTO this_active_submission_id
    FROM public.submissions
    WHERE ((profile_id IS NOT NULL AND profile_id = this_profile_id) OR (assignment_group_id IS NOT NULL AND assignment_group_id = this_group_id))
    AND assignment_id = this_assignment_id
    AND is_active = true
    LIMIT 1;
    
    -- If active submission does not exist, abort
    IF this_active_submission_id IS NULL THEN
        RETURN json_build_object('success', false, 'error', 'No active submission found');
    END IF;
    
    -- Check if there's already a review assignment for this student for this assignment
    IF EXISTS (
        SELECT 1 FROM review_assignments
        WHERE assignment_id = this_assignment.id
        AND assignee_profile_id = this_profile_id
    ) THEN
        RETURN json_build_object('success', false, 'error', 'Self review already assigned');
    END IF;
    
    -- Create or get existing submission review
    SELECT id INTO existing_submission_review_id
    FROM public.submission_reviews
    WHERE submission_id = this_active_submission_id
    AND class_id = this_assignment.class_id
    AND rubric_id = this_assignment.self_review_rubric_id
    LIMIT 1;
    
    IF existing_submission_review_id IS NULL THEN
        INSERT INTO submission_reviews (total_score, released, tweak, class_id, submission_id, name, rubric_id)
        VALUES (0, false, 0, this_assignment.class_id, this_active_submission_id, 'Self Review', this_assignment.self_review_rubric_id)
        RETURNING id INTO existing_submission_review_id;
    END IF;
    
    -- Create the review assignment
    INSERT INTO review_assignments (
        due_date,
        assignee_profile_id,
        submission_id,
        submission_review_id,
        assignment_id,
        rubric_id,
        class_id
    ) VALUES (
        utc_now + (INTERVAL '1 hour' * this_self_review_setting.deadline_offset),
        this_profile_id,
        this_active_submission_id,
        existing_submission_review_id,
        this_assignment.id,
        this_assignment.self_review_rubric_id,
        this_assignment.class_id
    );
    
    RETURN json_build_object('success', true, 'message', 'Submission finalized and self review assigned');
END;
$$;

-- Create optimized cron job function that doesn't use loops
CREATE OR REPLACE FUNCTION check_assignment_deadlines_passed()
RETURNS void AS $$
BEGIN
    -- First, create any missing submission reviews
    INSERT INTO submission_reviews (total_score, released, tweak, class_id, submission_id, name, rubric_id)
    SELECT DISTINCT
        0, false, 0, a.class_id, s.id, 'Self Review', a.self_review_rubric_id
    FROM assignments a
    JOIN assignment_self_review_settings ars ON ars.id = a.self_review_setting_id
    JOIN profiles prof ON prof.class_id = a.class_id AND prof.is_private_profile = true
    JOIN user_roles ur ON ur.private_profile_id = prof.id AND ur.role = 'student'
    JOIN submissions s ON (
        (s.profile_id = prof.id OR s.assignment_group_id IN (
            SELECT agm.assignment_group_id 
            FROM assignment_groups_members agm 
            WHERE agm.profile_id = prof.id AND agm.assignment_id = a.id
        ))
        AND s.assignment_id = a.id 
        AND s.is_active = true
    )
    LEFT JOIN assignment_groups_members agm ON agm.profile_id = prof.id AND agm.assignment_id = a.id
    LEFT JOIN assignment_due_date_exceptions adde ON (
        adde.assignment_id = a.id AND
        (adde.student_id = prof.id OR adde.assignment_group_id = agm.assignment_group_id)
    )
    WHERE a.archived_at IS NULL
    AND ars.enabled = true
    AND a.due_date <= NOW()
    AND a.due_date + COALESCE(adde.hours, 0) * INTERVAL '1 hour' + COALESCE(adde.minutes, 0) * INTERVAL '1 minute' <= NOW()
    AND NOT EXISTS (
        SELECT 1 FROM review_assignments ra 
        WHERE ra.assignment_id = a.id AND ra.assignee_profile_id = prof.id
    )
    AND NOT EXISTS (
        SELECT 1 FROM submission_reviews sr 
        WHERE sr.submission_id = s.id 
        AND sr.class_id = a.class_id 
        AND sr.rubric_id = a.self_review_rubric_id
    )
    ON CONFLICT (submission_id, rubric_id) DO NOTHING;

    -- Then, insert review assignments for students who need them but don't have them yet
    INSERT INTO review_assignments (
        due_date,
        assignee_profile_id,
        submission_id,
        submission_review_id,
        assignment_id,
        rubric_id,
        class_id
    )
    SELECT DISTINCT
        a.due_date + COALESCE(adde.hours, 0) * INTERVAL '1 hour' + COALESCE(adde.minutes, 0) * INTERVAL '1 minute' + (INTERVAL '1 hour' * ars.deadline_offset),
        prof.id,
        s.id,
        sr.id,
        a.id,
        a.self_review_rubric_id,
        a.class_id
    FROM assignments a
    JOIN assignment_self_review_settings ars ON ars.id = a.self_review_setting_id
    JOIN profiles prof ON prof.class_id = a.class_id AND prof.is_private_profile = true
    JOIN user_roles ur ON ur.private_profile_id = prof.id AND ur.role = 'student'
    JOIN submissions s ON (
        (s.profile_id = prof.id OR s.assignment_group_id IN (
            SELECT agm.assignment_group_id 
            FROM assignment_groups_members agm 
            WHERE agm.profile_id = prof.id AND agm.assignment_id = a.id
        ))
        AND s.assignment_id = a.id 
        AND s.is_active = true
    )
    LEFT JOIN assignment_groups_members agm ON agm.profile_id = prof.id AND agm.assignment_id = a.id
    LEFT JOIN assignment_due_date_exceptions adde ON (
        adde.assignment_id = a.id AND
        (adde.student_id = prof.id OR adde.assignment_group_id = agm.assignment_group_id)
    )
    JOIN submission_reviews sr ON (
        sr.submission_id = s.id 
        AND sr.class_id = a.class_id 
        AND sr.rubric_id = a.self_review_rubric_id
    )
    WHERE a.archived_at IS NULL
    AND ars.enabled = true
    AND a.due_date <= NOW()
    AND a.due_date + COALESCE(adde.hours, 0) * INTERVAL '1 hour' + COALESCE(adde.minutes, 0) * INTERVAL '1 minute' <= NOW()
    AND NOT EXISTS (
        SELECT 1 FROM review_assignments ra 
        WHERE ra.assignment_id = a.id AND ra.assignee_profile_id = prof.id
    )
    ON CONFLICT (submission_review_id, assignee_profile_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- Drop the old trigger since we're handling this differently now
DROP TRIGGER IF EXISTS trigger_negative_due_date_exception ON assignment_due_date_exceptions;
DROP FUNCTION IF EXISTS handle_negative_due_date_exception();

-- Grant execute permission on the function to authenticated users
GRANT EXECUTE ON FUNCTION finalize_submission_early(bigint, uuid) TO authenticated;

-- Add unique constraint to prevent duplicate review assignments
ALTER TABLE review_assignments ADD CONSTRAINT review_assignments_assignee_submission_review_unique UNIQUE (assignee_profile_id, submission_review_id);

-- Add unique constraint to prevent duplicate submission reviews
ALTER TABLE submission_reviews ADD CONSTRAINT submission_reviews_submission_rubric_unique UNIQUE (submission_id, rubric_id);
