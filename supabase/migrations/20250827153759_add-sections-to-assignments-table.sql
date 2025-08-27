DROP VIEW IF EXISTS "public"."submissions_with_grades_for_assignment";

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
             JOIN "public"."user_roles" "ur" ON ((("ur"."class_id" = "a"."class_id") AND ("ur"."role" = 'student'::"public"."app_role"))))
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
            "sum"("ade"."tokens_consumed") AS "tokens_consumed",
            "sum"("ade"."hours") AS "hours"
           FROM ("public"."assignment_due_date_exceptions" "ade"
             LEFT JOIN "public"."assignment_groups_members" "ag_1" ON (("ade"."assignment_group_id" = "ag_1"."assignment_group_id")))
          GROUP BY COALESCE("ade"."student_id", "ag_1"."profile_id"), COALESCE("ade"."assignment_group_id", "ag_1"."assignment_group_id")
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
             LEFT JOIN "due_date_extensions" "dde" ON ((("dde"."effective_student_id" = "asub"."private_profile_id") AND ((("asub"."assignment_group_id" IS NULL) AND ("dde"."effective_assignment_group_id" IS NULL)) OR ("asub"."assignment_group_id" = "dde"."effective_assignment_group_id")))))
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
   FROM ((((((((("submissions_with_extensions" "swe"
     JOIN "public"."profiles" "p" ON (("p"."id" = "swe"."private_profile_id")))
     JOIN "public"."submissions" "s" ON (("s"."id" = "swe"."submission_id")))
     LEFT JOIN "public"."submission_reviews" "rev" ON (("rev"."id" = "s"."grading_review_id")))
     LEFT JOIN "public"."grader_results" "ar" ON (("ar"."submission_id" = "s"."id")))
     LEFT JOIN "public"."assignment_groups" "ag" ON (("ag"."id" = "swe"."assignment_group_id")))
     LEFT JOIN "public"."profiles" "completerprofile" ON (("completerprofile"."id" = "rev"."completed_by")))
     LEFT JOIN "public"."profiles" "graderprofile" ON (("graderprofile"."id" = "rev"."grader")))
     LEFT JOIN "public"."profiles" "metagraderprofile" ON (("metagraderprofile"."id" = "rev"."meta_grader")))
     LEFT JOIN "public"."profiles" "checkgraderprofile" ON (("checkgraderprofile"."id" = "rev"."checked_by"))
     LEFT JOIN "public"."class_sections" "cs" ON (("cs"."id" = "swe"."class_section_id"))
     LEFT JOIN "public"."lab_sections" "ls" ON (("ls"."id" = "swe"."lab_section_id")));


ALTER TABLE "public"."submissions_with_grades_for_assignment" OWNER TO "postgres";


COMMENT ON VIEW "public"."submissions_with_grades_for_assignment" IS 'Optimized view that includes class_id filters early in JOIN conditions for efficient class-based filtering. Prevents unnecessary computation across all classes when filtering by class_id.';



DROP VIEW IF EXISTS "public"."submissions_with_grades_for_assignment_and_regression_test";
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
                    "assignment_due_date_exceptions"."assignment_group_id"
                   FROM "public"."assignment_due_date_exceptions"
                  GROUP BY "assignment_due_date_exceptions"."student_id", "assignment_due_date_exceptions"."assignment_group_id") "lt" ON (((("agm"."assignment_group_id" IS NULL) AND ("lt"."student_id" = "r"."private_profile_id")) OR (("agm"."assignment_group_id" IS NOT NULL) AND ("lt"."assignment_group_id" = "agm"."assignment_group_id")))))
             LEFT JOIN "public"."submissions" "gsub" ON ((("gsub"."assignment_group_id" = "agm"."assignment_group_id") AND ("gsub"."is_active" = true) AND ("gsub"."assignment_id" = "a"."id") AND ("gsub"."class_id" = "r"."class_id"))))
          WHERE ("r"."role" = 'student'::"public"."app_role")) "activesubmissionsbystudent"
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


ALTER TABLE "public"."submissions_with_grades_for_assignment_and_regression_test" OWNER TO "postgres";


COMMENT ON VIEW "public"."submissions_with_grades_for_assignment_and_regression_test" IS 'Optimized view that includes class_id filters early in submission JOIN conditions for efficient class-based filtering. Prevents unnecessary computation across all classes when filtering by class_id.';