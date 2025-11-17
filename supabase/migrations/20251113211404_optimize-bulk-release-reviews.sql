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
    UPDATE public.submission_file_comments sfc
    SET released = true
    FROM new_table nt
    INNER JOIN old_table ot ON ot.id = nt.id
    WHERE sfc.submission_review_id = nt.id
    AND ot.released IS DISTINCT FROM nt.released
    AND nt.released = true
    AND sfc.released = false;

    UPDATE public.submission_comments sc
    SET released = true
    FROM new_table nt
    INNER JOIN old_table ot ON ot.id = nt.id
    WHERE sc.submission_review_id = nt.id
    AND ot.released IS DISTINCT FROM nt.released
    AND nt.released = true
    AND sc.released = false;

    UPDATE public.submission_artifact_comments sac
    SET released = true
    FROM new_table nt
    INNER JOIN old_table ot ON ot.id = nt.id
    WHERE sac.submission_review_id = nt.id
    AND ot.released IS DISTINCT FROM nt.released
    AND nt.released = true
    AND sac.released = false;

    -- Update grader_result_tests (only when releasing to true)
    UPDATE public.grader_result_tests grt
    SET is_released = true
    FROM public.grader_results gr
    INNER JOIN new_table nt ON gr.submission_id = nt.submission_id
    INNER JOIN old_table ot ON ot.id = nt.id
    WHERE grt.grader_result_id = gr.id
    AND ot.released IS DISTINCT FROM nt.released
    AND nt.released = true
    AND grt.is_released = false;

    -- Batch update comments for reviews set to released=false
    UPDATE public.submission_file_comments sfc
    SET released = false
    FROM new_table nt
    INNER JOIN old_table ot ON ot.id = nt.id
    WHERE sfc.submission_review_id = nt.id
    AND ot.released IS DISTINCT FROM nt.released
    AND nt.released = false
    AND sfc.released = true;

    UPDATE public.submission_comments sc
    SET released = false
    FROM new_table nt
    INNER JOIN old_table ot ON ot.id = nt.id
    WHERE sc.submission_review_id = nt.id
    AND ot.released IS DISTINCT FROM nt.released
    AND nt.released = false
    AND sc.released = true;

    UPDATE public.submission_artifact_comments sac
    SET released = false
    FROM new_table nt
    INNER JOIN old_table ot ON ot.id = nt.id
    WHERE sac.submission_review_id = nt.id
    AND ot.released IS DISTINCT FROM nt.released
    AND nt.released = false
    AND sac.released = true;

    -- Update submissions for grading reviews that were released
    UPDATE public.submissions s
    SET released = NOW()
    FROM new_table nt
    INNER JOIN old_table ot ON ot.id = nt.id
    WHERE s.grading_review_id = nt.id
    AND s.id = nt.submission_id
    AND ot.released IS DISTINCT FROM nt.released
    AND nt.released = true
    AND s.released IS NULL;

    -- Update submissions for grading reviews that were unreleased
    UPDATE public.submissions s
    SET released = NULL
    FROM new_table nt
    INNER JOIN old_table ot ON ot.id = nt.id
    WHERE s.grading_review_id = nt.id
    AND s.id = nt.submission_id
    AND ot.released IS DISTINCT FROM nt.released
    AND nt.released = false
    AND s.released IS NOT NULL;

    RETURN NULL;
END;
$function$;

-- Create statement-level trigger that processes all changed rows at once
CREATE TRIGGER submission_review_release 
AFTER UPDATE ON public.submission_reviews
REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
FOR EACH STATEMENT
EXECUTE FUNCTION public.submissionreviewreleasecascade();

