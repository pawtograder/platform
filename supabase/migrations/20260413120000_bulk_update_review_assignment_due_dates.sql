-- Instructors can set due_date on many review_assignments at once (self-review and grading rounds).
-- p_rubric_id is required (one rubric per call). When p_only_incomplete is true, rows are updated
-- only if both review_assignments.completed_at and the linked submission_reviews.completed_at are null.

CREATE OR REPLACE FUNCTION public.bulk_update_review_assignment_due_dates(
    p_class_id bigint,
    p_assignment_id bigint,
    p_rubric_id bigint,
    p_due_date timestamp with time zone,
    p_only_incomplete boolean DEFAULT true
) RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public'
AS $$
DECLARE
    v_updated integer := 0;
BEGIN
    IF NOT authorizeforclassinstructor(p_class_id) THEN
        RAISE EXCEPTION 'Access denied: Only instructors can update review assignment due dates'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.assignments
        WHERE id = p_assignment_id AND class_id = p_class_id
    ) THEN
        RAISE EXCEPTION 'Assignment % not found in class %', p_assignment_id, p_class_id;
    END IF;

    IF p_rubric_id IS NULL THEN
        RAISE EXCEPTION 'p_rubric_id is required';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.rubrics
        WHERE id = p_rubric_id AND assignment_id = p_assignment_id AND class_id = p_class_id
    ) THEN
        RAISE EXCEPTION 'Rubric % not found for assignment %', p_rubric_id, p_assignment_id;
    END IF;

    UPDATE public.review_assignments ra
    SET due_date = p_due_date
    WHERE ra.id IN (
        SELECT ra2.id
        FROM public.review_assignments ra2
        LEFT JOIN public.submission_reviews sr ON sr.id = ra2.submission_review_id
        WHERE ra2.class_id = p_class_id
          AND ra2.assignment_id = p_assignment_id
          AND ra2.rubric_id = p_rubric_id
          AND (
              NOT p_only_incomplete
              OR (ra2.completed_at IS NULL AND sr.completed_at IS NULL)
          )
    );

    GET DIAGNOSTICS v_updated = ROW_COUNT;

    RETURN jsonb_build_object(
        'success', true,
        'updated', v_updated
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.bulk_update_review_assignment_due_dates(
    bigint, bigint, bigint, timestamp with time zone, boolean
) TO authenticated;

COMMENT ON FUNCTION public.bulk_update_review_assignment_due_dates(
    bigint, bigint, bigint, timestamp with time zone, boolean
) IS
    'Sets due_date on review_assignments for one rubric on an assignment. p_rubric_id is required. Optional incomplete-only: both review_assignment and linked submission_review must be incomplete.';
