-- Fix the auto-accept invitation trigger to prevent foreign key constraint violations
-- The issue: BEFORE INSERT trigger tries to reference NEW.id before it exists

-- Drop the existing trigger
DROP TRIGGER IF EXISTS "trigger_auto_accept_invitation_if_user_exists" ON "public"."invitations";

-- Recreate the function to work with AFTER INSERT (where invitation ID exists)
CREATE OR REPLACE FUNCTION "public"."auto_accept_invitation_if_user_exists"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user_id uuid;
  v_existing_role_id bigint;
BEGIN
  -- Only process pending invitations with SIS user ID
  IF NEW.status = 'pending' AND NEW.sis_user_id IS NOT NULL THEN
    
    -- Check if user with this SIS ID already exists
    SELECT u.user_id INTO v_user_id
    FROM users u 
    WHERE u.sis_user_id = NEW.sis_user_id;
    
    IF v_user_id IS NOT NULL THEN
      -- Check if user already has a role in this class
      SELECT ur.id INTO v_existing_role_id
      FROM user_roles ur
      WHERE ur.user_id = v_user_id 
      AND ur.class_id = NEW.class_id
      AND ur.role = NEW.role
      AND ur.disabled = false;
      
      IF v_existing_role_id IS NOT NULL THEN
        -- User already has the role, update section assignments and auto-accept the invitation
        UPDATE user_roles 
        SET class_section_id = NEW.class_section_id,
            lab_section_id = NEW.lab_section_id,
            invitation_id = NEW.id  -- Link to the new invitation
        WHERE id = v_existing_role_id;
        
        UPDATE invitations 
        SET status = 'accepted', 
            accepted_at = NOW(), 
            updated_at = NOW()
        WHERE id = NEW.id;
        
        -- Log this action for debugging
        RAISE NOTICE 'Updated sections and auto-accepted invitation % for user % (SIS ID: %) - updated existing role % in class % with sections (class: %, lab: %)', 
          NEW.id, v_user_id, NEW.sis_user_id, NEW.role, NEW.class_id, NEW.class_section_id, NEW.lab_section_id;
      ELSE
        -- User exists but doesn't have the role yet - create role using invitation's pre-created profiles
        INSERT INTO user_roles (
          user_id,
          class_id,
          role,
          public_profile_id,
          private_profile_id,
          class_section_id,
          lab_section_id,
          disabled,
          invitation_date,
          invitation_id
        ) VALUES (
          v_user_id,
          NEW.class_id,
          NEW.role,
          NEW.public_profile_id,  -- Use invitation's pre-created public profile
          NEW.private_profile_id, -- Use invitation's pre-created private profile
          NEW.class_section_id,
          NEW.lab_section_id,
          false,
          null,
          NEW.id  -- Now NEW.id exists because this is AFTER INSERT
        );
        
        -- Auto-accept the invitation since we just created the role
        UPDATE invitations 
        SET status = 'accepted', 
            accepted_at = NOW(), 
            updated_at = NOW()
        WHERE id = NEW.id;
        
        -- Log this action for debugging
        RAISE NOTICE 'Created role and auto-accepted invitation % for user % (SIS ID: %) - created role % in class %', 
          NEW.id, v_user_id, NEW.sis_user_id, NEW.role, NEW.class_id;
      END IF;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create the new AFTER INSERT trigger
CREATE OR REPLACE TRIGGER "trigger_auto_accept_invitation_if_user_exists" 
    AFTER INSERT ON "public"."invitations" 
    FOR EACH ROW EXECUTE FUNCTION "public"."auto_accept_invitation_if_user_exists"();

-- Also create an AFTER UPDATE trigger to handle section changes in existing invitations
CREATE OR REPLACE TRIGGER "trigger_auto_accept_invitation_on_update" 
    AFTER UPDATE ON "public"."invitations" 
    FOR EACH ROW 
    WHEN (OLD.class_section_id IS DISTINCT FROM NEW.class_section_id OR 
          OLD.lab_section_id IS DISTINCT FROM NEW.lab_section_id)
    EXECUTE FUNCTION "public"."auto_accept_invitation_if_user_exists"();

-- Update views to exclude soft-deleted (disabled) students from submission rosters
-- This ensures that when user_role.disabled = true, the student doesn't appear in gradebook/roster views

-- Update active_submissions_for_class view to exclude disabled students
-- The view needs to join with user_roles to check the disabled status
CREATE OR REPLACE VIEW "public"."active_submissions_for_class" WITH ("security_invoker"='true') AS
 SELECT "s"."id" AS "submission_id",
    "s"."profile_id" AS "student_private_profile_id",
    "s"."assignment_id",
    "s"."class_id",
    NULL::"text" AS "groupname"
   FROM "public"."submissions" "s"
   JOIN "public"."user_roles" "ur" ON (("ur"."private_profile_id" = "s"."profile_id" 
                                       AND "ur"."class_id" = "s"."class_id" 
                                       AND "ur"."role" = 'student'
                                       AND "ur"."disabled" = false))
  WHERE (("s"."is_active" = true) AND ("s"."assignment_group_id" IS NULL))
UNION ALL
 SELECT "s"."id" AS "submission_id",
    "agm"."profile_id" AS "student_private_profile_id",
    "s"."assignment_id",
    "s"."class_id",
    "ag"."name" AS "groupname"
   FROM (("public"."submissions" "s"
     JOIN "public"."assignment_groups_members" "agm" ON ((("agm"."assignment_group_id" = "s"."assignment_group_id") AND ("agm"."assignment_id" = "s"."assignment_id"))))
     LEFT JOIN "public"."assignment_groups" "ag" ON (("ag"."id" = "s"."assignment_group_id")))
     JOIN "public"."user_roles" "ur" ON (("ur"."private_profile_id" = "agm"."profile_id" 
                                         AND "ur"."class_id" = "s"."class_id" 
                                         AND "ur"."role" = 'student'
                                         AND "ur"."disabled" = false))
  WHERE (("s"."is_active" = true) AND ("s"."assignment_group_id" IS NOT NULL));

-- Update submissions_agg view to exclude disabled students
CREATE OR REPLACE VIEW "public"."submissions_agg" WITH ("security_invoker"='true') AS
 SELECT "c"."profile_id",
    "p"."name",
    "p"."sortable_name",
    "p"."avatar_url",
    "groups"."name" AS "groupname",
    "c"."submissioncount",
    "c"."latestsubmissionid",
    "s"."id",
    "s"."created_at",
    "s"."assignment_id",
    "s"."profile_id" AS "user_id",
    "s"."released",
    "s"."sha",
    "s"."repository",
    "s"."run_attempt",
    "s"."run_number",
    "g"."score",
    "g"."ret_code",
    "g"."execution_time"
   FROM ((((( SELECT "count"("submissions"."id") AS "submissioncount",
            "max"("submissions"."id") AS "latestsubmissionid",
            "r"."private_profile_id" AS "profile_id"
           FROM (("public"."user_roles" "r"
             LEFT JOIN "public"."assignment_groups_members" "m" ON (("m"."profile_id" = "r"."private_profile_id")))
             LEFT JOIN "public"."submissions" ON ((("submissions"."profile_id" = "r"."private_profile_id") OR ("submissions"."assignment_group_id" = "m"."assignment_group_id"))))
          WHERE "r"."disabled" = false
          GROUP BY "submissions"."assignment_id", "r"."private_profile_id") "c"
     LEFT JOIN "public"."submissions" "s" ON (("s"."id" = "c"."latestsubmissionid")))
     LEFT JOIN "public"."assignment_groups" "groups" ON (("groups"."id" = "s"."assignment_group_id")))
     LEFT JOIN "public"."grader_results" "g" ON (("g"."submission_id" = "s"."id")))
     JOIN "public"."profiles" "p" ON (("p"."id" = "c"."profile_id")));

-- Update submissions_with_grades_for_assignment view to exclude disabled students
CREATE OR REPLACE VIEW "public"."submissions_with_grades_for_assignment" WITH ("security_invoker"='true') AS
 WITH "assignment_students" AS (
         SELECT DISTINCT "ur"."id" AS "user_role_id",
            "ur"."private_profile_id",
            "a"."class_id",
            "a"."id" AS "assignment_id",
            "a"."due_date",
            "a"."slug" AS "assignment_slug",
            "ur"."class_section_id",
            "ur"."lab_section_id"
           FROM ("public"."assignments" "a"
             JOIN "public"."user_roles" "ur" ON ((("ur"."class_id" = "a"."class_id") AND ("ur"."role" = 'student'::"public"."app_role") AND ("ur"."disabled" = false))))
        ), "individual_submissions" AS (
         SELECT "ast"."user_role_id",
            "ast"."private_profile_id",
            "ast"."class_id",
            "ast"."assignment_id",
            "s_1"."id" AS "submission_id",
            NULL::bigint AS "assignment_group_id",
            "ast"."due_date",
            "ast"."assignment_slug",
            "ast"."class_section_id",
            "ast"."lab_section_id"
           FROM ("assignment_students" "ast"
             JOIN "public"."submissions" "s_1" ON ((("s_1"."assignment_id" = "ast"."assignment_id") AND ("s_1"."profile_id" = "ast"."private_profile_id") AND ("s_1"."is_active" = true) AND ("s_1"."assignment_group_id" IS NULL))))
        ), "group_submissions" AS (
         SELECT "ast"."user_role_id",
            "ast"."private_profile_id",
            "ast"."class_id",
            "ast"."assignment_id",
            "s_1"."id" AS "submission_id",
            "agm"."assignment_group_id",
            "ast"."due_date",
            "ast"."assignment_slug",
            "ast"."class_section_id",
            "ast"."lab_section_id"
           FROM (("assignment_students" "ast"
             JOIN "public"."assignment_groups_members" "agm" ON ((("agm"."assignment_id" = "ast"."assignment_id") AND ("agm"."profile_id" = "ast"."private_profile_id"))))
             JOIN "public"."submissions" "s_1" ON ((("s_1"."assignment_id" = "ast"."assignment_id") AND ("s_1"."assignment_group_id" = "agm"."assignment_group_id") AND ("s_1"."is_active" = true))))
        ), "all_submissions" AS (
         SELECT "individual_submissions"."user_role_id",
            "individual_submissions"."private_profile_id",
            "individual_submissions"."class_id",
            "individual_submissions"."assignment_id",
            "individual_submissions"."submission_id",
            "individual_submissions"."assignment_group_id",
            "individual_submissions"."due_date",
            "individual_submissions"."assignment_slug",
            "individual_submissions"."class_section_id",
            "individual_submissions"."lab_section_id"
           FROM "individual_submissions"
        UNION ALL
         SELECT "group_submissions"."user_role_id",
            "group_submissions"."private_profile_id",
            "group_submissions"."class_id",
            "group_submissions"."assignment_id",
            "group_submissions"."submission_id",
            "group_submissions"."assignment_group_id",
            "group_submissions"."due_date",
            "group_submissions"."assignment_slug",
            "group_submissions"."class_section_id",
            "group_submissions"."lab_section_id"
           FROM "group_submissions"
        ), "due_date_extensions" AS (
         SELECT COALESCE("ade"."student_id", "ag_1"."profile_id") AS "effective_student_id",
            COALESCE("ade"."assignment_group_id", "ag_1"."assignment_group_id") AS "effective_assignment_group_id",
            "ade"."assignment_id",
            "sum"("ade"."tokens_consumed") AS "tokens_consumed",
            "sum"("ade"."hours") AS "hours"
           FROM ("public"."assignment_due_date_exceptions" "ade"
             LEFT JOIN "public"."assignment_groups_members" "ag_1" ON (("ade"."assignment_group_id" = "ag_1"."assignment_group_id")))
          GROUP BY COALESCE("ade"."student_id", "ag_1"."profile_id"), COALESCE("ade"."assignment_group_id", "ag_1"."assignment_group_id"), "ade"."assignment_id"
        ), "submissions_with_extensions" AS (
         SELECT "asub"."user_role_id",
            "asub"."private_profile_id",
            "asub"."class_id",
            "asub"."assignment_id",
            "asub"."submission_id",
            "asub"."assignment_group_id",
            "asub"."due_date",
            "asub"."assignment_slug",
            COALESCE("dde"."tokens_consumed", (0)::bigint) AS "tokens_consumed",
            COALESCE("dde"."hours", (0)::bigint) AS "hours",
            "asub"."class_section_id",
            "asub"."lab_section_id"
           FROM ("all_submissions" "asub"
             LEFT JOIN "due_date_extensions" "dde" ON ((("dde"."effective_student_id" = "asub"."private_profile_id") AND ("dde"."assignment_id" = "asub"."assignment_id") AND ((("asub"."assignment_group_id" IS NULL) AND ("dde"."effective_assignment_group_id" IS NULL)) OR ("asub"."assignment_group_id" = "dde"."effective_assignment_group_id")))))
        )
 SELECT "swe"."user_role_id" AS "id",
    "swe"."class_id",
    "swe"."assignment_id",
    "p"."id" AS "student_private_profile_id",
    "p"."name",
    "p"."sortable_name",
    "s"."id" AS "activesubmissionid",
    "s"."created_at",
    "s"."released",
    "s"."repository",
    "s"."sha",
    "rev"."total_autograde_score" AS "autograder_score",
    "rev"."grader",
    "rev"."meta_grader",
    "rev"."total_score",
    "rev"."tweak",
    "rev"."completed_by",
    "rev"."completed_at",
    "rev"."checked_at",
    "rev"."checked_by",
    "graderprofile"."name" AS "assignedgradername",
    "metagraderprofile"."name" AS "assignedmetagradername",
    "completerprofile"."name" AS "gradername",
    "checkgraderprofile"."name" AS "checkername",
    "ag"."name" AS "groupname",
    "swe"."tokens_consumed",
    "swe"."hours",
    "swe"."due_date",
    ("swe"."due_date" + ('01:00:00'::interval * ("swe"."hours")::double precision)) AS "late_due_date",
    "ar"."grader_sha",
    "ar"."grader_action_sha",
    "swe"."assignment_slug",
    "swe"."class_section_id",
    "cs"."name" AS "class_section_name",
    "swe"."lab_section_id",
    "ls"."name" AS "lab_section_name"
   FROM ((((((((((("submissions_with_extensions" "swe"
     JOIN "public"."profiles" "p" ON (("p"."id" = "swe"."private_profile_id")))
     JOIN "public"."submissions" "s" ON (("s"."id" = "swe"."submission_id")))
     LEFT JOIN "public"."submission_reviews" "rev" ON (("rev"."id" = "s"."grading_review_id")))
     LEFT JOIN "public"."grader_results" "ar" ON (("ar"."submission_id" = "s"."id")))
     LEFT JOIN "public"."assignment_groups" "ag" ON (("ag"."id" = "swe"."assignment_group_id")))
     LEFT JOIN "public"."profiles" "completerprofile" ON (("completerprofile"."id" = "rev"."completed_by")))
     LEFT JOIN "public"."profiles" "graderprofile" ON (("graderprofile"."id" = "rev"."grader")))
     LEFT JOIN "public"."profiles" "metagraderprofile" ON (("metagraderprofile"."id" = "rev"."meta_grader")))
     LEFT JOIN "public"."profiles" "checkgraderprofile" ON (("checkgraderprofile"."id" = "rev"."checked_by")))
     LEFT JOIN "public"."class_sections" "cs" ON (("cs"."id" = "swe"."class_section_id")))
     LEFT JOIN "public"."lab_sections" "ls" ON (("ls"."id" = "swe"."lab_section_id")));

-- Update submissions_with_grades_for_assignment_and_regression_test view to exclude disabled students
-- This view is used for assignment data with regression test results
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
    "ls"."name" AS "lab_section_name"
   FROM (((((((((( SELECT "r"."id",
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
     LEFT JOIN "public"."lab_sections" "ls" ON (("ls"."id" = "activesubmissionsbystudent"."lab_section_id"))));

-- Update the check_assignment_deadlines_passed function to exclude disabled students
-- This function creates self-review assignments and should not include disabled students
CREATE OR REPLACE FUNCTION "public"."check_assignment_deadlines_passed"() RETURNS "void"
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
    JOIN user_roles ur ON ur.private_profile_id = prof.id AND ur.role = 'student' AND ur.disabled = false
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
        WHERE sr.submission_id = s.id AND sr.rubric_id = a.self_review_rubric_id
    );

    -- Then, create review assignments for those submission reviews
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
    JOIN user_roles ur ON ur.private_profile_id = prof.id AND ur.role = 'student' AND ur.disabled = false
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
    AND a.self_review_rubric_id IS NOT NULL
    AND public.calculate_final_due_date(a.id, prof.id, agm.assignment_group_id) <= NOW()
    AND NOT EXISTS (
        SELECT 1 FROM review_assignments ra 
        WHERE ra.assignment_id = a.id AND ra.assignee_profile_id = prof.id
    );
END;
$$;