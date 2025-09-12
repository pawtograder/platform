-- Migration: Fix cascade to also update submission_review_id after moving review_assignments
-- Context: When a submission is deactivated and review_assignments are moved to the new active submission,
--          also update review_assignments.submission_review_id to point to the existing submission_reviews
--          for the new submission and the same rubric.

CREATE OR REPLACE FUNCTION "public"."update_review_assignments_on_submission_deactivation"()
RETURNS "trigger"
LANGUAGE "plpgsql" SECURITY DEFINER
SET search_path TO public,pg_temp
AS $$
DECLARE
    new_active_submission_id bigint;
    updated_assignments_count integer;
    updated_links_count integer;
BEGIN
    -- Only proceed if is_active changed from true to false
    IF OLD.is_active = true AND NEW.is_active = false THEN
        -- Find the new active submission for the same assignment and student/group
        IF OLD.assignment_group_id IS NOT NULL THEN
            -- Group submission: find active submission for the same assignment_group_id
            SELECT id INTO new_active_submission_id
            FROM public.submissions
            WHERE assignment_id = OLD.assignment_id
              AND assignment_group_id = OLD.assignment_group_id
              AND is_active = true
              AND id != OLD.id
            LIMIT 1;
        ELSE
            -- Individual submission: find active submission for the same profile_id
            SELECT id INTO new_active_submission_id
            FROM public.submissions
            WHERE assignment_id = OLD.assignment_id
              AND profile_id = OLD.profile_id
              AND assignment_group_id IS NULL
              AND is_active = true
              AND id != OLD.id
            LIMIT 1;
        END IF;

        -- If we found a new active submission, update review assignments and their linked submission_review
        IF new_active_submission_id IS NOT NULL THEN
            -- Move review assignments to the new active submission
            UPDATE public.review_assignments
            SET submission_id = new_active_submission_id
            WHERE submission_id = OLD.id;

            GET DIAGNOSTICS updated_assignments_count = ROW_COUNT;

            -- Now update the submission_review_id to the matching submission_reviews row
            -- for the new submission and the same rubric. A row should already exist due to
            -- earlier logic that creates submission_reviews for active submissions.
            UPDATE public.review_assignments AS ra
            SET submission_review_id = sr.id
            FROM public.submission_reviews AS sr
            WHERE ra.submission_id = new_active_submission_id
              AND sr.submission_id = new_active_submission_id
              AND sr.rubric_id = ra.rubric_id;

            GET DIAGNOSTICS updated_links_count = ROW_COUNT;

            -- Log the updates for observability
            RAISE NOTICE 'Updated % review_assignments from submission_id % to %, and updated % submission_review links',
                updated_assignments_count, OLD.id, new_active_submission_id, updated_links_count;
        ELSE
            -- Log when no new active submission is found
            RAISE NOTICE 'No new active submission found for deactivated submission_id %', OLD.id;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION "public"."update_review_assignments_on_submission_deactivation"() IS 
'Updates review_assignments to point to the new active submission when a submission is deactivated (is_active changes from true to false), and also updates submission_review_id to the corresponding submission_reviews row for the new submission and rubric.';
