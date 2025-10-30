CREATE OR REPLACE FUNCTION "public"."update_review_assignments_on_submission_deactivation"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    new_active_submission_id bigint;
    deleted_conflicting_assignments integer;
    updated_assignments_count integer;
    updated_links_count integer;
    updated_submission_comments_count integer;
    updated_file_comments_count integer;
    updated_artifact_comments_count integer;
    rows_moved integer;
    sha_matches boolean;
    new_submission_sha text;
BEGIN
    -- Only proceed if is_active changed from true to false
    IF OLD.is_active = true AND NEW.is_active = false THEN
        -- Find the new active submission for the same assignment and student/group
        IF OLD.assignment_group_id IS NOT NULL THEN
            -- Group submission: find active submission for the same assignment_group_id
            SELECT id, sha INTO new_active_submission_id, new_submission_sha
            FROM public.submissions
            WHERE assignment_id = OLD.assignment_id
              AND assignment_group_id = OLD.assignment_group_id
              AND is_active = true
              AND id != OLD.id
              order by id desc
            LIMIT 1;
        ELSE
            -- Individual submission: find active submission for the same profile_id
            SELECT id, sha INTO new_active_submission_id, new_submission_sha
            FROM public.submissions
            WHERE assignment_id = OLD.assignment_id
              AND profile_id = OLD.profile_id
              AND assignment_group_id IS NULL
              AND is_active = true
              AND id != OLD.id
              order by id desc
            LIMIT 1;
        END IF;

        -- Determine if SHA matches between old and new submissions
        sha_matches := (new_submission_sha IS NOT NULL AND OLD.sha = new_submission_sha);

        -- If we found a new active submission, update review assignments and possibly comments
        IF new_active_submission_id IS NOT NULL THEN

            -- Ensure a submission_reviews row exists for the new submission/rubric pairs
            INSERT INTO public.submission_reviews (submission_id, rubric_id, class_id, name, total_score, total_autograde_score, tweak)
            SELECT new_active_submission_id, ra.rubric_id, ra.class_id,
                   (SELECT name FROM public.rubrics WHERE id = ra.rubric_id), 0, 0, 0
            FROM public.review_assignments ra
            WHERE ra.submission_id = OLD.id
            ON CONFLICT (submission_id, rubric_id) DO NOTHING;

            -- Delete any conflicting review_assignments on the target submission to avoid
            -- unique constraint violations on (assignee_profile_id, submission_review_id)
            -- when we move the old review_assignments over
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

            -- Move review assignments to the new active submission
            -- If SHA matches AND old review was completed, preserve completion status
            -- Otherwise, reset completion status
            UPDATE public.review_assignments ra_update
            SET submission_id = new_active_submission_id,
                completed_at = CASE 
                    WHEN sha_matches AND ra_old.completed_at IS NOT NULL THEN ra_old.completed_at
                    ELSE NULL
                END,
                completed_by = CASE 
                    WHEN sha_matches AND ra_old.completed_by IS NOT NULL THEN ra_old.completed_by
                    ELSE NULL
                END
            FROM public.review_assignments ra_old
            WHERE ra_update.id = ra_old.id 
              AND ra_old.submission_id = OLD.id;

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

            -- If SHA matches AND old submission_review was completed, copy completion status to new submission_review
            IF sha_matches THEN
                UPDATE public.submission_reviews sr_new
                SET completed_at = sr_old.completed_at,
                    completed_by = sr_old.completed_by
                FROM public.submission_reviews sr_old
                WHERE sr_new.submission_id = new_active_submission_id
                  AND sr_old.submission_id = OLD.id
                  AND sr_new.rubric_id = sr_old.rubric_id
                  AND sr_old.completed_at IS NOT NULL;
            END IF;

            -- Only move comments if SHA matches (same submission content being regraded)
            IF sha_matches THEN
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
                  AND sc.submission_review_id = sr_old.id;

                GET DIAGNOSTICS updated_submission_comments_count = ROW_COUNT;

                -- Move submission_comments that do NOT have a submission_review_id
                UPDATE public.submission_comments
                SET submission_id = new_active_submission_id
                WHERE submission_id = OLD.id
                  AND submission_review_id IS NULL;

                GET DIAGNOSTICS rows_moved = ROW_COUNT;
                updated_submission_comments_count := updated_submission_comments_count + rows_moved;

                -- Move submission_file_comments that have a submission_review_id
                UPDATE public.submission_file_comments sfc
                SET 
                    submission_id = new_active_submission_id,
                    submission_review_id = sr_new.id,
                    submission_file_id = sf_new.id
                FROM public.submission_reviews sr_old
                INNER JOIN public.submission_reviews sr_new 
                    ON sr_new.submission_id = new_active_submission_id 
                    AND sr_new.rubric_id = sr_old.rubric_id
                INNER JOIN public.submission_files sf_old
                    ON sf_old.submission_id = OLD.id
                INNER JOIN public.submission_files sf_new
                    ON sf_new.submission_id = new_active_submission_id
                    AND sf_new.name = sf_old.name
                WHERE sfc.submission_id = OLD.id
                  AND sfc.submission_review_id = sr_old.id
                  AND sfc.submission_file_id = sf_old.id;

                GET DIAGNOSTICS updated_file_comments_count = ROW_COUNT;

                -- Move submission_file_comments that do NOT have a submission_review_id
                UPDATE public.submission_file_comments sfc
                SET submission_id = new_active_submission_id,
                    submission_file_id = sf_new.id
                FROM public.submission_files sf_old
                INNER JOIN public.submission_files sf_new
                    ON sf_new.submission_id = new_active_submission_id
                    AND sf_new.name = sf_old.name
                WHERE sfc.submission_id = OLD.id
                  AND sfc.submission_review_id IS NULL
                  AND sfc.submission_file_id = sf_old.id
                  AND sf_old.submission_id = OLD.id;

                GET DIAGNOSTICS rows_moved = ROW_COUNT;
                updated_file_comments_count := updated_file_comments_count + rows_moved;

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
                  AND sac.submission_review_id = sr_old.id;

                GET DIAGNOSTICS updated_artifact_comments_count = ROW_COUNT;

                -- Move submission_artifact_comments that do NOT have a submission_review_id
                UPDATE public.submission_artifact_comments
                SET submission_id = new_active_submission_id
                WHERE submission_id = OLD.id
                  AND submission_review_id IS NULL;

                GET DIAGNOSTICS rows_moved = ROW_COUNT;
                updated_artifact_comments_count := updated_artifact_comments_count + rows_moved;

                -- Log the updates for observability
                RAISE LOG 'SHA matches: Deleted % conflicting assignments, updated % review_assignments, % submission_review links, % submission_comments, % file_comments, % artifact_comments from submission_id % to %',
                    deleted_conflicting_assignments, updated_assignments_count, updated_links_count, updated_submission_comments_count, 
                    updated_file_comments_count, updated_artifact_comments_count, OLD.id, new_active_submission_id;
            ELSE
                -- SHA doesn't match: only update review assignments, not comments
                updated_submission_comments_count := 0;
                updated_file_comments_count := 0;
                updated_artifact_comments_count := 0;
                
                RAISE LOG 'SHA differs: Deleted % conflicting assignments, updated % review_assignments, % submission_review links (no comments moved) from submission_id % to %',
                    deleted_conflicting_assignments, updated_assignments_count, updated_links_count, OLD.id, new_active_submission_id;
            END IF;
        ELSE
            -- Log when no new active submission is found
            RAISE LOG 'No new active submission found for deactivated submission_id %', OLD.id;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION "public"."update_review_assignments_on_submission_deactivation"() IS 'Updates review_assignments to point to the new active submission when a submission is deactivated (is_active changes from true to false). Behavior depends on whether the SHA changed:
- If SHA matches (same content being regraded): moves review assignments AND all comments (submission_comments, submission_file_comments, submission_artifact_comments). If old review was completed, preserves completion status on both review_assignments and submission_reviews.
- If SHA differs (new submission replacing old): moves review assignments only, NOT comments. Resets completion status on review_assignments but does not update submission_reviews completion.
This ensures that comments follow submissions only when the same content is being regraded, and review assignments always follow to the new active submission.';

ALTER TABLE "public"."gradebook_column_students" 
  ALTER COLUMN "is_droppable" SET DEFAULT true;
