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

-- One-time backfill: self-review rows created before this fix may still reflect an old
-- assignment due_date. Recompute due_date from the current assignment due_date, summed
-- per-student exceptions, and self-review deadline_offset (same building blocks as
-- check_assignment_deadlines_passed). Uses a CTE so the UPDATE target can correlate
-- inside the scalar subquery (LATERAL in UPDATE FROM cannot reference the updated row).
-- Ignore due-date exceptions that shorten the window (negative hours/minutes net) when
-- they were created after the review_assignment: those could not have affected the
-- original self-review due_date at creation time.
WITH recomputed AS (
    SELECT
        ra.id AS review_assignment_id,
        (
            SELECT
                a.due_date
                    + (COALESCE(SUM(adde.hours), 0) * INTERVAL '1 hour')
                    + (COALESCE(SUM(adde.minutes), 0) * INTERVAL '1 minute')
                    + (COALESCE(ars.deadline_offset, 0) * INTERVAL '1 hour')
            FROM public.assignments a
            INNER JOIN public.assignment_self_review_settings ars ON ars.id = a.self_review_setting_id
            LEFT JOIN public.assignment_due_date_exceptions adde ON
                adde.assignment_id = a.id
                AND (
                    adde.student_id = ra.assignee_profile_id
                    OR (
                        adde.assignment_group_id IS NOT NULL
                        AND EXISTS (
                            SELECT 1
                            FROM public.assignment_groups_members agm
                            WHERE agm.assignment_id = a.id
                              AND agm.class_id = a.class_id
                              AND agm.profile_id = ra.assignee_profile_id
                              AND agm.assignment_group_id = adde.assignment_group_id
                        )
                    )
                )
                AND (
                    (COALESCE(adde.hours, 0) * 60 + COALESCE(adde.minutes, 0)) >= 0
                    OR adde.created_at <= ra.created_at
                )
            WHERE a.id = ra.assignment_id
            GROUP BY a.due_date, ars.deadline_offset
        ) AS new_due
    FROM public.review_assignments ra
    INNER JOIN public.rubrics r ON r.id = ra.rubric_id AND r.review_round = 'self-review'
    WHERE ra.completed_at IS NULL
)
UPDATE public.review_assignments ra
SET due_date = rc.new_due
FROM recomputed rc
WHERE ra.id = rc.review_assignment_id
  AND rc.new_due IS NOT NULL
  AND ra.due_date IS DISTINCT FROM rc.new_due;

DROP TRIGGER IF EXISTS trigger_shift_self_review_on_assignment_due_date_change ON public.assignments;

CREATE TRIGGER trigger_shift_self_review_on_assignment_due_date_change
    AFTER UPDATE OF due_date ON public.assignments
    FOR EACH ROW
    EXECUTE FUNCTION public.shift_self_review_assignments_on_assignment_due_date_change();
