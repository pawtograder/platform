-- Issue #618: when activating a newer submission, keep existing grading comments
-- on the old submission and reopen moved review assignments for reassignment.
CREATE OR REPLACE FUNCTION public.update_review_assignments_on_submission_deactivation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
    new_active_submission_id bigint;
    moved_rubric_ids bigint[] := '{}'::bigint[];
    deleted_conflicting_assignments integer := 0;
    updated_assignments_count integer := 0;
    updated_links_count integer := 0;
    reset_submission_reviews_count integer := 0;
BEGIN
    -- Only proceed if is_active changed from true to false.
    IF OLD.is_active = true AND NEW.is_active = false THEN
        -- Find the new active submission for the same assignment and student/group.
        IF OLD.assignment_group_id IS NOT NULL THEN
            SELECT id INTO new_active_submission_id
            FROM public.submissions
            WHERE assignment_id = OLD.assignment_id
              AND assignment_group_id = OLD.assignment_group_id
              AND is_active = true
              AND id != OLD.id
            ORDER BY id DESC
            LIMIT 1;
        ELSE
            SELECT id INTO new_active_submission_id
            FROM public.submissions
            WHERE assignment_id = OLD.assignment_id
              AND profile_id = OLD.profile_id
              AND assignment_group_id IS NULL
              AND is_active = true
              AND id != OLD.id
            ORDER BY id DESC
            LIMIT 1;
        END IF;

        IF new_active_submission_id IS NOT NULL THEN
            -- Capture the rubrics used by assignments that are being moved.
            SELECT COALESCE(array_agg(DISTINCT ra.rubric_id), '{}'::bigint[])
            INTO moved_rubric_ids
            FROM public.review_assignments ra
            WHERE ra.submission_id = OLD.id;

            -- Ensure a submission_reviews row exists for the new submission/rubric pairs.
            INSERT INTO public.submission_reviews (
                submission_id,
                rubric_id,
                class_id,
                name,
                total_score,
                total_autograde_score,
                tweak
            )
            SELECT
                new_active_submission_id,
                ra.rubric_id,
                ra.class_id,
                (SELECT name FROM public.rubrics WHERE id = ra.rubric_id),
                0,
                0,
                0
            FROM public.review_assignments ra
            WHERE ra.submission_id = OLD.id
            ON CONFLICT (submission_id, rubric_id) DO NOTHING;

            -- Delete any conflicting target assignments to avoid unique violations
            -- when moving old assignments over.
            DELETE FROM public.review_assignments ra_target
            WHERE ra_target.submission_id = new_active_submission_id
              AND EXISTS (
                  SELECT 1
                  FROM public.review_assignments ra_old
                  WHERE ra_old.submission_id = OLD.id
                    AND ra_old.assignee_profile_id = ra_target.assignee_profile_id
                    AND ra_old.rubric_id = ra_target.rubric_id
              );
            GET DIAGNOSTICS deleted_conflicting_assignments = ROW_COUNT;

            -- Move review assignments to the new active submission and reopen them.
            UPDATE public.review_assignments
            SET submission_id = new_active_submission_id,
                completed_at = NULL,
                completed_by = NULL
            WHERE submission_id = OLD.id;
            GET DIAGNOSTICS updated_assignments_count = ROW_COUNT;

            -- Point moved review assignments at the corresponding new submission_review rows.
            UPDATE public.review_assignments AS ra
            SET submission_review_id = sr.id
            FROM public.submission_reviews AS sr
            WHERE ra.submission_id = new_active_submission_id
              AND ra.rubric_id = ANY(moved_rubric_ids)
              AND sr.submission_id = new_active_submission_id
              AND sr.rubric_id = ra.rubric_id;
            GET DIAGNOSTICS updated_links_count = ROW_COUNT;

            -- Reopen the new submission_reviews for moved rubrics as well.
            IF array_length(moved_rubric_ids, 1) > 0 THEN
                UPDATE public.submission_reviews
                SET completed_at = NULL,
                    completed_by = NULL
                WHERE submission_id = new_active_submission_id
                  AND rubric_id = ANY(moved_rubric_ids);
                GET DIAGNOSTICS reset_submission_reviews_count = ROW_COUNT;
            END IF;

            -- Keep comments pinned to the old submission/submission_review.
            -- No comment tables are updated here by design.
            RAISE LOG 'Updated submission % -> %: deleted % conflicting assignments, moved % assignments, updated % submission_review links, reset % submission_reviews. Comments intentionally left on old submission.',
                OLD.id,
                new_active_submission_id,
                deleted_conflicting_assignments,
                updated_assignments_count,
                updated_links_count,
                reset_submission_reviews_count;
        ELSE
            RAISE LOG 'No new active submission found for deactivated submission_id %', OLD.id;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.update_review_assignments_on_submission_deactivation() IS
'Updates review_assignments to follow the newly active submission when a submission is deactivated.
Always reopens moved review assignments and related submission_reviews by clearing completion fields.
Does not move grading comments, file comments, or artifact comments; comments remain on the old submission.';
