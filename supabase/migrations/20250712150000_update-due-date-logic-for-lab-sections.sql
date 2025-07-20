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


-- Add NOT-GRADED feature to assignments and submissions
-- This allows students to create submissions after the deadline with #NOT-GRADED in commit message

-- Add flag to assignments to enable NOT-GRADED submissions
ALTER TABLE "public"."assignments" 
ADD COLUMN "allow_not_graded_submissions" boolean DEFAULT false NOT NULL;

-- Add flag to submissions to mark them as NOT-GRADED
ALTER TABLE "public"."submissions" 
ADD COLUMN "is_not_graded" boolean DEFAULT false NOT NULL;

-- Add comment to explain the feature
COMMENT ON COLUMN "public"."assignments"."allow_not_graded_submissions" IS 'When true, students can create submissions after the deadline by including #NOT-GRADED in their commit message';
COMMENT ON COLUMN "public"."submissions"."is_not_graded" IS 'When true, this submission was created with #NOT-GRADED in the commit message and cannot become active';

-- Update the submission_set_active function to prevent NOT-GRADED submissions from becoming active
CREATE OR REPLACE FUNCTION "public"."submission_set_active"("_submission_id" bigint) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
DECLARE
    submission_record RECORD;
BEGIN
    -- Get the submission details
    SELECT * INTO submission_record 
    FROM submissions 
    WHERE id = _submission_id;
    
    -- Check if submission exists
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    
    -- Prevent NOT-GRADED submissions from becoming active
    IF submission_record.is_not_graded THEN
        RETURN FALSE;
    END IF;
    
    -- Set all other submissions for this assignment/student to inactive
    UPDATE submissions 
    SET is_active = false 
    WHERE assignment_id = submission_record.assignment_id 
    AND (profile_id = submission_record.profile_id OR assignment_group_id = submission_record.assignment_group_id)
    AND id != _submission_id;
    
    -- Set this submission as active
    UPDATE submissions 
    SET is_active = true 
    WHERE id = _submission_id;
    
    RETURN TRUE;
END;
$$; 


-- Fix all functions that set is_active to respect NOT-GRADED submissions
-- This ensures NOT-GRADED submissions can never become active

-- Update the submissions_insert_hook function to prevent NOT-GRADED submissions from becoming active
CREATE OR REPLACE FUNCTION "public"."submissions_insert_hook"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
num_submissions int8;
BEGIN
   CASE TG_OP
   WHEN 'INSERT' THEN
      if NEW.assignment_group_id is not null then
        SELECT count(*) FROM submissions where assignment_group_id=NEW.assignment_group_id and assignment_id=NEW.assignment_id INTO num_submissions;
        NEW.ordinal = num_submissions + 1;
        
        -- Only set is_active = true if this is NOT a NOT-GRADED submission
        IF NOT NEW.is_not_graded THEN
          NEW.is_active = true;
          UPDATE submissions set is_active=false where assignment_id=NEW.assignment_id and assignment_group_id=NEW.assignment_group_id;
        END IF;
      else
        SELECT count(*) FROM submissions where profile_id=NEW.profile_id and assignment_id=NEW.assignment_id INTO num_submissions;
        NEW.ordinal = num_submissions + 1;
        
        -- Only set is_active = true if this is NOT a NOT-GRADED submission
        IF NOT NEW.is_not_graded THEN
          NEW.is_active = true;
          UPDATE submissions set is_active=false where assignment_id=NEW.assignment_id and profile_id=NEW.profile_id;
        END IF;
      end if;
      RETURN NEW;
   ELSE
      RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
   END CASE;
   
END
$$;

CREATE OR REPLACE VIEW "public"."assignments_for_student_dashboard" 
WITH ("security_invoker"='true') 
AS 
WITH latest_submissions AS (
    -- Get the latest submission for each assignment-student combination
    SELECT DISTINCT ON (s.assignment_id, COALESCE(s.profile_id, agm.profile_id))
        s.id,
        s.assignment_id,
        s.created_at,
        s.is_active,
        s.ordinal,
        s.profile_id,
        s.assignment_group_id,
        COALESCE(s.profile_id, agm.profile_id) AS student_profile_id
    FROM "public"."submissions" s
    LEFT JOIN "public"."assignment_groups_members" agm ON agm.assignment_group_id = s.assignment_group_id
    ORDER BY s.assignment_id, COALESCE(s.profile_id, agm.profile_id), s.created_at DESC
),
student_repositories AS (
    -- Get repositories for each student (individual or group)
    SELECT DISTINCT
        r.assignment_id,
        ur.private_profile_id AS student_profile_id,
        r.id AS repository_id,
        r.repository
    FROM "public"."repositories" r
    LEFT JOIN "public"."user_roles" ur ON ur.private_profile_id = r.profile_id
    WHERE r.profile_id IS NOT NULL
    
    UNION
    
    SELECT DISTINCT
        r.assignment_id,
        agm.profile_id AS student_profile_id,
        r.id AS repository_id,
        r.repository
    FROM "public"."repositories" r
    JOIN "public"."assignment_groups_members" agm ON agm.assignment_group_id = r.assignment_group_id
    WHERE r.assignment_group_id IS NOT NULL
)
SELECT 
    a.id,
    a.created_at,
    a.class_id,
    a.title,
    a.release_date,
    -- Use effective due date instead of original due date
    public.calculate_effective_due_date(a.id, ur.private_profile_id) AS due_date,
    a.student_repo_prefix,
    a.total_points,
    a.has_autograder,
    a.has_handgrader,
    a.description,
    a.slug,
    a.template_repo,
    a.allow_student_formed_groups,
    a.group_config,
    a.group_formation_deadline,
    a.max_group_size,
    a.min_group_size,
    a.archived_at,
    a.autograder_points,
    a.grading_rubric_id,
    a.max_late_tokens,
    a.latest_template_sha,
    a.meta_grading_rubric_id,
    a.self_review_rubric_id,
    a.self_review_setting_id,
    a.gradebook_column_id,
    a.minutes_due_after_lab,
    a.allow_not_graded_submissions,
    
    -- Student information
    ur.private_profile_id AS student_profile_id,
    ur.user_id AS student_user_id,
    
    -- Latest submission information
    ls.id AS submission_id,
    ls.created_at AS submission_created_at,
    ls.is_active AS submission_is_active,
    ls.ordinal AS submission_ordinal,
    
    -- Grader results for the latest submission
    gr.id AS grader_result_id,
    gr.score AS grader_result_score,
    gr.max_score AS grader_result_max_score,
    
    -- Repository information
    sr.repository_id,
    sr.repository,
    
    -- Assignment self review settings
    asrs.id AS assignment_self_review_setting_id,
    asrs.enabled AS self_review_enabled,
    asrs.deadline_offset AS self_review_deadline_offset,
    
    -- Review assignment information
    ra.id AS review_assignment_id,
    ra.submission_id AS review_submission_id,
    
    -- Submission review information
    sr_review.id AS submission_review_id,
    sr_review.completed_at AS submission_review_completed_at,
    
    -- Assignment due date exceptions
    ade.id AS due_date_exception_id,
    ade.hours AS exception_hours,
    ade.minutes AS exception_minutes,
    ade.tokens_consumed AS exception_tokens_consumed,
    ade.created_at AS exception_created_at,
    ade.creator_id AS exception_creator_id,
    ade.note AS exception_note

FROM "public"."assignments" a
INNER JOIN "public"."user_roles" ur ON ur.class_id = a.class_id AND ur.role = 'student'
LEFT JOIN latest_submissions ls ON ls.assignment_id = a.id AND ls.student_profile_id = ur.private_profile_id
LEFT JOIN "public"."grader_results" gr ON gr.submission_id = ls.id
LEFT JOIN student_repositories sr ON sr.assignment_id = a.id AND sr.student_profile_id = ur.private_profile_id
LEFT JOIN "public"."assignment_self_review_settings" asrs ON asrs.id = a.self_review_setting_id
LEFT JOIN "public"."review_assignments" ra ON ra.assignment_id = a.id AND ra.assignee_profile_id = ur.private_profile_id
LEFT JOIN "public"."submission_reviews" sr_review ON sr_review.id = ra.submission_review_id
LEFT JOIN "public"."assignment_due_date_exceptions" ade ON ade.assignment_id = a.id 
    AND (ade.student_id = ur.private_profile_id OR ade.assignment_group_id IN (
        SELECT agm.assignment_group_id 
        FROM "public"."assignment_groups_members" agm 
        WHERE agm.profile_id = ur.private_profile_id AND agm.assignment_id = a.id
    ))
WHERE a.archived_at IS NULL;

COMMENT ON VIEW "public"."assignments_for_student_dashboard" IS 'Comprehensive view for student assignment dashboard with effective due dates and all related data';
COMMENT ON COLUMN "public"."assignments_for_student_dashboard"."due_date" IS 'Lab-aware effective due date calculated for each student';
COMMENT ON COLUMN "public"."assignments_for_student_dashboard"."submission_id" IS 'ID of the latest submission for this assignment';
COMMENT ON COLUMN "public"."assignments_for_student_dashboard"."repository" IS 'Repository name for this student/assignment';
COMMENT ON COLUMN "public"."assignments_for_student_dashboard"."exception_hours" IS 'Hours extended via due date exceptions'; 

-- Migration to create a view that shows assignments with effective due dates per student
-- This view provides all assignment data but replaces due_date with the lab-aware effective due date

-- Create a view that shows assignments with effective due dates for each student
CREATE OR REPLACE VIEW "public"."assignments_with_effective_due_dates" 
WITH ("security_invoker"='true') 
AS SELECT 
    a.id,
    a.created_at,
    a.class_id,
    a.title,
    a.release_date,
    -- Replace due_date with effective due date
    public.calculate_effective_due_date(a.id, ur.private_profile_id) AS due_date,
    a.student_repo_prefix,
    a.total_points,
    a.has_autograder,
    a.has_handgrader,
    a.description,
    a.slug,
    a.template_repo,
    a.allow_student_formed_groups,
    a.group_config,
    a.group_formation_deadline,
    a.max_group_size,
    a.min_group_size,
    a.archived_at,
    a.autograder_points,
    a.grading_rubric_id,
    a.max_late_tokens,
    a.latest_template_sha,
    a.meta_grading_rubric_id,
    a.self_review_rubric_id,
    a.self_review_setting_id,
    a.gradebook_column_id,
    a.minutes_due_after_lab,
    -- Add student profile ID for filtering
    ur.private_profile_id AS student_profile_id

FROM "public"."assignments" a
CROSS JOIN "public"."user_roles" ur
WHERE ur.class_id = a.class_id 
  AND ur.role = 'student'
  AND a.archived_at IS NULL;

-- Grant permissions on the view
GRANT ALL ON TABLE "public"."assignments_with_effective_due_dates" TO "authenticated";
GRANT ALL ON TABLE "public"."assignments_with_effective_due_dates" TO "service_role";
GRANT ALL ON TABLE "public"."assignments_with_effective_due_dates" TO "anon";


-- Add comments for documentation
COMMENT ON VIEW "public"."assignments_with_effective_due_dates" IS 'View showing all assignment columns but with due_date replaced by the lab-aware effective due date for each student';
COMMENT ON COLUMN "public"."assignments_with_effective_due_dates"."due_date" IS 'Lab-aware effective due date calculated for each student';
COMMENT ON COLUMN "public"."assignments_with_effective_due_dates"."student_profile_id" IS 'Student profile ID for filtering assignments by student';