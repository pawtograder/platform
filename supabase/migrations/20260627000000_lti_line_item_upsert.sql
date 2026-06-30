-------------------------------------------------------------------------------
-- LTI grade sync: atomic line-item upsert.
--
-- lti_line_items has TWO unique constraints sharing context_link_id:
--   * lti_line_items_assignment_unique (context_link_id, assignment_id)
--   * lti_line_items_column_unique     (context_link_id, gradebook_column_id)
-- A PostgREST upsert can only declare ONE arbiter, so if a gradebook column is
-- reassigned between assignments, an upsert keyed on (context_link_id,
-- assignment_id) finds no conflict on its arbiter, attempts an INSERT, and trips
-- the column-unique constraint instead — aborting the whole grade push.
--
-- This RPC resolves both constraints atomically: it first clears any stale
-- mapping that holds this column under a DIFFERENT assignment, then upserts on
-- the (context_link_id, assignment_id) arbiter. Used by syncAssignmentGrades.
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lti_upsert_line_item(
    p_context_link_id bigint,
    p_class_id bigint,
    p_assignment_id bigint,
    p_gradebook_column_id bigint,
    p_line_item_url text,
    p_label text,
    p_score_maximum numeric
)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE
    v_id bigint;
BEGIN
    -- Free the column-unique constraint: a column reassigned to a new assignment
    -- leaves a stale (context_link_id, gradebook_column_id) row under the old
    -- assignment. Removing it lets the upsert below succeed. The stale row's
    -- lti_grade_sync_state.line_item_id FK is ON DELETE SET NULL (that state
    -- belongs to the other assignment and is reconciled on its own next run).
    IF p_gradebook_column_id IS NOT NULL THEN
        DELETE FROM public.lti_line_items
        WHERE context_link_id = p_context_link_id
          AND gradebook_column_id = p_gradebook_column_id
          AND assignment_id IS DISTINCT FROM p_assignment_id;
    END IF;

    INSERT INTO public.lti_line_items (
        context_link_id, class_id, assignment_id, gradebook_column_id,
        line_item_url, label, score_maximum
    )
    VALUES (
        p_context_link_id, p_class_id, p_assignment_id, p_gradebook_column_id,
        p_line_item_url, p_label, p_score_maximum
    )
    ON CONFLICT (context_link_id, assignment_id) DO UPDATE SET
        gradebook_column_id = EXCLUDED.gradebook_column_id,
        line_item_url = EXCLUDED.line_item_url,
        label = EXCLUDED.label,
        score_maximum = EXCLUDED.score_maximum
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.lti_upsert_line_item(bigint, bigint, bigint, bigint, text, text, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lti_upsert_line_item(bigint, bigint, bigint, bigint, text, text, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.lti_upsert_line_item(bigint, bigint, bigint, bigint, text, text, numeric) TO postgres;
