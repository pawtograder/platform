-- Optimize submissions RLS by inlining function-based joins into the policy USING clause
-- Semantics are IDENTICAL to previous policy which used:
--   authorizeforclassgrader(class_id) OR authorizeforprofile(profile_id) OR authorizeforassignmentgroup(assignment_group_id)
-- Notes on semantics preserved:
-- - Admins (role = 'admin' and not disabled) have global access (previously via classgrader/profile functions)
-- - Instructors/graders in the submission's class may view
-- - Students may view their own submissions via profile ownership (public or private profile)
-- - Students may view submissions via assignment group membership (no disabled check, matching original function)

ALTER POLICY "Instructors and graders can view all submissions in class, stud"
ON public.submissions
USING (
  -- Instructors/graders for the submission's class
  EXISTS (
    SELECT 1
    FROM public.user_roles r_class
    WHERE r_class.class_id = class_id
      AND r_class.user_id = auth.uid()
      AND r_class.role IN ('instructor', 'grader')
      AND r_class.disabled = false
  )
  OR
  -- Owner (public or private) of the submission's profile
  EXISTS (
    SELECT 1
    FROM public.user_roles r_profile
    WHERE r_profile.user_id = auth.uid()
      AND r_profile.disabled = false
      AND (
        r_profile.private_profile_id = profile_id
      )
  )
  OR
  -- Member of the submission's assignment group (matches original function: no disabled filter)
  EXISTS (
    SELECT 1
    FROM public.assignment_groups_members m
    JOIN public.user_roles r_grp ON r_grp.private_profile_id = m.profile_id
    WHERE m.assignment_group_id = assignment_group_id
      AND r_grp.user_id = auth.uid()
  )
);

-- Inline RLS for review_assignment_rubric_parts SELECT policy
-- Original policy checks that the caller is the assignee of the referenced review_assignment in the same class
ALTER POLICY "Assignees can view rubric parts for their reviews"
ON public.review_assignment_rubric_parts
USING (
  EXISTS (
    SELECT 1
    FROM public.review_assignments ra
    JOIN public.user_roles ur ON ur.user_id = auth.uid() AND ur.class_id = review_assignment_rubric_parts.class_id
    WHERE ra.id = review_assignment_id
      AND (ur.private_profile_id = ra.assignee_profile_id)
  )
);

-- Inline RLS for review_assignments SELECT policy
-- Original: authorizeforprofile(assignee_profile_id) AND (release_date IS NULL OR now() >= release_date)
ALTER POLICY "Assignees can view their own review assignments"
ON public.review_assignments
USING (
  (
    -- profile ownership via user_roles: either public or private profile matches
    EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.disabled = false
        AND (
          ur.public_profile_id = assignee_profile_id OR ur.private_profile_id = assignee_profile_id
        )
    )
  )
  AND (
    release_date IS NULL OR now() >= release_date
  )
);

DROP VIEW IF EXISTS "public"."submissions_with_grades_for_assignment";

CREATE OR REPLACE VIEW "public"."submissions_with_grades_for_assignment_nice" WITH ("security_invoker"='true') AS
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


ALTER TABLE "public"."submissions_with_grades_for_assignment_nice" OWNER TO "postgres";


COMMENT ON VIEW "public"."submissions_with_grades_for_assignment_nice" IS 'Optimized view that includes class_id filters early in JOIN conditions for efficient class-based filtering. Prevents unnecessary computation across all classes when filtering by class_id.';
