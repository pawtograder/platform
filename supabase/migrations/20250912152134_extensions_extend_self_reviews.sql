-- Function to extend review assignment due dates when due date exceptions are added
CREATE OR REPLACE FUNCTION extend_review_assignments_on_due_date_exception()
RETURNS TRIGGER AS $$
DECLARE
    extension_interval INTERVAL;
    affected_student_ids UUID[];
BEGIN
    -- Only process positive extensions (ignore negative extensions that shorten deadlines)
    IF NEW.hours < 0 OR NEW.minutes < 0 THEN
        RETURN NEW;
    END IF;
    
    -- Calculate the extension interval from hours and minutes
    extension_interval := (NEW.hours || ' hours')::INTERVAL + (NEW.minutes || ' minutes')::INTERVAL;
    
    -- Determine which students are affected by this exception
    IF NEW.student_id IS NOT NULL THEN
        -- Individual student exception
        affected_student_ids := ARRAY[NEW.student_id];
    ELSIF NEW.assignment_group_id IS NOT NULL THEN
        -- Group exception - get all members of the group
        SELECT ARRAY_AGG(profile_id) INTO affected_student_ids
        FROM assignment_groups_members
        WHERE assignment_group_id = NEW.assignment_group_id;
    ELSE
        -- No student or group specified, nothing to do
        RETURN NEW;
    END IF;
    
    -- Update review assignments for the affected students
    UPDATE review_assignments
    SET due_date = due_date + extension_interval
    WHERE assignment_id = NEW.assignment_id
      AND assignee_profile_id = ANY(affected_student_ids);
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to call the function after a due date exception is inserted
CREATE OR REPLACE TRIGGER trigger_extend_review_assignments_on_due_date_exception
    AFTER INSERT ON assignment_due_date_exceptions
    FOR EACH ROW
    EXECUTE FUNCTION extend_review_assignments_on_due_date_exception();
