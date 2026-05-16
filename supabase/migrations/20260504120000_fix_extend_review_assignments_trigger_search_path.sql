CREATE OR REPLACE FUNCTION extend_review_assignments_on_due_date_exception()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    extension_interval INTERVAL;
    affected_student_ids UUID[];
BEGIN
    IF COALESCE(NEW.hours, 0) < 0 OR COALESCE(NEW.minutes, 0) < 0 THEN
        RETURN NEW;
    END IF;

    IF COALESCE(NEW.hours, 0) = 0 AND COALESCE(NEW.minutes, 0) = 0 THEN
        RETURN NEW;
    END IF;

    extension_interval := make_interval(hours => COALESCE(NEW.hours, 0), mins => COALESCE(NEW.minutes, 0));

    IF NEW.student_id IS NOT NULL THEN
        affected_student_ids := ARRAY[NEW.student_id];
    ELSIF NEW.assignment_group_id IS NOT NULL THEN
        SELECT ARRAY_AGG(profile_id) INTO affected_student_ids
        FROM assignment_groups_members
        WHERE assignment_group_id = NEW.assignment_group_id;
    ELSE
        RETURN NEW;
    END IF;

    UPDATE review_assignments
    SET due_date = due_date + extension_interval
    WHERE assignment_id = NEW.assignment_id
      AND assignee_profile_id = ANY(affected_student_ids);

    RETURN NEW;
END;
$$;
