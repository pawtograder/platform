-- Migration to move autograder rerun functionality to async gateway
-- This RPC function enqueues rerun autograder requests for processing by github-async-worker

-- Add new method to github_async_method enum
ALTER TYPE public.github_async_method ADD VALUE IF NOT EXISTS 'rerun_autograder';

-- Add column to track pending rerun requests on repositories
-- This prevents duplicate rerun requests for the same repository
-- The timestamp is set when enqueued and cleared after successful workflow trigger
ALTER TABLE public.repositories ADD COLUMN IF NOT EXISTS rerun_queued_at timestamptz;

-- Add index for efficient pending rerun checks
CREATE INDEX IF NOT EXISTS idx_repositories_rerun_queued_at 
  ON public.repositories(rerun_queued_at) 
  WHERE rerun_queued_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.enqueue_autograder_reruns(
  p_submission_ids bigint[],
  p_class_id bigint
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
            'repository_id', v_submission.repository_id
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
GRANT EXECUTE ON FUNCTION public.enqueue_autograder_reruns(bigint[], bigint) TO authenticated;

COMMENT ON FUNCTION public.enqueue_autograder_reruns IS 
'Enqueues autograder rerun requests for processing by the github-async-worker. 
Uses auth.uid() to get the current user and validates they have instructor or grader permissions.
Returns a summary of enqueued and failed requests.';

-- Update view to include rerun triggered at field, and info on any pending workflow runs
CREATE OR REPLACE VIEW "public"."submissions_with_grades_for_assignment_and_regression_test" WITH ("security_invoker"='true') AS
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
    "activesubmissionsbystudent"."effective_due_date",
    "activesubmissionsbystudent"."late_due_date",
    "activesubmissionsbystudent"."class_section_id",
    "cs"."name" AS "class_section_name",
    "activesubmissionsbystudent"."lab_section_id",
    "ls"."name" AS "lab_section_name",
    "repo"."rerun_queued_at"
   FROM ((((((((((( SELECT "r"."id",
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
          WHERE ("r"."role" = 'student'::"public"."app_role" and r.disabled = false)) "activesubmissionsbystudent"
     JOIN "public"."profiles" "p" ON (("p"."id" = "activesubmissionsbystudent"."private_profile_id")))
     LEFT JOIN "public"."submissions" "s" ON (("s"."id" = "activesubmissionsbystudent"."sub_id")))
     LEFT JOIN "public"."submission_reviews" "rev" ON (("rev"."id" = "s"."grading_review_id")))
     LEFT JOIN "public"."grader_results" "ar" ON (("ar"."submission_id" = "s"."id")))
     LEFT JOIN "public"."autograder_regression_test" "rt" ON (("rt"."repository" = "s"."repository")))
     LEFT JOIN ( SELECT "max"("grader_results"."id") AS "id",
            "grader_results"."autograder_regression_test"
           FROM "public"."grader_results"
          GROUP BY "grader_results"."autograder_regression_test", "grader_results"."grader_sha") "current_rt" ON (("current_rt"."autograder_regression_test" = "rt"."id")))
     LEFT JOIN "public"."grader_results" "ar_rt" ON (("ar_rt"."id" = "current_rt"."id")))
     LEFT JOIN "public"."assignment_groups" "ag" ON (("ag"."id" = "activesubmissionsbystudent"."assignmentgroupid"))
     LEFT JOIN "public"."class_sections" "cs" ON (("cs"."id" = "activesubmissionsbystudent"."class_section_id"))
     LEFT JOIN "public"."lab_sections" "ls" ON (("ls"."id" = "activesubmissionsbystudent"."lab_section_id"))
     LEFT JOIN "public"."repositories" "repo" ON (("repo"."repository" = "s"."repository")))));
