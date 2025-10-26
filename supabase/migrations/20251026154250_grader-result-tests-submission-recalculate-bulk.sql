-- Refactor grader_result_tests trigger from per-row to per-statement
-- This prevents redundant recalculations when inserting multiple test results for the same submission

-- Create a new statement-level trigger function that processes all affected submissions at once
CREATE OR REPLACE FUNCTION public.submissionreviewrecompute_bulk_grader_tests()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
declare
  submission_rec record;
  calculated_score numeric;
  calculated_autograde_score numeric;
  existing_submission_review_id int8;
  is_grading_review boolean;
  current_tweak numeric;
begin
  -- Loop through each unique submission_id that was affected by this statement
  FOR submission_rec IN 
    SELECT DISTINCT submission_id 
    FROM new_table 
    WHERE submission_id IS NOT NULL
  LOOP
    -- Get the grading_review_id for this submission
    SELECT grading_review_id 
    INTO existing_submission_review_id 
    FROM public.submissions 
    WHERE id = submission_rec.submission_id;
    
    -- Skip if no review exists
    IF existing_submission_review_id IS NULL THEN
      CONTINUE;
    END IF;
    
    -- CRITICAL: Add advisory lock to prevent race conditions during concurrent score updates
    -- This ensures only one trigger can update the same submission_review at a time
    PERFORM pg_advisory_xact_lock(existing_submission_review_id);

    -- Check if this is the grading review (connected to a grading review rubric)
    SELECT EXISTS(
      SELECT 1 
      FROM submissions 
      WHERE grading_review_id = existing_submission_review_id
    ) INTO is_grading_review;

    -- Only include autograde score if this is the grading review
    calculated_autograde_score = 0;
    IF is_grading_review THEN
      SELECT COALESCE(sum(t.score), 0) 
      INTO calculated_autograde_score 
      FROM grader_results r 
      INNER JOIN grader_result_tests t ON t.grader_result_id = r.id
      WHERE r.submission_id = submission_rec.submission_id;
    END IF;

    -- Calculate manual grading score from all comment types
    SELECT COALESCE(sum(score), 0) 
    INTO calculated_score 
    FROM (
      SELECT c.id, c.name,
        CASE
          WHEN c.is_additive THEN LEAST(COALESCE(sum(comments.points), 0), c.total_points)
          ELSE GREATEST(c.total_points - COALESCE(sum(comments.points), 0), 0)
        END AS score
      FROM public.submission_reviews sr
      INNER JOIN public.rubric_criteria c ON c.rubric_id = sr.rubric_id
      INNER JOIN public.rubric_checks ch ON ch.rubric_criteria_id = c.id
      LEFT JOIN (
        SELECT sum(sc.points) AS points, sc.rubric_check_id 
        FROM submission_comments sc 
        WHERE sc.submission_review_id = existing_submission_review_id 
          AND sc.deleted_at IS NULL 
          AND sc.points IS NOT NULL 
        GROUP BY sc.rubric_check_id
        UNION ALL
        SELECT sum(sfc.points) AS points, sfc.rubric_check_id 
        FROM submission_file_comments sfc 
        WHERE sfc.submission_review_id = existing_submission_review_id 
          AND sfc.deleted_at IS NULL 
          AND sfc.points IS NOT NULL 
        GROUP BY sfc.rubric_check_id
        UNION ALL
        SELECT sum(sac.points) AS points, sac.rubric_check_id 
        FROM submission_artifact_comments sac 
        WHERE sac.submission_review_id = existing_submission_review_id 
          AND sac.deleted_at IS NULL 
          AND sac.points IS NOT NULL 
        GROUP BY sac.rubric_check_id
      ) AS comments ON comments.rubric_check_id = ch.id
      WHERE sr.id = existing_submission_review_id 
      GROUP BY c.id
    ) AS combo;

    -- Get the current tweak value
    SELECT COALESCE(tweak, 0) 
    INTO current_tweak 
    FROM submission_reviews 
    WHERE id = existing_submission_review_id;

    -- Update the submission review with the calculated total score including tweak
    -- The advisory lock ensures this update is atomic and prevents lost updates
    UPDATE public.submission_reviews 
    SET total_score = calculated_score + calculated_autograde_score + current_tweak,
        total_autograde_score = calculated_autograde_score 
    WHERE id = existing_submission_review_id;
  END LOOP;

  RETURN NULL; -- Result is ignored for AFTER trigger
END;
$$;

-- Drop the old per-row trigger
DROP TRIGGER IF EXISTS grader_result_tests_recalculate_submission_review ON public.grader_result_tests;

-- Create separate per-statement triggers for INSERT and UPDATE
-- PostgreSQL requires separate triggers when using REFERENCING NEW TABLE with multiple events

CREATE TRIGGER grader_result_tests_recalculate_submission_review_insert
  AFTER INSERT ON public.grader_result_tests
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT 
  EXECUTE FUNCTION public.submissionreviewrecompute_bulk_grader_tests();

CREATE TRIGGER grader_result_tests_recalculate_submission_review_update
  AFTER UPDATE ON public.grader_result_tests
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT 
  EXECUTE FUNCTION public.submissionreviewrecompute_bulk_grader_tests();

-- Add comments
COMMENT ON FUNCTION public.submissionreviewrecompute_bulk_grader_tests() IS 
'Statement-level trigger function that recalculates submission review scores for all affected submissions in a single statement. This prevents redundant recalculations when inserting multiple test results.';

COMMENT ON TRIGGER grader_result_tests_recalculate_submission_review_insert ON public.grader_result_tests IS 
'Recalculates submission review scores after inserting test results. Runs once per statement rather than per row for better performance.';

COMMENT ON TRIGGER grader_result_tests_recalculate_submission_review_update ON public.grader_result_tests IS 
'Recalculates submission review scores after updating test results. Runs once per statement rather than per row for better performance.';


CREATE INDEX IF NOT EXISTS idx_help_requests_class_privacy_status
ON public.help_requests (class_id, is_private, status)
INCLUDE (id, assignee, created_by, help_queue);

-- Fix 2: Add index for assignee/creator lookups in RLS
CREATE INDEX IF NOT EXISTS idx_help_requests_class_assignee
ON public.help_requests (class_id, assignee)
WHERE assignee IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_help_requests_class_creator
ON public.help_requests (class_id, created_by)
WHERE created_by IS NOT NULL;


-- ============================================================================
-- OPTIMIZE HELP_REQUESTS SELECT POLICY
-- ============================================================================
DROP POLICY IF EXISTS "Students can view help requests in their class with creator acc" ON "public"."help_requests";

-- Create optimized policy that short-circuits for common cases
-- Avoids unnecessary joins to help_request_students for most queries
CREATE POLICY "Students can view help requests in their class with creator acc"
ON "public"."help_requests"
FOR SELECT
TO "authenticated"
USING (
  -- Path 1: Instructors/graders see all in their classes (most efficient, no further checks)
  EXISTS (
    SELECT 1
    FROM "public"."user_privileges" "up"
    WHERE "up"."user_id" = "auth"."uid"()
      AND "up"."class_id" = "help_requests"."class_id"
      AND "up"."role" IN ('instructor', 'grader', 'admin')
  )
  OR
  -- Path 2: Students see non-private requests in their classes
  (
    NOT "help_requests"."is_private"
    AND EXISTS (
      SELECT 1
      FROM "public"."user_privileges" "up"
      WHERE "up"."user_id" = "auth"."uid"()
        AND "up"."class_id" = "help_requests"."class_id"
        AND "up"."role" = 'student'
    )
  )
  OR
  -- Path 3: Students see private requests they created
  (
    "help_requests"."is_private"
    AND EXISTS (
      SELECT 1
      FROM "public"."user_privileges" "up"
      WHERE "up"."user_id" = "auth"."uid"()
        AND "up"."class_id" = "help_requests"."class_id"
        AND "up"."role" = 'student'
        AND "help_requests"."created_by" = "up"."private_profile_id"
    )
  )
  OR
  -- Path 4: Students see private requests they're members of (only checked as last resort)
  (
    "help_requests"."is_private"
    AND EXISTS (
      SELECT 1
      FROM "public"."user_privileges" "up"
      WHERE "up"."user_id" = "auth"."uid"()
        AND "up"."class_id" = "help_requests"."class_id"
        AND "up"."role" = 'student'
        AND EXISTS (
          SELECT 1
          FROM "public"."help_request_students" "hrs"
          WHERE "hrs"."help_request_id" = "help_requests"."id"
            AND "hrs"."profile_id" = "up"."private_profile_id"
        )
    )
  )
);