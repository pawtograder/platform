-- Fix submissions_with_grades_for_assignment_and_regression_test view to return exactly one row per active submission
-- The previous version would return duplicate rows when a submission had multiple grader_results entries
-- (which happens when the autograder is re-run with different grader versions)
-- 
-- This fix uses a subquery to get only the most recent grader result per submission (by id, which is auto-incrementing)

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
   FROM (((((((((((
        -- Subquery to get all active students with their submissions
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
    -- Get only the most recent grader result for each submission (development autograder)
    -- Uses a subquery to get max(id) per submission_id, ensuring exactly one row per submission
    LEFT JOIN (
        SELECT DISTINCT ON ("submission_id")
            "id",
            "submission_id",
            "grader_sha",
            "grader_action_sha"
        FROM "public"."grader_results"
        WHERE "autograder_regression_test" IS NULL  -- Only development runs, not regression test runs
        ORDER BY "submission_id", "id" DESC  -- Most recent (highest id) per submission
    ) "ar" ON (("ar"."submission_id" = "s"."id")))
    LEFT JOIN "public"."autograder_regression_test" "rt" ON (("rt"."repository" = "s"."repository")))
    -- Get only the most recent regression test result for each autograder_regression_test
    -- Uses DISTINCT ON to ensure exactly one row per regression test, getting the highest id
    LEFT JOIN (
        SELECT DISTINCT ON ("autograder_regression_test")
            "id",
            "autograder_regression_test",
            "score",
            "grader_sha",
            "grader_action_sha"
        FROM "public"."grader_results"
        WHERE "autograder_regression_test" IS NOT NULL
        ORDER BY "autograder_regression_test", "id" DESC  -- Most recent (highest id) per regression test
    ) "ar_rt" ON (("ar_rt"."autograder_regression_test" = "rt"."id")))
    LEFT JOIN "public"."assignment_groups" "ag" ON (("ag"."id" = "activesubmissionsbystudent"."assignmentgroupid")))
    LEFT JOIN "public"."class_sections" "cs" ON (("cs"."id" = "activesubmissionsbystudent"."class_section_id")))
    LEFT JOIN "public"."lab_sections" "ls" ON (("ls"."id" = "activesubmissionsbystudent"."lab_section_id")))
    LEFT JOIN "public"."repositories" "repo" ON (("repo"."repository" = "s"."repository")));

COMMENT ON VIEW "public"."submissions_with_grades_for_assignment_and_regression_test" IS 
'View that returns exactly one row per active submission for each student, paired with:
- The most recent development autograder result (grader_sha, grader_action_sha) if any exists
- The most recent regression test result for the repository if any exists
- The rerun_queued_at timestamp from the repository if a rerun is pending

The development autograder is identified by grader_results where autograder_regression_test IS NULL.
The most recent result is determined by the highest id (auto-incrementing primary key).';
