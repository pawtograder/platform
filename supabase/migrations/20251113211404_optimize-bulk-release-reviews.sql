-- Migration: Replace row-level trigger with statement-level trigger for batch updates
-- This avoids the row-level trigger firing thousands of times, which causes timeouts

-- Drop the old row-level trigger
DROP TRIGGER IF EXISTS submission_review_release ON public.submission_reviews;

-- Create a new statement-level trigger function that processes all changed rows at once
-- Uses JOINs instead of ANY(array) for better performance with large batches
CREATE OR REPLACE FUNCTION public.submissionreviewreleasecascade()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
    -- Batch update comments for reviews set to released=true
    -- Use JOIN with transition tables for efficient updates
    -- ORDER BY primary key to ensure deterministic lock acquisition order and prevent deadlocks
    UPDATE public.submission_file_comments sfc
    SET released = true
    FROM (
        SELECT sfc_inner.id
        FROM public.submission_file_comments sfc_inner
        INNER JOIN new_table nt ON sfc_inner.submission_review_id = nt.id
        INNER JOIN old_table ot ON ot.id = nt.id
        WHERE ot.released IS DISTINCT FROM nt.released
        AND nt.released = true
        AND sfc_inner.released = false
        ORDER BY sfc_inner.id
    ) ordered_rows
    WHERE sfc.id = ordered_rows.id;

    UPDATE public.submission_comments sc
    SET released = true
    FROM (
        SELECT sc_inner.id
        FROM public.submission_comments sc_inner
        INNER JOIN new_table nt ON sc_inner.submission_review_id = nt.id
        INNER JOIN old_table ot ON ot.id = nt.id
        WHERE ot.released IS DISTINCT FROM nt.released
        AND nt.released = true
        AND sc_inner.released = false
        ORDER BY sc_inner.id
    ) ordered_rows
    WHERE sc.id = ordered_rows.id;

    UPDATE public.submission_artifact_comments sac
    SET released = true
    FROM (
        SELECT sac_inner.id
        FROM public.submission_artifact_comments sac_inner
        INNER JOIN new_table nt ON sac_inner.submission_review_id = nt.id
        INNER JOIN old_table ot ON ot.id = nt.id
        WHERE ot.released IS DISTINCT FROM nt.released
        AND nt.released = true
        AND sac_inner.released = false
        ORDER BY sac_inner.id
    ) ordered_rows
    WHERE sac.id = ordered_rows.id;

    -- Update grader_result_tests (only when releasing to true)
    -- ORDER BY primary key to ensure deterministic lock acquisition order and prevent deadlocks
    UPDATE public.grader_result_tests grt
    SET is_released = true
    FROM (
        SELECT grt_inner.id
        FROM public.grader_result_tests grt_inner
        INNER JOIN public.grader_results gr ON grt_inner.grader_result_id = gr.id
        INNER JOIN new_table nt ON gr.submission_id = nt.submission_id
        INNER JOIN old_table ot ON ot.id = nt.id
        WHERE ot.released IS DISTINCT FROM nt.released
        AND nt.released = true
        AND grt_inner.is_released = false
        ORDER BY grt_inner.id
    ) ordered_rows
    WHERE grt.id = ordered_rows.id;

    -- Batch update comments for reviews set to released=false
    -- ORDER BY primary key to ensure deterministic lock acquisition order and prevent deadlocks
    UPDATE public.submission_file_comments sfc
    SET released = false
    FROM (
        SELECT sfc_inner.id
        FROM public.submission_file_comments sfc_inner
        INNER JOIN new_table nt ON sfc_inner.submission_review_id = nt.id
        INNER JOIN old_table ot ON ot.id = nt.id
        WHERE ot.released IS DISTINCT FROM nt.released
        AND nt.released = false
        AND sfc_inner.released = true
        ORDER BY sfc_inner.id
    ) ordered_rows
    WHERE sfc.id = ordered_rows.id;

    UPDATE public.submission_comments sc
    SET released = false
    FROM (
        SELECT sc_inner.id
        FROM public.submission_comments sc_inner
        INNER JOIN new_table nt ON sc_inner.submission_review_id = nt.id
        INNER JOIN old_table ot ON ot.id = nt.id
        WHERE ot.released IS DISTINCT FROM nt.released
        AND nt.released = false
        AND sc_inner.released = true
        ORDER BY sc_inner.id
    ) ordered_rows
    WHERE sc.id = ordered_rows.id;

    UPDATE public.submission_artifact_comments sac
    SET released = false
    FROM (
        SELECT sac_inner.id
        FROM public.submission_artifact_comments sac_inner
        INNER JOIN new_table nt ON sac_inner.submission_review_id = nt.id
        INNER JOIN old_table ot ON ot.id = nt.id
        WHERE ot.released IS DISTINCT FROM nt.released
        AND nt.released = false
        AND sac_inner.released = true
        ORDER BY sac_inner.id
    ) ordered_rows
    WHERE sac.id = ordered_rows.id;

    -- Update submissions for grading reviews that were released
    -- ORDER BY primary key to ensure deterministic lock acquisition order and prevent deadlocks
    UPDATE public.submissions s
    SET released = NOW()
    FROM (
        SELECT s_inner.id
        FROM public.submissions s_inner
        INNER JOIN new_table nt ON s_inner.grading_review_id = nt.id AND s_inner.id = nt.submission_id
        INNER JOIN old_table ot ON ot.id = nt.id
        WHERE ot.released IS DISTINCT FROM nt.released
        AND nt.released = true
        AND s_inner.released IS NULL
        ORDER BY s_inner.id
    ) ordered_rows
    WHERE s.id = ordered_rows.id;

    -- Update submissions for grading reviews that were unreleased
    -- ORDER BY primary key to ensure deterministic lock acquisition order and prevent deadlocks
    UPDATE public.submissions s
    SET released = NULL
    FROM (
        SELECT s_inner.id
        FROM public.submissions s_inner
        INNER JOIN new_table nt ON s_inner.grading_review_id = nt.id AND s_inner.id = nt.submission_id
        INNER JOIN old_table ot ON ot.id = nt.id
        WHERE ot.released IS DISTINCT FROM nt.released
        AND nt.released = false
        AND s_inner.released IS NOT NULL
        ORDER BY s_inner.id
    ) ordered_rows
    WHERE s.id = ordered_rows.id;

    RETURN NULL;
END;
$function$;

-- Create statement-level trigger that processes all changed rows at once
CREATE TRIGGER submission_review_release 
AFTER UPDATE ON public.submission_reviews
REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
FOR EACH STATEMENT
EXECUTE FUNCTION public.submissionreviewreleasecascade();

