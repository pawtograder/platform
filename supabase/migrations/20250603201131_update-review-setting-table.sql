ALTER TABLE "public"."self_review_settings" RENAME TO "assignment_self_review_settings";

DROP POLICY "anyone in the course can view self review settings" ON "public"."assignment_self_review_settings";

CREATE POLICY "anyone in the course can view self review settings" 
ON "public"."assignment_self_review_settings"
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (
    authorizeforclass(class_id)
);

CREATE OR REPLACE FUNCTION check_assignment_deadlines_passed()
RETURNS void AS $$
DECLARE 
    assignment_record public.assignments%ROWTYPE;
    profile_record public.profiles%ROWTYPE;
BEGIN 
    FOR assignment_record IN (
        SELECT * FROM assignments 
        -- non archived assignment with passed deadline
        WHERE archived_at IS NULL 
        AND (due_date AT TIME ZONE 'UTC' <= NOW() AT TIME ZONE 'UTC')
    ) LOOP 
        FOR profile_record IN (
            SELECT * FROM public.profiles prof 
            WHERE is_private_profile = true 
            AND prof.class_id = assignment_record.class_id 
            AND EXISTS (
                SELECT 1 FROM user_roles 
                WHERE private_profile_id = prof.id 
                AND "role" = 'student'
            )
        ) LOOP 
            PERFORM auto_assign_self_reviews(assignment_record.id, profile_record.id);
        END LOOP;
    END LOOP;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION public.auto_assign_self_reviews(this_assignment_id bigint, this_profile_id uuid) 
RETURNS void 
LANGUAGE plpgsql 
SECURITY DEFINER
AS $$ 
DECLARE     
    this_assignment public.assignments;     
    this_group_id bigint; 
    this_self_review_setting public.assignment_self_review_settings;     
    this_net_deadline_change_hours integer := 0;     
    this_net_deadline_change_minutes integer := 0;     
    this_active_submission_id bigint;
    existing_submission_review_id bigint;
    utc_now TIMESTAMP := date_trunc('minute', now() + interval '59 second'); -- round up to nearest minute
BEGIN    
    -- Get the assignment first     
    SELECT * INTO this_assignment FROM public.assignments WHERE id = this_assignment_id;          
    
    -- Check if assignment exists     
    IF this_assignment.id IS NULL THEN 
        RETURN;          
    END IF;      
    
    -- Confirm this is a private profile for a student in this class, else abort     
    IF NOT EXISTS (         
        SELECT 1 FROM user_roles          
        WHERE private_profile_id = this_profile_id          
        AND role = 'student'
        AND class_id = this_assignment.class_id     
    ) THEN  
        RETURN;
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
        RETURN;       
    END IF;          
    
    -- If there is an existing review assignment for this student for this assignment, abort     
    IF EXISTS (         
        SELECT 1 FROM review_assignments          
        WHERE assignment_id = this_assignment.id          
        AND assignee_profile_id = this_profile_id     
    ) THEN 
       RETURN;       
    END IF;      
    
    SELECT COALESCE(SUM("hours"), 0) INTO this_net_deadline_change_hours      
    FROM public.assignment_due_date_exceptions      
    WHERE assignment_id = this_assignment.id      
    AND (student_id = this_profile_id OR assignment_group_id = this_group_id);     

    SELECT COALESCE(SUM("minutes"), 0) INTO this_net_deadline_change_minutes 
    FROM public.assignment_due_date_exceptions      
    WHERE assignment_id = this_assignment.id      
    AND (student_id = this_profile_id OR assignment_group_id = this_group_id);     

    
    -- If deadline has not passed, abort     
    IF NOT (this_assignment.due_date AT TIME ZONE 'UTC' + INTERVAL '1 hour' * this_net_deadline_change_hours  + 
    INTERVAL '1 minute' * this_net_deadline_change_minutes <= utc_now) THEN         
       RETURN;       
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
        RETURN;       
    END IF;          

    SELECT id INTO existing_submission_review_id
    FROM public.submission_reviews
    WHERE submission_id = this_active_submission_id
    AND class_id = this_assignment.class_id
    AND rubric_id = this_assignment.self_review_rubric_id
    LIMIT 1;

    IF existing_submission_review_id IS NULL THEN
        INSERT INTO submission_reviews (total_score, released,tweak,class_id,submission_id,name,rubric_id)
        VALUES (0, false, 0, this_assignment.class_id, this_active_submission_id, 'Self Review', this_assignment.self_review_rubric_id)
        RETURNING id INTO existing_submission_review_id;
    END IF;

    INSERT INTO review_assignments (   
        due_date,         
        assignee_profile_id,         
        submission_id,         
        submission_review_id,
        assignment_id,         
        rubric_id,         
        class_id   
    )     
    VALUES (        
        this_assignment.due_date AT TIME ZONE 'UTC' + (INTERVAL '1 hour' * this_net_deadline_change_hours) + (INTERVAL '1 minute' * this_net_deadline_change_minutes) + (INTERVAL '1 hour' * this_self_review_setting.deadline_offset),
        this_profile_id,         
        this_active_submission_id,         
        existing_submission_review_id,
        this_assignment.id,         
        this_assignment.self_review_rubric_id,         
        this_assignment.class_id
    );
END; 
$$;

-- Create trigger function to handle negative hours in due date exceptions
CREATE OR REPLACE FUNCTION handle_negative_due_date_exception()
RETURNS TRIGGER AS $$
BEGIN
    -- If hours is negative, call auto_assign_self_reviews for affected students
    IF NEW.hours < 0 THEN
        -- If student_id is specified, call for that specific student
        IF NEW.student_id IS NOT NULL THEN
            PERFORM auto_assign_self_reviews(NEW.assignment_id, NEW.student_id);
        END IF;
        
        -- If assignment_group_id is specified, call for all students in that group
        IF NEW.assignment_group_id IS NOT NULL THEN
            PERFORM auto_assign_self_reviews(NEW.assignment_id, agm.profile_id)
            FROM assignment_groups_members agm
            WHERE agm.assignment_group_id = NEW.assignment_group_id
            AND agm.assignment_id = NEW.assignment_id;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger on assignment_due_date_exceptions table
CREATE TRIGGER trigger_negative_due_date_exception
    AFTER INSERT ON assignment_due_date_exceptions
    FOR EACH ROW
    EXECUTE FUNCTION handle_negative_due_date_exception();
