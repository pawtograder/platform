-- Releasing any submission review published the submission's hidden autograder tests.
--
-- submissionreviewreleasecascade() (last defined in 20251113211404_optimize-bulk-release-reviews.sql)
-- set grader_result_tests.is_released = true for every test of the submission whenever ANY of its
-- submission_reviews rows flipped to released: it joined grader_results to the transition table on
-- submission_id alone. submission_reviews holds one row per (submission, rubric), so releasing a
-- code walk, a self-review or a meta-grading review exposed the hidden tests while the grading
-- review, and the grade, were still unreleased. The per-submission release button has always done
-- this; 20261020120000 added a bulk path for code walks, which would do it for a whole assignment.
--
-- This migration restricts that one cascade to the grading review (the transition row's id equals
-- submissions.grading_review_id), the same predicate the cascade already uses for
-- submissions.released. Everything else is copied verbatim from 20251113211404: the comment
-- cascades still follow every review, in both directions, and the trigger stays statement-level.
--
-- The unrelease direction is unchanged. Since 20251113211404 the trigger never resets
-- grader_result_tests.is_released to false, for any review, so unreleasing a grading review leaves
-- its tests visible as it does today. Re-hiding tests on unrelease would be a separate behavior
-- change. Tests that a code walk release already exposed before this migration stay released; this
-- migration does not repair existing rows.

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

    -- Update grader_result_tests (only when releasing to true), and only when the review being
    -- released is the submission's GRADING review. Releasing a code walk, self-review or
    -- meta-grading review must not publish hidden autograder tests.
    -- ORDER BY primary key to ensure deterministic lock acquisition order and prevent deadlocks
    UPDATE public.grader_result_tests grt
    SET is_released = true
    FROM (
        SELECT grt_inner.id
        FROM public.grader_result_tests grt_inner
        INNER JOIN public.grader_results gr ON grt_inner.grader_result_id = gr.id
        INNER JOIN new_table nt ON gr.submission_id = nt.submission_id
        INNER JOIN public.submissions s_grading ON s_grading.id = nt.submission_id
            AND s_grading.grading_review_id = nt.id
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
