-- Issue #504: When an instructor extends an assignment due_date after the original
-- deadline, existing self-review review_assignments kept the old due_date.
-- Shift self-review due dates by the same delta as the assignment due_date change.

CREATE OR REPLACE FUNCTION public.shift_self_review_assignments_on_assignment_due_date_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    delta interval;
BEGIN
    IF TG_OP <> 'UPDATE' OR NEW.due_date IS NOT DISTINCT FROM OLD.due_date THEN
        RETURN NEW;
    END IF;

    delta := NEW.due_date - OLD.due_date;

    IF delta = interval '0' THEN
        RETURN NEW;
    END IF;

    UPDATE public.review_assignments ra
    SET due_date = ra.due_date + delta
    FROM public.rubrics r
    WHERE ra.assignment_id = NEW.id
      AND ra.rubric_id = r.id
      AND r.review_round = 'self-review'
      AND ra.completed_at IS NULL;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.shift_self_review_assignments_on_assignment_due_date_change() IS
'When assignments.due_date changes, adds the same interval to incomplete self-review review_assignments for that assignment (issue #504).';

DROP TRIGGER IF EXISTS trigger_shift_self_review_on_assignment_due_date_change ON public.assignments;

CREATE TRIGGER trigger_shift_self_review_on_assignment_due_date_change
    AFTER UPDATE OF due_date ON public.assignments
    FOR EACH ROW
    EXECUTE FUNCTION public.shift_self_review_assignments_on_assignment_due_date_change();
