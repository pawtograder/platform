-- Migration to set up email batch processing
-- Similar to gradebook batch processor pattern

-- Drop the old HTTP trigger for emailer since we now use batch processing with cron jobs
-- The old trigger was calling the notification-queue-processor via HTTP request on every notification insert
-- This is replaced by the continuous batch processing system

DROP TRIGGER IF EXISTS notifications_emailer ON public.notifications;

-- Helper function to invoke email batch processor background task
CREATE OR REPLACE FUNCTION public.invoke_email_batch_processor_background_task()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
    -- Start multiple instances for redundancy and parallel processing
    PERFORM public.call_edge_function_internal(
        '/functions/v1/notification-queue-processor', 
        'POST', 
        '{"Content-type":"application/json"}', 
        '{}', 
        5000,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL
    );
    PERFORM public.call_edge_function_internal(
        '/functions/v1/notification-queue-processor', 
        'POST', 
        '{"Content-type":"application/json"}', 
        '{}', 
        5000,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL
    );
    PERFORM public.call_edge_function_internal(
        '/functions/v1/notification-queue-processor', 
        'POST', 
        '{"Content-type":"application/json"}', 
        '{}', 
        5000,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL
    );
END;
$function$;

-- Schedule the email batch processor to run every minute
-- This ensures workers are always running
SELECT cron.schedule(
    'invoke-email-batch-processor-every-minute', 
    '* * * * *', 
    'SELECT invoke_email_batch_processor_background_task();'
);

-- Grant necessary permissions
GRANT EXECUTE ON FUNCTION public.invoke_email_batch_processor_background_task() TO service_role;

-- Also, remove bogus ON CONFLICT DO NOTHING from this trigger...
CREATE OR REPLACE FUNCTION "public"."check_assignment_deadlines_passed"() 
RETURNS void
LANGUAGE "plpgsql" SECURITY DEFINER
AS $$
BEGIN
    -- First, create any missing submission reviews for students whose lab-based due dates have passed
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
    WHERE a.archived_at IS NULL
    AND ars.enabled = true
    AND a.self_review_rubric_id IS NOT NULL
    AND public.calculate_final_due_date(a.id, prof.id, agm.assignment_group_id) <= NOW()
    AND NOT EXISTS (
        SELECT 1 FROM review_assignments ra 
        WHERE ra.assignment_id = a.id AND ra.assignee_profile_id = prof.id
    )
    AND NOT EXISTS (
        SELECT 1 FROM submission_reviews sr 
        WHERE sr.submission_id = s.id 
        AND sr.class_id = a.class_id 
        AND sr.rubric_id = a.self_review_rubric_id
    );

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
        public.calculate_final_due_date(a.id, prof.id, agm.assignment_group_id) + (INTERVAL '1 hour' * ars.deadline_offset),
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
    JOIN submission_reviews sr ON (
        sr.submission_id = s.id 
        AND sr.class_id = a.class_id 
        AND sr.rubric_id = a.self_review_rubric_id
    )
    WHERE a.archived_at IS NULL
    AND ars.enabled = true
    AND public.calculate_final_due_date(a.id, prof.id, agm.assignment_group_id) <= NOW()
    AND NOT EXISTS (
        SELECT 1 FROM review_assignments ra 
        WHERE ra.assignment_id = a.id AND ra.assignee_profile_id = prof.id
    );
END;
$$;

-- Update finalize_submission_early to use lab-based due dates
CREATE OR REPLACE FUNCTION "public"."finalize_submission_early"("this_assignment_id" bigint, "this_profile_id" uuid) 
RETURNS json
LANGUAGE "plpgsql" SECURITY DEFINER
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
    effective_due_date timestamp with time zone;
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
    
    -- Get the effective due date (lab-based or regular)
    effective_due_date := public.calculate_effective_due_date(this_assignment_id, this_profile_id);
    
    -- Calculate hours and minutes to subtract from the effective due date
    hours_to_subtract := -1 * EXTRACT(EPOCH FROM (effective_due_date - utc_now)) / 3600;
    minutes_to_subtract := -1 * (EXTRACT(EPOCH FROM (effective_due_date - utc_now)) % 3600) / 60;
    
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
    
    -- Create the review assignment using the effective due date
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