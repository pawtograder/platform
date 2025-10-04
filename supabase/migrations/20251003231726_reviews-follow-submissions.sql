-- Migration: Enhanced trigger to move review assignments AND comments when submissions become inactive
-- Also includes backfill for existing orphaned comments

-- Step 1: Update the trigger function to also move comments
CREATE OR REPLACE FUNCTION "public"."update_review_assignments_on_submission_deactivation"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    new_active_submission_id bigint;
    updated_assignments_count integer;
    updated_links_count integer;
    updated_submission_comments_count integer;
    updated_file_comments_count integer;
    updated_artifact_comments_count integer;
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

        -- If we found a new active submission, update review assignments and comments
        IF new_active_submission_id IS NOT NULL THEN

            -- Ensure a submission_reviews row exists for the new submission/rubric pairs
            INSERT INTO public.submission_reviews (submission_id, rubric_id, class_id, name, total_score, total_autograde_score, tweak)
            SELECT new_active_submission_id, ra.rubric_id, ra.class_id,
                   (SELECT name FROM public.rubrics WHERE id = ra.rubric_id), 0, 0, 0
            FROM public.review_assignments ra
            WHERE ra.submission_id = OLD.id
            ON CONFLICT (submission_id, rubric_id) DO NOTHING;

            -- Move review assignments to the new active submission and reset completion status
            UPDATE public.review_assignments
            SET submission_id = new_active_submission_id,
                completed_at = NULL,
                completed_by = NULL
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

            -- Move submission_comments that have a submission_review_id
            UPDATE public.submission_comments sc
            SET 
                submission_id = new_active_submission_id,
                submission_review_id = sr_new.id
            FROM public.submission_reviews sr_old
            INNER JOIN public.submission_reviews sr_new 
                ON sr_new.submission_id = new_active_submission_id 
                AND sr_new.rubric_id = sr_old.rubric_id
            WHERE sc.submission_id = OLD.id
              AND sc.submission_review_id = sr_old.id
              AND sc.submission_review_id IS NOT NULL;

            GET DIAGNOSTICS updated_submission_comments_count = ROW_COUNT;

            -- Move submission_file_comments that have a submission_review_id
            UPDATE public.submission_file_comments sfc
            SET 
                submission_id = new_active_submission_id,
                submission_review_id = sr_new.id
            FROM public.submission_reviews sr_old
            INNER JOIN public.submission_reviews sr_new 
                ON sr_new.submission_id = new_active_submission_id 
                AND sr_new.rubric_id = sr_old.rubric_id
            WHERE sfc.submission_id = OLD.id
              AND sfc.submission_review_id = sr_old.id
              AND sfc.submission_review_id IS NOT NULL;

            GET DIAGNOSTICS updated_file_comments_count = ROW_COUNT;

            -- Move submission_artifact_comments that have a submission_review_id
            UPDATE public.submission_artifact_comments sac
            SET 
                submission_id = new_active_submission_id,
                submission_review_id = sr_new.id
            FROM public.submission_reviews sr_old
            INNER JOIN public.submission_reviews sr_new 
                ON sr_new.submission_id = new_active_submission_id 
                AND sr_new.rubric_id = sr_old.rubric_id
            WHERE sac.submission_id = OLD.id
              AND sac.submission_review_id = sr_old.id
              AND sac.submission_review_id IS NOT NULL;

            GET DIAGNOSTICS updated_artifact_comments_count = ROW_COUNT;

            -- Log the updates for observability
            RAISE NOTICE 'Updated % review_assignments, % submission_review links, % submission_comments, % file_comments, % artifact_comments from submission_id % to %',
                updated_assignments_count, updated_links_count, updated_submission_comments_count, 
                updated_file_comments_count, updated_artifact_comments_count, OLD.id, new_active_submission_id;
        ELSE
            -- Log when no new active submission is found
            RAISE NOTICE 'No new active submission found for deactivated submission_id %', OLD.id;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION "public"."update_review_assignments_on_submission_deactivation"() IS 'Updates review_assignments and all submission comments (submission_comments, submission_file_comments, submission_artifact_comments) to point to the new active submission when a submission is deactivated (is_active changes from true to false). Resets completion status on review assignments and updates submission_review_id to the corresponding submission_reviews row for the new submission and rubric.';

-- For manual ops as needed: Backfill existing orphaned comments
-- Find comments that are attached to non-active submissions and move them to active submissions
-- Consider filtering to only the assignment_id that we care about!

-- DO $$
-- DECLARE
--     backfill_submission_comments integer := 0;
--     backfill_file_comments integer := 0;
--     backfill_artifact_comments integer := 0;
-- BEGIN
--     RAISE NOTICE 'Starting backfill of orphaned comments on inactive submissions...';

--     -- Backfill submission_comments
--     WITH orphaned_comments AS (
--         SELECT 
--             sc.id as comment_id,
--             s_old.id as old_submission_id,
--             s_new.id as new_submission_id,
--             sr_old.id as old_review_id,
--             sr_new.id as new_review_id
--         FROM public.submission_comments sc
--         INNER JOIN public.submissions s_old ON s_old.id = sc.submission_id
--         INNER JOIN public.submission_reviews sr_old ON sr_old.id = sc.submission_review_id
--         -- Find the corresponding active submission
--         INNER JOIN public.submissions s_new ON (
--             s_new.assignment_id = s_old.assignment_id
--             AND s_new.is_active = true
--             AND (
--                 -- Individual submission match
--                 (s_old.assignment_group_id IS NULL AND s_new.profile_id = s_old.profile_id AND s_new.assignment_group_id IS NULL)
--                 OR
--                 -- Group submission match
--                 (s_old.assignment_group_id IS NOT NULL AND s_new.assignment_group_id = s_old.assignment_group_id)
--             )
--         )
--         -- Find the corresponding submission_review on the new submission
--         INNER JOIN public.submission_reviews sr_new ON (
--             sr_new.submission_id = s_new.id
--             AND sr_new.rubric_id = sr_old.rubric_id
--         )
--         WHERE s_old.is_active = false
--           AND sc.submission_review_id IS NOT NULL
--     )
--     UPDATE public.submission_comments sc
--     SET 
--         submission_id = oc.new_submission_id,
--         submission_review_id = oc.new_review_id
--     FROM orphaned_comments oc
--     WHERE sc.id = oc.comment_id;

--     GET DIAGNOSTICS backfill_submission_comments = ROW_COUNT;

--     -- Backfill submission_file_comments
--     WITH orphaned_comments AS (
--         SELECT 
--             sfc.id as comment_id,
--             s_old.id as old_submission_id,
--             s_new.id as new_submission_id,
--             sr_old.id as old_review_id,
--             sr_new.id as new_review_id
--         FROM public.submission_file_comments sfc
--         INNER JOIN public.submissions s_old ON s_old.id = sfc.submission_id
--         INNER JOIN public.submission_reviews sr_old ON sr_old.id = sfc.submission_review_id
--         -- Find the corresponding active submission
--         INNER JOIN public.submissions s_new ON (
--             s_new.assignment_id = s_old.assignment_id
--             AND s_new.is_active = true
--             AND (
--                 -- Individual submission match
--                 (s_old.assignment_group_id IS NULL AND s_new.profile_id = s_old.profile_id AND s_new.assignment_group_id IS NULL)
--                 OR
--                 -- Group submission match
--                 (s_old.assignment_group_id IS NOT NULL AND s_new.assignment_group_id = s_old.assignment_group_id)
--             )
--         )
--         -- Find the corresponding submission_review on the new submission
--         INNER JOIN public.submission_reviews sr_new ON (
--             sr_new.submission_id = s_new.id
--             AND sr_new.rubric_id = sr_old.rubric_id
--         )
--         WHERE s_old.is_active = false
--           AND sfc.submission_review_id IS NOT NULL
--     )
--     UPDATE public.submission_file_comments sfc
--     SET 
--         submission_id = oc.new_submission_id,
--         submission_review_id = oc.new_review_id
--     FROM orphaned_comments oc
--     WHERE sfc.id = oc.comment_id;

--     GET DIAGNOSTICS backfill_file_comments = ROW_COUNT;

--     -- Backfill submission_artifact_comments
--     WITH orphaned_comments AS (
--         SELECT 
--             sac.id as comment_id,
--             s_old.id as old_submission_id,
--             s_new.id as new_submission_id,
--             sr_old.id as old_review_id,
--             sr_new.id as new_review_id
--         FROM public.submission_artifact_comments sac
--         INNER JOIN public.submissions s_old ON s_old.id = sac.submission_id
--         INNER JOIN public.submission_reviews sr_old ON sr_old.id = sac.submission_review_id
--         -- Find the corresponding active submission
--         INNER JOIN public.submissions s_new ON (
--             s_new.assignment_id = s_old.assignment_id
--             AND s_new.is_active = true
--             AND (
--                 -- Individual submission match
--                 (s_old.assignment_group_id IS NULL AND s_new.profile_id = s_old.profile_id AND s_new.assignment_group_id IS NULL)
--                 OR
--                 -- Group submission match
--                 (s_old.assignment_group_id IS NOT NULL AND s_new.assignment_group_id = s_old.assignment_group_id)
--             )
--         )
--         -- Find the corresponding submission_review on the new submission
--         INNER JOIN public.submission_reviews sr_new ON (
--             sr_new.submission_id = s_new.id
--             AND sr_new.rubric_id = sr_old.rubric_id
--         )
--         WHERE s_old.is_active = false
--           AND sac.submission_review_id IS NOT NULL
--     )
--     UPDATE public.submission_artifact_comments sac
--     SET 
--         submission_id = oc.new_submission_id,
--         submission_review_id = oc.new_review_id
--     FROM orphaned_comments oc
--     WHERE sac.id = oc.comment_id;

--     GET DIAGNOSTICS backfill_artifact_comments = ROW_COUNT;

--     RAISE NOTICE 'Backfill complete: moved % submission_comments, % file_comments, % artifact_comments to active submissions',
--         backfill_submission_comments, backfill_file_comments, backfill_artifact_comments;
-- END $$;

