-- Add cap_score_to_assignment_points column to rubrics table
ALTER TABLE rubrics ADD COLUMN cap_score_to_assignment_points boolean NOT NULL DEFAULT false;

-- Update submissionreviewrecompute() function to handle score capping
CREATE OR REPLACE FUNCTION public.submissionreviewrecompute()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$declare
  calculated_score numeric;
  calculated_autograde_score numeric;
  the_submission submissions%ROWTYPE;
  existing_submission_review_id int8;
  is_grading_review boolean;
  should_cap boolean;
  assignment_total_points numeric;
  current_tweak numeric;
begin
  calculated_score=0;
  calculated_autograde_score=0;
  
  -- Avoid re-entrant work when our own UPDATEs fire triggers
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;
  
  if 'rubric_check_id' = any(select jsonb_object_keys(to_jsonb(new))) then 
    if  NEW.rubric_check_id is null and (OLD is null OR OLD.rubric_check_id is null) then 
     return NEW;
    end if;
  end if;

  if 'submission_review_id' = any(select jsonb_object_keys(to_jsonb(new))) then 
    -- If the field is there but null, we don't have anything to update.
    if NEW.submission_review_id is null then
      return NEW;
    end if;
    -- The submission review we are calculating is the one on the row
    existing_submission_review_id = NEW.submission_review_id;
  else
    -- The submission review we are calculating is the one on the assignment, make sure it exists
    select grading_review_id into existing_submission_review_id from public.submissions where id=NEW.submission_id;
  end if;

  -- CRITICAL: Add advisory lock to prevent race conditions during concurrent score updates
  -- This ensures only one trigger can update the same submission_review at a time
  -- Skip advisory lock if no submission review ID is available
  IF existing_submission_review_id IS NULL THEN
    RETURN NEW;
  END IF;
  
  perform pg_advisory_xact_lock(existing_submission_review_id);

  -- Check if this is the grading review (connected to a grading review rubric)
  -- Code-walk rubrics and other review types should NOT include autograde scores
  select EXISTS(select 1 from submissions where grading_review_id = existing_submission_review_id) into is_grading_review;

  -- Only include autograde score if this is the grading review
  if is_grading_review then
    select sum(t.score) into calculated_autograde_score from grader_results r 
      inner join grader_result_tests t on t.grader_result_id=r.id
      where r.submission_id=NEW.submission_id;
  end if;

select sum(score) into calculated_score from (
  select c.id,c.name,
  case
    when c.is_deduction_only then GREATEST(-COALESCE(sum(comments.points),0), -c.total_points)
    when c.is_additive then LEAST(COALESCE(sum(comments.points),0),c.total_points)
    else GREATEST(c.total_points - COALESCE(sum(comments.points),0), 0)
    end as score
  from public.submission_reviews sr
  inner join public.rubric_criteria c on c.rubric_id=sr.rubric_id
  inner join public.rubric_checks ch on ch.rubric_criteria_id=c.id
    left join (select sum(sc.points) as points,sc.rubric_check_id from submission_comments sc where sc.submission_review_id=existing_submission_review_id and sc.deleted_at is null and sc.points is not null group by sc.rubric_check_id
    UNION ALL
    select sum(sfc.points) as points,sfc.rubric_check_id from submission_file_comments sfc where sfc.submission_review_id=existing_submission_review_id and sfc.deleted_at is null and sfc.points is not null group by sfc.rubric_check_id
    UNION all
    select sum(sac.points) as points,sac.rubric_check_id from submission_artifact_comments sac where sac.submission_review_id=existing_submission_review_id and sac.deleted_at is null and sac.points is not null group by sac.rubric_check_id
    ) as comments on comments.rubric_check_id=ch.id
  where sr.id=existing_submission_review_id 
   group by c.id) as combo;

  if calculated_score is null then
    calculated_score = 0;
  end if;
  if calculated_autograde_score is null then
    calculated_autograde_score = 0;
  end if;

  -- Get the current tweak value
  SELECT COALESCE(tweak, 0) 
  INTO current_tweak 
  FROM submission_reviews 
  WHERE id = existing_submission_review_id;

  -- Check if score capping is enabled for this rubric
  SELECT r.cap_score_to_assignment_points INTO should_cap
  FROM public.rubrics r
  INNER JOIN public.submission_reviews sr ON sr.rubric_id = r.id
  WHERE sr.id = existing_submission_review_id;

  -- Calculate total score including tweak
  calculated_score = calculated_score + calculated_autograde_score + current_tweak;

  -- Apply capping if enabled
  IF should_cap THEN
    -- Look up assignment's total_points via submission
    SELECT a.total_points INTO assignment_total_points
    FROM public.assignments a
    INNER JOIN public.submissions s ON s.assignment_id = a.id
    WHERE s.id = NEW.submission_id;
    
    IF assignment_total_points IS NOT NULL THEN
      calculated_score = LEAST(calculated_score, assignment_total_points);
    END IF;
  END IF;

  UPDATE public.submission_reviews SET total_score=calculated_score,total_autograde_score=calculated_autograde_score WHERE id=existing_submission_review_id;

  return NEW;
end;$function$
;

-- Update submissionreviewrecompute_bulk_grader_tests() function to handle deduction_only and score capping
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
  should_cap boolean;
  assignment_total_points numeric;
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
    -- Updated to include is_deduction_only support
    SELECT COALESCE(sum(score), 0) 
    INTO calculated_score 
    FROM (
      SELECT c.id, c.name,
        CASE
          WHEN c.is_deduction_only THEN GREATEST(-COALESCE(sum(comments.points), 0), -c.total_points)
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

    -- Check if score capping is enabled for this rubric
    SELECT r.cap_score_to_assignment_points INTO should_cap
    FROM public.rubrics r
    INNER JOIN public.submission_reviews sr ON sr.rubric_id = r.id
    WHERE sr.id = existing_submission_review_id;

    -- Calculate total score including tweak
    calculated_score = calculated_score + calculated_autograde_score + current_tweak;

    -- Apply capping if enabled
    IF should_cap THEN
      -- Look up assignment's total_points via submission
      SELECT a.total_points INTO assignment_total_points
      FROM public.assignments a
      INNER JOIN public.submissions s ON s.assignment_id = a.id
      WHERE s.id = submission_rec.submission_id;
      
      IF assignment_total_points IS NOT NULL THEN
        calculated_score = LEAST(calculated_score, assignment_total_points);
      END IF;
    END IF;

    -- Update the submission review with the calculated total score
    -- The advisory lock ensures this update is atomic and prevents lost updates
    UPDATE public.submission_reviews 
    SET total_score = calculated_score,
        total_autograde_score = calculated_autograde_score 
    WHERE id = existing_submission_review_id;
  END LOOP;

  RETURN NULL; -- Result is ignored for AFTER trigger
END;
$$;

-- Grant execute permissions on the updated functions
GRANT EXECUTE ON FUNCTION "public"."submissionreviewrecompute"() TO authenticated;
GRANT EXECUTE ON FUNCTION "public"."submissionreviewrecompute"() TO service_role;

-- Add comments for the updated functionality
COMMENT ON FUNCTION "public"."submissionreviewrecompute" IS 
'Recalculates submission review total scores including manual grading (with support for additive, subtractive, and deduction-only scoring modes), autograde (only for grading reviews), instructor tweaks, and optional score capping. Uses advisory locks to prevent race conditions.';

COMMENT ON FUNCTION public.submissionreviewrecompute_bulk_grader_tests() IS 
'Statement-level trigger function that recalculates submission review scores for all affected submissions in a single statement. Supports additive, subtractive, and deduction-only scoring modes, and optional score capping. This prevents redundant recalculations when inserting multiple test results.';

-- Add rerun metadata to repository_check_runs
ALTER TABLE public.repository_check_runs
  ADD COLUMN IF NOT EXISTS is_regression_rerun boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS target_submission_id bigint,
  ADD COLUMN IF NOT EXISTS requested_grader_sha text,
  ADD COLUMN IF NOT EXISTS auto_promote_result boolean DEFAULT false;

ALTER TABLE public.repository_check_runs
  ADD CONSTRAINT repository_check_runs_target_submission_id_fkey
  FOREIGN KEY (target_submission_id) REFERENCES public.submissions(id);

-- Add rerun reference to grader_results
ALTER TABLE public.grader_results
  ADD COLUMN IF NOT EXISTS rerun_for_submission_id bigint;

ALTER TABLE public.grader_results
  ADD CONSTRAINT grader_results_rerun_for_submission_id_fkey
  FOREIGN KEY (rerun_for_submission_id) REFERENCES public.submissions(id);

CREATE INDEX IF NOT EXISTS idx_grader_results_rerun_for_submission_id
  ON public.grader_results (rerun_for_submission_id);

-- Replace enqueue_autograder_reruns with new parameters
DROP FUNCTION IF EXISTS public.enqueue_autograder_reruns(bigint[], bigint);

CREATE OR REPLACE FUNCTION public.enqueue_autograder_reruns(
  p_submission_ids bigint[],
  p_class_id bigint,
  p_grader_sha text DEFAULT NULL,
  p_auto_promote boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_submission RECORD;
  v_user_role TEXT;
  v_enqueued_count INTEGER := 0;
  v_failed_count INTEGER := 0;
  v_skipped_count INTEGER := 0;
  v_failed_submissions jsonb := '[]'::jsonb;
  v_skipped_submissions jsonb := '[]'::jsonb;
  v_envelope jsonb;
  v_log_id bigint;
  v_repo_pending timestamptz;
  v_user_id uuid;
BEGIN
  -- Get the current user from auth context
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'User not authenticated'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Verify user has instructor or grader role for this class
  SELECT role INTO v_user_role
  FROM public.user_roles
  WHERE user_id = v_user_id
    AND class_id = p_class_id
    AND role IN ('instructor', 'grader')
    AND disabled = false
  LIMIT 1;

  IF v_user_role IS NULL THEN
    RAISE EXCEPTION 'User does not have permission to rerun autograder for this class'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Get the private_profile_id for the triggered_by field
  DECLARE
    v_private_profile_id TEXT;
  BEGIN
    SELECT private_profile_id INTO v_private_profile_id
    FROM public.user_roles
    WHERE user_id = v_user_id
      AND class_id = p_class_id
      AND role IN ('instructor', 'grader')
      AND disabled = false
    LIMIT 1;

    IF v_private_profile_id IS NULL THEN
      RAISE EXCEPTION 'Could not find private profile for user'
        USING ERRCODE = 'data_exception';
    END IF;

    -- Process each submission
    FOR v_submission IN
      SELECT
        s.id,
        s.repository,
        s.sha,
        s.repository_check_run_id,
        s.class_id,
        s.repository_id
      FROM public.submissions s
      WHERE s.id = ANY(p_submission_ids)
        AND s.class_id = p_class_id
        AND s.repository_check_run_id IS NOT NULL
    LOOP
      BEGIN
        -- Atomically set the rerun_queued_at timestamp only if not already set
        -- This prevents race conditions where multiple requests try to enqueue the same repo
        UPDATE public.repositories
        SET rerun_queued_at = NOW()
        WHERE id = v_submission.repository_id
          AND rerun_queued_at IS NULL;

        -- If no row was updated, another process already set the timestamp
        IF NOT FOUND THEN
          -- Get the existing queued_at timestamp for the skip message
          SELECT rerun_queued_at INTO v_repo_pending
          FROM public.repositories
          WHERE id = v_submission.repository_id;

          -- Skip this submission - already has a pending rerun
          v_skipped_count := v_skipped_count + 1;
          v_skipped_submissions := v_skipped_submissions || jsonb_build_object(
            'submission_id', v_submission.id,
            'repository', v_submission.repository,
            'reason', 'pending_rerun',
            'queued_at', v_repo_pending
          );
          CONTINUE;
        END IF;

        -- Create log entry for metrics tracking
        INSERT INTO public.api_gateway_calls (method, status_code, class_id)
        VALUES ('rerun_autograder'::public.github_async_method, 0, v_submission.class_id)
        RETURNING id INTO v_log_id;

        -- Build the envelope for the async worker
        v_envelope := jsonb_build_object(
          'method', 'rerun_autograder',
          'args', jsonb_build_object(
            'submission_id', v_submission.id,
            'repository', v_submission.repository,
            'sha', v_submission.sha,
            'repository_check_run_id', v_submission.repository_check_run_id,
            'triggered_by', v_private_profile_id,
            'repository_id', v_submission.repository_id,
            'grader_sha', p_grader_sha,
            'auto_promote', p_auto_promote,
            'target_submission_id', v_submission.id
          ),
          'class_id', v_submission.class_id,
          'log_id', v_log_id,
          'retry_count', 0
        );

        -- Enqueue the message
        PERFORM pgmq_public.send(
          queue_name := 'async_calls',
          message := v_envelope,
          sleep_seconds := 0
        );

        v_enqueued_count := v_enqueued_count + 1;

      EXCEPTION WHEN OTHERS THEN
        -- Clear the rerun_queued_at timestamp since the operation failed
        -- This prevents the repo from being stuck in a pending state
        BEGIN
          UPDATE public.repositories
          SET rerun_queued_at = NULL
          WHERE id = v_submission.repository_id;
        EXCEPTION WHEN OTHERS THEN
          -- If cleanup fails, log it but don't prevent error recording
          -- The timestamp will eventually need manual cleanup
          NULL;
        END;

        -- Record the failure
        v_failed_count := v_failed_count + 1;
        v_failed_submissions := v_failed_submissions || jsonb_build_object(
          'submission_id', v_submission.id,
          'error', SQLERRM
        );
      END;
    END LOOP;
  END;

  -- Return summary
  RETURN jsonb_build_object(
    'enqueued_count', v_enqueued_count,
    'failed_count', v_failed_count,
    'skipped_count', v_skipped_count,
    'failed_submissions', v_failed_submissions,
    'skipped_submissions', v_skipped_submissions,
    'total_requested', array_length(p_submission_ids, 1)
  );
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION public.enqueue_autograder_reruns(bigint[], bigint, text, boolean) TO authenticated;

COMMENT ON FUNCTION public.enqueue_autograder_reruns IS
'Enqueues autograder rerun requests for processing by the github-async-worker.
Uses auth.uid() to get the current user and validates they have instructor or grader permissions.
Returns a summary of enqueued and failed requests.';

-- Promote what-if grader result to official
CREATE OR REPLACE FUNCTION public.promote_whatif_grader_result(
  p_grader_result_id bigint,
  p_class_id bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_user_role TEXT;
  v_target_submission_id bigint;
  v_existing_official_id bigint;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'User not authenticated'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT role INTO v_user_role
  FROM public.user_roles
  WHERE user_id = v_user_id
    AND class_id = p_class_id
    AND role IN ('instructor', 'grader')
    AND disabled = false
  LIMIT 1;

  IF v_user_role IS NULL THEN
    RAISE EXCEPTION 'User does not have permission to promote grader results for this class'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT rerun_for_submission_id
    INTO v_target_submission_id
  FROM public.grader_results
  WHERE id = p_grader_result_id
    AND class_id = p_class_id
  FOR UPDATE;

  IF v_target_submission_id IS NULL THEN
    RAISE EXCEPTION 'Grader result is not promotable'
      USING ERRCODE = 'data_exception';
  END IF;

  -- Remove existing official grader result if present
  SELECT id INTO v_existing_official_id
  FROM public.grader_results
  WHERE submission_id = v_target_submission_id
    AND id <> p_grader_result_id
  LIMIT 1;

  IF v_existing_official_id IS NOT NULL THEN
    DELETE FROM public.grader_result_tests
    WHERE grader_result_id = v_existing_official_id;

    DELETE FROM public.grader_results
    WHERE id = v_existing_official_id;

    DELETE FROM public.submission_artifacts
    WHERE submission_id = v_target_submission_id
      AND autograder_regression_test_id IS NULL;
  END IF;

  UPDATE public.grader_results
  SET submission_id = v_target_submission_id,
      rerun_for_submission_id = NULL
  WHERE id = p_grader_result_id;

  RETURN jsonb_build_object(
    'promoted', true,
    'submission_id', v_target_submission_id,
    'grader_result_id', p_grader_result_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.promote_whatif_grader_result(bigint, bigint) TO authenticated;

-- Update view to include latest what-if rerun results
DROP VIEW IF EXISTS "public"."submissions_with_grades_for_assignment_and_regression_test";
CREATE VIEW "public"."submissions_with_grades_for_assignment_and_regression_test" WITH ("security_invoker"='true') AS
 SELECT "activesubmissionsbystudent"."id",
    "activesubmissionsbystudent"."class_id",
    "activesubmissionsbystudent"."assignment_id",
    "p"."name",
    "p"."sortable_name",
    "s"."id" AS "activesubmissionid",
    "s"."created_at",
    "s"."released",
    "s"."repository",
    "s"."sha",
    "rev"."total_autograde_score" AS "autograder_score",
    "ag"."name" AS "groupname",
    "ar"."grader_sha",
    "ar"."grader_action_sha",
    "ar_rt"."score" AS "rt_autograder_score",
    "ar_rt"."grader_sha" AS "rt_grader_sha",
    "ar_rt"."grader_action_sha" AS "rt_grader_action_sha",
    "ar_whatif"."id" AS "whatif_grader_result_id",
    "ar_whatif"."score" AS "whatif_autograder_score",
    "ar_whatif"."grader_sha" AS "whatif_grader_sha",
    "ar_whatif"."grader_action_sha" AS "whatif_grader_action_sha",
    "activesubmissionsbystudent"."effective_due_date",
    "activesubmissionsbystudent"."late_due_date",
    "activesubmissionsbystudent"."class_section_id",
    "cs"."name" AS "class_section_name",
    "activesubmissionsbystudent"."lab_section_id",
    "ls"."name" AS "lab_section_name",
    "repo"."rerun_queued_at"
   FROM (((((((((((
        SELECT "r"."id",
            CASE
                WHEN ("isub"."id" IS NULL) THEN "gsub"."id"
                ELSE "isub"."id"
            END AS "sub_id",
            "r"."private_profile_id",
            "r"."class_id",
            "a"."id" AS "assignment_id",
            "agm"."assignment_group_id" AS "assignmentgroupid",
            "a"."due_date",
            "public"."calculate_effective_due_date"("a"."id", "r"."private_profile_id") AS "effective_due_date",
            "public"."calculate_final_due_date"("a"."id", "r"."private_profile_id", "agm"."assignment_group_id") AS "late_due_date",
            "r"."class_section_id",
            "r"."lab_section_id"
        FROM ((((("public"."user_roles" "r"
            JOIN "public"."assignments" "a" ON (("a"."class_id" = "r"."class_id")))
            LEFT JOIN "public"."submissions" "isub" ON ((("isub"."profile_id" = "r"."private_profile_id") AND ("isub"."is_active" = true) AND ("isub"."assignment_id" = "a"."id") AND ("isub"."class_id" = "r"."class_id"))))
            LEFT JOIN "public"."assignment_groups_members" "agm" ON ((("agm"."profile_id" = "r"."private_profile_id") AND ("agm"."assignment_id" = "a"."id"))))
            LEFT JOIN ( SELECT "sum"("assignment_due_date_exceptions"."tokens_consumed") AS "tokens_consumed",
                "sum"("assignment_due_date_exceptions"."hours") AS "hours",
                "assignment_due_date_exceptions"."student_id",
                "assignment_due_date_exceptions"."assignment_group_id",
                "assignment_due_date_exceptions"."assignment_id"
                FROM "public"."assignment_due_date_exceptions"
                GROUP BY "assignment_due_date_exceptions"."student_id", "assignment_due_date_exceptions"."assignment_group_id", "assignment_due_date_exceptions"."assignment_id") "lt" ON (((("agm"."assignment_group_id" IS NULL) AND ("lt"."student_id" = "r"."private_profile_id") AND ("lt"."assignment_id" = "a"."id")) OR (("agm"."assignment_group_id" IS NOT NULL) AND ("lt"."assignment_group_id" = "agm"."assignment_group_id") AND ("lt"."assignment_id" = "a"."id")))))
            LEFT JOIN "public"."submissions" "gsub" ON ((("gsub"."assignment_group_id" = "agm"."assignment_group_id") AND ("gsub"."is_active" = true) AND ("gsub"."assignment_id" = "a"."id") AND ("gsub"."class_id" = "r"."class_id"))))
        WHERE ("r"."role" = 'student'::"public"."app_role" AND "r"."disabled" = false)
    ) "activesubmissionsbystudent"
    JOIN "public"."profiles" "p" ON (("p"."id" = "activesubmissionsbystudent"."private_profile_id")))
    LEFT JOIN "public"."submissions" "s" ON (("s"."id" = "activesubmissionsbystudent"."sub_id")))
    LEFT JOIN "public"."submission_reviews" "rev" ON (("rev"."id" = "s"."grading_review_id")))
    LEFT JOIN (
        SELECT DISTINCT ON ("submission_id")
            "id",
            "submission_id",
            "grader_sha",
            "grader_action_sha"
        FROM "public"."grader_results"
        WHERE "autograder_regression_test" IS NULL
        ORDER BY "submission_id", "id" DESC
    ) "ar" ON (("ar"."submission_id" = "s"."id")))
    LEFT JOIN "public"."autograder_regression_test" "rt" ON (("rt"."repository" = "s"."repository")))
    LEFT JOIN (
        SELECT DISTINCT ON ("autograder_regression_test")
            "id",
            "autograder_regression_test",
            "score",
            "grader_sha",
            "grader_action_sha"
        FROM "public"."grader_results"
        WHERE "autograder_regression_test" IS NOT NULL
        ORDER BY "autograder_regression_test", "id" DESC
    ) "ar_rt" ON (("ar_rt"."autograder_regression_test" = "rt"."id")))
    LEFT JOIN (
        SELECT DISTINCT ON ("rerun_for_submission_id")
            "id",
            "rerun_for_submission_id",
            "score",
            "grader_sha",
            "grader_action_sha"
        FROM "public"."grader_results"
        WHERE "rerun_for_submission_id" IS NOT NULL
        ORDER BY "rerun_for_submission_id", "id" DESC
    ) "ar_whatif" ON (("ar_whatif"."rerun_for_submission_id" = "s"."id")))
    LEFT JOIN "public"."assignment_groups" "ag" ON (("ag"."id" = "activesubmissionsbystudent"."assignmentgroupid")))
    LEFT JOIN "public"."class_sections" "cs" ON (("cs"."id" = "activesubmissionsbystudent"."class_section_id")))
    LEFT JOIN "public"."lab_sections" "ls" ON (("ls"."id" = "activesubmissionsbystudent"."lab_section_id")))
    LEFT JOIN "public"."repositories" "repo" ON (("repo"."repository" = "s"."repository"));

COMMENT ON VIEW "public"."submissions_with_grades_for_assignment_and_regression_test" IS
'View that returns exactly one row per active submission for each student, paired with:
- The most recent development autograder result (grader_sha, grader_action_sha) if any exists
- The most recent regression test result for the repository if any exists
- The most recent what-if rerun result for the submission if any exists
- The rerun_queued_at timestamp from the repository if a rerun is pending

The development autograder is identified by grader_results where autograder_regression_test IS NULL.
The most recent result is determined by the highest id (auto-incrementing primary key).';
