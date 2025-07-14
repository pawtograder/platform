-- Migration to update all existing due date logic to support lab-based scheduling
-- This migration updates database functions and views to use the new lab-aware due date calculations

-- Update check_assignment_deadlines_passed to use lab-based due dates
CREATE OR REPLACE FUNCTION "public"."check_assignment_deadlines_passed"() 
RETURNS void
LANGUAGE "plpgsql" SECURITY DEFINER
AS $$
BEGIN
    -- First, create any missing submission reviews for students whose lab-based due dates have passed
    INSERT INTO submission_reviews (total_score, released, tweak, class_id, submission_id, name, rubric_id)
    SELECT DISTINCT
        0, false, 0, a.class_id, s.id, 'Self Review', a.self_review_rubric_id
    FROM assignments a
    JOIN assignment_self_review_settings ars ON ars.id = a.self_review_setting_id
    JOIN profiles prof ON prof.class_id = a.class_id AND prof.is_private_profile = true
    JOIN user_roles ur ON ur.private_profile_id = prof.id AND ur.role = 'student'
    JOIN submissions s ON (
        (s.profile_id = prof.id OR s.assignment_group_id IN (
            SELECT agm.assignment_group_id 
            FROM assignment_groups_members agm 
            WHERE agm.profile_id = prof.id AND agm.assignment_id = a.id
        ))
        AND s.assignment_id = a.id 
        AND s.is_active = true
    )
    LEFT JOIN assignment_groups_members agm ON agm.profile_id = prof.id AND agm.assignment_id = a.id
    WHERE a.archived_at IS NULL
    AND ars.enabled = true
    AND a.self_review_rubric_id IS NOT NULL
    AND public.calculate_final_due_date(a.id, prof.id, agm.assignment_group_id) <= NOW()
    AND NOT EXISTS (
        SELECT 1 FROM review_assignments ra 
        WHERE ra.assignment_id = a.id AND ra.assignee_profile_id = prof.id
    )
    AND NOT EXISTS (
        SELECT 1 FROM submission_reviews sr 
        WHERE sr.submission_id = s.id 
        AND sr.class_id = a.class_id 
        AND sr.rubric_id = a.self_review_rubric_id
    )
    ON CONFLICT (submission_id, rubric_id) DO NOTHING;

    -- Then, insert review assignments for students who need them but don't have them yet
    INSERT INTO review_assignments (
        due_date,
        assignee_profile_id,
        submission_id,
        submission_review_id,
        assignment_id,
        rubric_id,
        class_id
    )
    SELECT DISTINCT
        public.calculate_final_due_date(a.id, prof.id, agm.assignment_group_id) + (INTERVAL '1 hour' * ars.deadline_offset),
        prof.id,
        s.id,
        sr.id,
        a.id,
        a.self_review_rubric_id,
        a.class_id
    FROM assignments a
    JOIN assignment_self_review_settings ars ON ars.id = a.self_review_setting_id
    JOIN profiles prof ON prof.class_id = a.class_id AND prof.is_private_profile = true
    JOIN user_roles ur ON ur.private_profile_id = prof.id AND ur.role = 'student'
    JOIN submissions s ON (
        (s.profile_id = prof.id OR s.assignment_group_id IN (
            SELECT agm.assignment_group_id 
            FROM assignment_groups_members agm 
            WHERE agm.profile_id = prof.id AND agm.assignment_id = a.id
        ))
        AND s.assignment_id = a.id 
        AND s.is_active = true
    )
    LEFT JOIN assignment_groups_members agm ON agm.profile_id = prof.id AND agm.assignment_id = a.id
    JOIN submission_reviews sr ON (
        sr.submission_id = s.id 
        AND sr.class_id = a.class_id 
        AND sr.rubric_id = a.self_review_rubric_id
    )
    WHERE a.archived_at IS NULL
    AND ars.enabled = true
    AND public.calculate_final_due_date(a.id, prof.id, agm.assignment_group_id) <= NOW()
    AND NOT EXISTS (
        SELECT 1 FROM review_assignments ra 
        WHERE ra.assignment_id = a.id AND ra.assignee_profile_id = prof.id
    )
    ON CONFLICT (submission_review_id, assignee_profile_id) DO NOTHING;
END;
$$;

-- Update finalize_submission_early to use lab-based due dates
CREATE OR REPLACE FUNCTION "public"."finalize_submission_early"("this_assignment_id" bigint, "this_profile_id" uuid) 
RETURNS json
LANGUAGE "plpgsql" SECURITY DEFINER
AS $$
DECLARE
    this_assignment public.assignments;
    this_group_id bigint;
    this_self_review_setting public.assignment_self_review_settings;
    this_active_submission_id bigint;
    existing_submission_review_id bigint;
    hours_to_subtract integer;
    minutes_to_subtract integer;
    utc_now TIMESTAMP := date_trunc('minute', now() + interval '59 second');
    effective_due_date timestamp with time zone;
BEGIN
    -- Get the assignment first
    SELECT * INTO this_assignment FROM public.assignments WHERE id = this_assignment_id;
    
    -- Check if assignment exists
    IF this_assignment.id IS NULL THEN
        RETURN json_build_object('success', false, 'error', 'Assignment not found');
    END IF;
    
    -- Confirm this is a private profile for a student in this class, else abort
    IF NOT EXISTS (
        SELECT 1 FROM user_roles
        WHERE private_profile_id = this_profile_id
        AND role = 'student'
        AND class_id = this_assignment.class_id
        AND user_id = auth.uid()
    ) THEN
        RETURN json_build_object('success', false, 'error', 'Not authorized');
    END IF;
    
    -- Get the group of the student for this assignment
    SELECT assignment_group_id INTO this_group_id
    FROM public.assignment_groups_members
    WHERE profile_id = this_profile_id
    AND class_id = this_assignment.class_id
    AND assignment_id = this_assignment.id
    LIMIT 1;
    
    -- Get the self review setting
    SELECT * INTO this_self_review_setting
    FROM public.assignment_self_review_settings
    WHERE id = this_assignment.self_review_setting_id;
    
    -- If self reviews are not enabled for this assignment, abort
    IF this_self_review_setting.enabled IS NOT TRUE THEN
        RETURN json_build_object('success', false, 'error', 'Self reviews not enabled for this assignment');
    END IF;
    
    -- Check if there's already a negative due date exception (already finalized)
    IF EXISTS (
        SELECT 1 FROM assignment_due_date_exceptions
        WHERE assignment_id = this_assignment_id
        AND (
            (student_id = this_profile_id AND hours < 0) OR
            (assignment_group_id = this_group_id AND hours < 0)
        )
    ) THEN
        RETURN json_build_object('success', false, 'error', 'Submission already finalized');
    END IF;
    
    -- Get the effective due date (lab-based or regular)
    effective_due_date := public.calculate_effective_due_date(this_assignment_id, this_profile_id);
    
    -- Calculate hours and minutes to subtract from the effective due date
    hours_to_subtract := -1 * EXTRACT(EPOCH FROM (effective_due_date - utc_now)) / 3600;
    minutes_to_subtract := -1 * (EXTRACT(EPOCH FROM (effective_due_date - utc_now)) % 3600) / 60;
    
    -- Insert the negative due date exception
    IF this_group_id IS NOT NULL THEN
        INSERT INTO assignment_due_date_exceptions (
            class_id,
            assignment_id,
            assignment_group_id,
            creator_id,
            hours,
            minutes,
            tokens_consumed
        ) VALUES (
            this_assignment.class_id,
            this_assignment_id,
            this_group_id,
            this_profile_id,
            hours_to_subtract,
            minutes_to_subtract,
            0
        );
    ELSE
        INSERT INTO assignment_due_date_exceptions (
            class_id,
            assignment_id,
            student_id,
            creator_id,
            hours,
            minutes,
            tokens_consumed
        ) VALUES (
            this_assignment.class_id,
            this_assignment_id,
            this_profile_id,
            this_profile_id,
            hours_to_subtract,
            minutes_to_subtract,
            0
        );
    END IF;
    
    -- Get the active submission id for this profile
    SELECT id INTO this_active_submission_id
    FROM public.submissions
    WHERE ((profile_id IS NOT NULL AND profile_id = this_profile_id) OR (assignment_group_id IS NOT NULL AND assignment_group_id = this_group_id))
    AND assignment_id = this_assignment_id
    AND is_active = true
    LIMIT 1;
    
    -- If active submission does not exist, abort
    IF this_active_submission_id IS NULL THEN
        RETURN json_build_object('success', false, 'error', 'No active submission found');
    END IF;
    
    -- Check if there's already a review assignment for this student for this assignment
    IF EXISTS (
        SELECT 1 FROM review_assignments
        WHERE assignment_id = this_assignment.id
        AND assignee_profile_id = this_profile_id
    ) THEN
        RETURN json_build_object('success', false, 'error', 'Self review already assigned');
    END IF;
    
    -- Create or get existing submission review
    SELECT id INTO existing_submission_review_id
    FROM public.submission_reviews
    WHERE submission_id = this_active_submission_id
    AND class_id = this_assignment.class_id
    AND rubric_id = this_assignment.self_review_rubric_id
    LIMIT 1;
    
    IF existing_submission_review_id IS NULL THEN
        INSERT INTO submission_reviews (total_score, released, tweak, class_id, submission_id, name, rubric_id)
        VALUES (0, false, 0, this_assignment.class_id, this_active_submission_id, 'Self Review', this_assignment.self_review_rubric_id)
        RETURNING id INTO existing_submission_review_id;
    END IF;
    
    -- Create the review assignment using the effective due date
    INSERT INTO review_assignments (
        due_date,
        assignee_profile_id,
        submission_id,
        submission_review_id,
        assignment_id,
        rubric_id,
        class_id
    ) VALUES (
        utc_now + (INTERVAL '1 hour' * this_self_review_setting.deadline_offset),
        this_profile_id,
        this_active_submission_id,
        existing_submission_review_id,
        this_assignment.id,
        this_assignment.self_review_rubric_id,
        this_assignment.class_id
    );
    
    RETURN json_build_object('success', true, 'message', 'Submission finalized and self review assigned');
END;
$$;

-- Update the submissions_with_grades_for_assignment view to use lab-based due dates
DROP VIEW IF EXISTS "public"."submissions_with_grades_for_assignment";

CREATE OR REPLACE VIEW "public"."submissions_with_grades_for_assignment" 
WITH ("security_invoker"='true') 
AS SELECT 
    activesubmissionsbystudent.id,
    activesubmissionsbystudent.class_id,
    activesubmissionsbystudent.assignment_id,
    p.id as student_private_profile_id,
    p.name,
    p.sortable_name,
    s.id AS activesubmissionid,
    s.created_at,
    s.released,
    s.repository,
    s.sha,
    rev.total_autograde_score AS autograder_score,
    rev.grader,
    rev.meta_grader,
    rev.total_score,
    rev.tweak,
    rev.completed_by,
    rev.completed_at,
    rev.checked_at,
    rev.checked_by,
    graderprofile.name AS assignedgradername,
    metagraderprofile.name AS assignedmetagradername,
    completerprofile.name AS gradername,
    checkgraderprofile.name AS checkername,
    ag.name AS groupname,
    activesubmissionsbystudent.tokens_consumed,
    activesubmissionsbystudent.hours,
    activesubmissionsbystudent.due_date,
    activesubmissionsbystudent.effective_due_date,
    activesubmissionsbystudent.late_due_date,
    activesubmissionsbystudent.private_profile_id AS student_id,
    activesubmissionsbystudent.slug AS assignment_slug,
    activesubmissionsbystudent.total_points AS assignment_total_points,
    ar.grader_sha,
    ar.grader_action_sha
FROM (((((((((( 
    SELECT 
        r.id,
        CASE
            WHEN (isub.id IS NULL) THEN gsub.id
            ELSE isub.id
        END AS sub_id,
        r.private_profile_id,
        r.class_id,
        a.id AS assignment_id,
        agm.assignment_group_id AS assignmentgroupid,
        lt.tokens_consumed,
        lt.hours,
        a.due_date,
        public.calculate_effective_due_date(a.id, r.private_profile_id) AS effective_due_date,
        public.calculate_final_due_date(a.id, r.private_profile_id, agm.assignment_group_id) AS late_due_date,
        a.slug,
        a.total_points
    FROM ((((("public"."user_roles" "r"
        JOIN "public"."assignments" "a" ON (("a"."class_id" = "r"."class_id")))
        LEFT JOIN "public"."submissions" "isub" ON ((("isub"."profile_id" = "r"."private_profile_id") AND ("isub"."is_active" = true) AND ("isub"."assignment_id" = "a"."id"))))
        LEFT JOIN "public"."assignment_groups_members" "agm" ON ((("agm"."profile_id" = "r"."private_profile_id") AND ("agm"."assignment_id" = "a"."id"))))
        LEFT JOIN ( SELECT "sum"("assignment_due_date_exceptions"."tokens_consumed") AS "tokens_consumed",
                "sum"("assignment_due_date_exceptions"."hours") AS "hours",
                "assignment_due_date_exceptions"."student_id",
                "assignment_due_date_exceptions"."assignment_group_id"
               FROM "public"."assignment_due_date_exceptions"
              GROUP BY "assignment_due_date_exceptions"."student_id", "assignment_due_date_exceptions"."assignment_group_id") "lt" ON (((("agm"."assignment_group_id" IS NULL) AND ("lt"."student_id" = "r"."private_profile_id")) OR (("agm"."assignment_group_id" IS NOT NULL) AND ("lt"."assignment_group_id" = "agm"."assignment_group_id")))))
        LEFT JOIN "public"."submissions" "gsub" ON ((("gsub"."assignment_group_id" = "agm"."assignment_group_id") AND ("gsub"."is_active" = true) AND ("gsub"."assignment_id" = "a"."id"))))
    WHERE ("r"."role" = 'student'::"public"."app_role")) "activesubmissionsbystudent"
    JOIN "public"."profiles" "p" ON (("p"."id" = "activesubmissionsbystudent"."private_profile_id")))
    LEFT JOIN "public"."submissions" "s" ON (("s"."id" = "activesubmissionsbystudent"."sub_id")))
    LEFT JOIN "public"."submission_reviews" "rev" ON (("rev"."id" = "s"."grading_review_id")))
    LEFT JOIN "public"."grader_results" "ar" ON (("ar"."submission_id" = "s"."id")))
    LEFT JOIN "public"."assignment_groups" "ag" ON (("ag"."id" = "activesubmissionsbystudent"."assignmentgroupid")))
    LEFT JOIN "public"."profiles" "completerprofile" ON (("completerprofile"."id" = "rev"."completed_by")))
    LEFT JOIN "public"."profiles" "graderprofile" ON (("graderprofile"."id" = "rev"."grader")))
    LEFT JOIN "public"."profiles" "metagraderprofile" ON (("metagraderprofile"."id" = "rev"."meta_grader")))
    LEFT JOIN "public"."profiles" "checkgraderprofile" ON (("checkgraderprofile"."id" = "rev"."checked_by")));

-- Update authorize_to_create_own_due_date_extension to use lab-based due dates
CREATE OR REPLACE FUNCTION "public"."authorize_to_create_own_due_date_extension"(
    "_student_id" "uuid", 
    "_assignment_group_id" bigint, 
    "_assignment_id" bigint, 
    "_class_id" bigint, 
    "_creator_id" "uuid", 
    "_hours_to_extend" integer, 
    "_tokens_consumed" integer
) 
RETURNS boolean
LANGUAGE "plpgsql" STABLE SECURITY DEFINER
SET "search_path" TO ''
AS $$
declare
  tokens_used int;
  tokens_remaining int;
  tokens_needed int;
  max_tokens_for_assignment int;
  private_profile_id uuid;
  effective_due_date timestamp with time zone;
begin

  -- Validate that the declared number of tokens consumed is correct
  tokens_needed := ceil(_hours_to_extend/24);
  if tokens_needed != _tokens_consumed then
    return false;
  end if;

  select public.user_roles.private_profile_id from public.user_roles where user_id = auth.uid() and class_id = _class_id into private_profile_id;
  -- Make sure student is in the class and the creator of the extension
  if private_profile_id is null or private_profile_id != _creator_id then
    return false;
  end if;

  select late_tokens_per_student from public.classes where id = _class_id into tokens_remaining;

  -- Make sure that the student is in the assignment group or matches the student_id
  if _assignment_group_id is not null then
    if not exists (select 1 from public.assignment_groups_members where assignment_group_id = _assignment_group_id and profile_id = private_profile_id) then
      return false;
    end if;
    select sum(tokens_consumed) from public.assignment_due_date_exceptions where assignment_group_id = _assignment_group_id and assignment_id = _assignment_id into tokens_used;
  else
    if private_profile_id != _student_id then
      return false;
    end if;
      select sum(tokens_consumed) from public.assignment_due_date_exceptions where student_id = _student_id and assignment_id = _assignment_id into tokens_used;
  end if;

  tokens_used = tokens_used + tokens_needed;
  if tokens_used > tokens_remaining then
    return false;
  end if;

  select max_late_tokens from public.assignments where id=_assignment_id into max_tokens_for_assignment;

  if tokens_used > max_tokens_for_assignment then
    return false;
  end if;

  return true;
end;
$$;

-- Grant permissions on updated functions
GRANT ALL ON FUNCTION "public"."check_assignment_deadlines_passed"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."check_assignment_deadlines_passed"() TO "service_role";
GRANT ALL ON FUNCTION "public"."finalize_submission_early"(bigint, uuid) TO "authenticated";
GRANT ALL ON FUNCTION "public"."finalize_submission_early"(bigint, uuid) TO "service_role";
GRANT ALL ON FUNCTION "public"."authorize_to_create_own_due_date_extension"(uuid, bigint, bigint, bigint, uuid, integer, integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."authorize_to_create_own_due_date_extension"(uuid, bigint, bigint, bigint, uuid, integer, integer) TO "service_role";

-- Grant permissions on the updated view
GRANT ALL ON TABLE "public"."submissions_with_grades_for_assignment" TO "authenticated";
GRANT ALL ON TABLE "public"."submissions_with_grades_for_assignment" TO "service_role";

-- Update the submissions_with_grades_for_assignment_and_regression_test view to use lab-based due dates
DROP VIEW IF EXISTS "public"."submissions_with_grades_for_assignment_and_regression_test";

CREATE OR REPLACE VIEW "public"."submissions_with_grades_for_assignment_and_regression_test" 
WITH ("security_invoker"='true') 
AS SELECT 
    activesubmissionsbystudent.id,
    activesubmissionsbystudent.class_id,
    activesubmissionsbystudent.assignment_id,
    p.name,
    p.sortable_name,
    s.id AS activesubmissionid,
    s.created_at,
    s.released,
    s.repository,
    s.sha,
    rev.total_autograde_score AS autograder_score,
    ag.name AS groupname,
    ar.grader_sha,
    ar.grader_action_sha,
    ar_rt.score AS rt_autograder_score,
    ar_rt.grader_sha AS rt_grader_sha,
    ar_rt.grader_action_sha AS rt_grader_action_sha,
    activesubmissionsbystudent.effective_due_date,
    activesubmissionsbystudent.late_due_date
FROM ((((((((
    SELECT 
        r.id,
        CASE
            WHEN (isub.id IS NULL) THEN gsub.id
            ELSE isub.id
        END AS sub_id,
        r.private_profile_id,
        r.class_id,
        a.id AS assignment_id,
        agm.assignment_group_id AS assignmentgroupid,
        a.due_date,
        public.calculate_effective_due_date(a.id, r.private_profile_id) AS effective_due_date,
        public.calculate_final_due_date(a.id, r.private_profile_id, agm.assignment_group_id) AS late_due_date
   FROM ((((("public"."user_roles" "r"
        JOIN "public"."assignments" "a" ON (("a"."class_id" = "r"."class_id")))
        LEFT JOIN "public"."submissions" "isub" ON ((("isub"."profile_id" = "r"."private_profile_id") AND ("isub"."is_active" = true) AND ("isub"."assignment_id" = "a"."id"))))
        LEFT JOIN "public"."assignment_groups_members" "agm" ON ((("agm"."profile_id" = "r"."private_profile_id") AND ("agm"."assignment_id" = "a"."id"))))
        LEFT JOIN ( SELECT "sum"("assignment_due_date_exceptions"."tokens_consumed") AS "tokens_consumed",
                "sum"("assignment_due_date_exceptions"."hours") AS "hours",
                "assignment_due_date_exceptions"."student_id",
                "assignment_due_date_exceptions"."assignment_group_id"
               FROM "public"."assignment_due_date_exceptions"
              GROUP BY "assignment_due_date_exceptions"."student_id", "assignment_due_date_exceptions"."assignment_group_id") "lt" ON (((("agm"."assignment_group_id" IS NULL) AND ("lt"."student_id" = "r"."private_profile_id")) OR (("agm"."assignment_group_id" IS NOT NULL) AND ("lt"."assignment_group_id" = "agm"."assignment_group_id")))))
        LEFT JOIN "public"."submissions" "gsub" ON ((("gsub"."assignment_group_id" = "agm"."assignment_group_id") AND ("gsub"."is_active" = true) AND ("gsub"."assignment_id" = "a"."id"))))
    WHERE ("r"."role" = 'student'::"public"."app_role")) "activesubmissionsbystudent"
     JOIN "public"."profiles" "p" ON (("p"."id" = "activesubmissionsbystudent"."private_profile_id")))
    LEFT JOIN "public"."submissions" "s" ON (("s"."id" = "activesubmissionsbystudent"."sub_id")))
    LEFT JOIN "public"."submission_reviews" "rev" ON (("rev"."id" = "s"."grading_review_id")))
    LEFT JOIN "public"."grader_results" "ar" ON (("ar"."submission_id" = "s"."id")))
    LEFT JOIN "public"."autograder_regression_test" "rt" ON (("rt"."repository" = "s"."repository")))
    LEFT JOIN ( 
        SELECT max(grader_results.id) AS id,
               grader_results.autograder_regression_test
        FROM public.grader_results
        GROUP BY grader_results.autograder_regression_test, grader_results.grader_sha
    ) "current_rt" ON (("current_rt"."autograder_regression_test" = "rt"."id")))
    LEFT JOIN "public"."grader_results" "ar_rt" ON (("ar_rt"."id" = "current_rt"."id")))
    LEFT JOIN "public"."assignment_groups" "ag" ON (("ag"."id" = "activesubmissionsbystudent"."assignmentgroupid"));

-- Grant permissions on the updated regression test view
GRANT ALL ON TABLE "public"."submissions_with_grades_for_assignment_and_regression_test" TO "authenticated";
GRANT ALL ON TABLE "public"."submissions_with_grades_for_assignment_and_regression_test" TO "service_role";

-- Add comments to document the updates
COMMENT ON FUNCTION "public"."check_assignment_deadlines_passed"() IS 'Updated to support lab-based due date scheduling';
COMMENT ON FUNCTION "public"."finalize_submission_early"(bigint, uuid) IS 'Updated to support lab-based due date scheduling';
COMMENT ON VIEW "public"."submissions_with_grades_for_assignment" IS 'Updated to include both effective_due_date (lab-based) and late_due_date (with extensions)';
COMMENT ON VIEW "public"."submissions_with_grades_for_assignment_and_regression_test" IS 'Updated to include lab-based due dates for both assignment submissions and regression tests'; 