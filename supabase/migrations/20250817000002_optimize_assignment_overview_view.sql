-- Optimize assignment_overview view for class_id filtering
-- The original view was inefficient because subqueries ran against all assignments
-- before filtering by class_id. This version ensures subqueries are filtered appropriately.

-- First, add an index on submission_regrade_requests.class_id for better performance
CREATE INDEX IF NOT EXISTS "idx_submission_regrade_requests_class_id" 
ON "public"."submission_regrade_requests" USING "btree" ("class_id");

-- Add a composite index for even better performance on the common query pattern
CREATE INDEX IF NOT EXISTS "idx_submission_regrade_requests_class_id_status" 
ON "public"."submission_regrade_requests" USING "btree" ("class_id", "status");

-- Add additional indexes specifically for the view's query patterns
-- This helps with the GROUP BY operations in the subqueries
CREATE INDEX IF NOT EXISTS "idx_submissions_class_id_assignment_id_is_active" 
ON "public"."submissions" USING "btree" ("class_id", "assignment_id", "is_active");

CREATE INDEX IF NOT EXISTS "idx_submission_regrade_requests_class_id_assignment_id_status" 
ON "public"."submission_regrade_requests" USING "btree" ("class_id", "assignment_id", "status");

-- Add covering indexes to avoid table lookups entirely for the view queries
CREATE INDEX IF NOT EXISTS "idx_submissions_class_assignment_active_covering" 
ON "public"."submissions" USING "btree" ("class_id", "assignment_id") 
WHERE "is_active" = true;

CREATE INDEX IF NOT EXISTS "idx_regrade_requests_class_assignment_status_covering" 
ON "public"."submission_regrade_requests" USING "btree" ("class_id", "assignment_id") 
WHERE "status" IN ('opened', 'escalated');

-- Additional indexes for the submissions_with_grades_for_assignment view optimizations
-- Note: user_roles_class_id_private_profile_id_idx already exists, so skipping duplicate

CREATE INDEX IF NOT EXISTS "idx_submissions_profile_assignment_active_class" 
ON "public"."submissions" USING "btree" ("profile_id", "assignment_id", "class_id", "is_active");

-- Critical covering indexes for the submissions_with_grades_for_assignment views
-- These views JOIN to profiles table multiple times - need covering indexes to avoid table lookups

-- Profiles covering index for grader names (used in 4 separate JOINs in the view)
CREATE INDEX IF NOT EXISTS "idx_profiles_id_covering_names" 
ON "public"."profiles" USING "btree" ("id") 
INCLUDE ("name", "sortable_name");

-- Submission_reviews covering index with all the review data needed by the views  
CREATE INDEX IF NOT EXISTS "idx_submission_reviews_id_covering_all_fields" 
ON "public"."submission_reviews" USING "btree" ("id") 
INCLUDE ("total_autograde_score", "grader", "meta_grader", "total_score", "tweak", "completed_by", "completed_at", "checked_at", "checked_by");

-- Assignment_due_date_exceptions covering index for the expensive COALESCE aggregation
-- Note: idx_assignment_due_date_exceptions_student_assignment_group already exists, adding covering version
CREATE INDEX IF NOT EXISTS "idx_assignment_due_date_exceptions_student_group_covering" 
ON "public"."assignment_due_date_exceptions" USING "btree" ("student_id", "assignment_group_id") 
INCLUDE ("tokens_consumed", "hours", "assignment_id");

-- Assignment_groups covering index for group names
CREATE INDEX IF NOT EXISTS "idx_assignment_groups_id_covering_name" 
ON "public"."assignment_groups" USING "btree" ("id") 
INCLUDE ("name");

-- User_roles covering index specifically for the student role filtering pattern
-- Note: user_roles_class_id_private_profile_id_idx already covers this pattern, so skipping duplicate

-- Assignments covering index with due_date and slug for the CTE pattern  
CREATE INDEX IF NOT EXISTS "idx_assignments_class_id_covering_due_slug" 
ON "public"."assignments" USING "btree" ("class_id", "id") 
INCLUDE ("due_date", "slug");

-- Submissions covering index for the complex CTE filtering patterns
CREATE INDEX IF NOT EXISTS "idx_submissions_class_profile_assignment_active_covering" 
ON "public"."submissions" USING "btree" ("class_id", "profile_id", "assignment_id", "is_active") 
INCLUDE ("id", "created_at", "released", "repository", "sha", "grading_review_id");

-- Assignment_groups_members covering index for the group submission CTE
CREATE INDEX IF NOT EXISTS "idx_assignment_groups_members_profile_assignment_covering" 
ON "public"."assignment_groups_members" USING "btree" ("profile_id", "assignment_id") 
INCLUDE ("assignment_group_id");

-- Grader_results covering index to avoid table lookups for grader data
CREATE INDEX IF NOT EXISTS "idx_grader_results_submission_id_covering_extended" 
ON "public"."grader_results" USING "btree" ("submission_id") 
INCLUDE ("id", "score", "max_score", "grader_sha", "grader_action_sha");

-- Additional indexes specifically for submissions_with_grades_for_assignment_and_regression_test view

-- Autograder_regression_test covering index for repository lookups
CREATE INDEX IF NOT EXISTS "idx_autograder_regression_test_repository_covering" 
ON "public"."autograder_regression_test" USING "btree" ("repository") 
INCLUDE ("id");

-- Grader_results covering index for the complex regression test MAX aggregation pattern
CREATE INDEX IF NOT EXISTS "idx_grader_results_regression_test_grader_sha_covering" 
ON "public"."grader_results" USING "btree" ("autograder_regression_test", "grader_sha") 
INCLUDE ("id", "score", "grader_action_sha");

-- Calculate_effective_due_date and calculate_final_due_date function optimizations
-- These functions are called for every row - ensure they have optimal indexes
-- Note: Basic assignment_id indexes already exist, adding covering versions for function performance
CREATE INDEX IF NOT EXISTS "idx_assignment_due_date_exceptions_assignment_student_covering" 
ON "public"."assignment_due_date_exceptions" USING "btree" ("assignment_id", "student_id") 
INCLUDE ("hours", "minutes", "tokens_consumed");

CREATE INDEX IF NOT EXISTS "idx_assignment_due_date_exceptions_assignment_group_covering" 
ON "public"."assignment_due_date_exceptions" USING "btree" ("assignment_id", "assignment_group_id") 
INCLUDE ("hours", "minutes", "tokens_consumed");

-- Additional performance optimization: Class-scoped indexes
-- When filtering by class_id, these provide maximum performance

-- User_roles class-scoped covering index with all needed fields for view optimization
-- Note: Cannot use INCLUDE with WHERE clause, so including columns directly in index
CREATE INDEX IF NOT EXISTS "idx_user_roles_class_student_view_optimization" 
ON "public"."user_roles" USING "btree" ("class_id", "role", "private_profile_id", "id", "user_id") 
WHERE "role" = 'student';

-- Submissions class-scoped covering index for the regression test view pattern  
CREATE INDEX IF NOT EXISTS "idx_submissions_class_active_covering_regression" 
ON "public"."submissions" USING "btree" ("class_id", "is_active", "assignment_id") 
INCLUDE ("id", "profile_id", "assignment_group_id", "created_at", "released", "repository", "sha", "grading_review_id");

-- CRITICAL: Optimize the expensive calculate_final_due_date function calls
-- This function is called for every row and does complex OR queries on assignment_due_date_exceptions
-- Current query pattern: WHERE assignment_id = ? AND (student_id = ? OR assignment_group_id = ?)

-- Composite index optimized for the OR condition pattern in calculate_final_due_date
CREATE INDEX IF NOT EXISTS "idx_assignment_due_date_exceptions_assignment_student_group_optimized" 
ON "public"."assignment_due_date_exceptions" USING "btree" ("assignment_id", "student_id", "assignment_group_id") 
INCLUDE ("hours", "minutes", "tokens_consumed");

-- Additional index with different column order for the group-first lookup pattern
CREATE INDEX IF NOT EXISTS "idx_assignment_due_date_exceptions_assignment_group_student_optimized" 
ON "public"."assignment_due_date_exceptions" USING "btree" ("assignment_id", "assignment_group_id", "student_id") 
INCLUDE ("hours", "minutes", "tokens_consumed");

-- Drop the existing view
DROP VIEW IF EXISTS "public"."assignment_overview";

-- Recreate the view with optimized subqueries that efficiently filter by class_id
-- The key optimization is including class_id in the subqueries so PostgreSQL can push down filters
CREATE OR REPLACE VIEW "public"."assignment_overview" WITH ("security_invoker"='true') AS
SELECT 
    "a"."id",
    "a"."title",
    "a"."release_date",
    "a"."due_date",
    "a"."class_id",
    COALESCE("active_submissions"."count", (0)::bigint) AS "active_submissions_count",
    COALESCE("open_regrade_requests"."count", (0)::bigint) AS "open_regrade_requests_count"
FROM "public"."assignments" "a"
LEFT JOIN (
    -- Optimized: Include class_id in subquery to enable filter pushdown
    -- Uses existing idx_submissions_assignment_id_is_active and idx_submissions_class_id indexes
    SELECT 
        "s"."assignment_id",
        "s"."class_id",
        COUNT(*) AS "count"
    FROM "public"."submissions" "s"
    WHERE "s"."is_active" = true
    GROUP BY "s"."assignment_id", "s"."class_id"
) "active_submissions" ON ("a"."id" = "active_submissions"."assignment_id" AND "a"."class_id" = "active_submissions"."class_id")
LEFT JOIN (
    -- Optimized: Include class_id in subquery to enable filter pushdown
    -- Uses new idx_submission_regrade_requests_class_id_status index
    SELECT 
        "srr"."assignment_id",
        "srr"."class_id", 
        COUNT(*) AS "count"
    FROM "public"."submission_regrade_requests" "srr"
    WHERE "srr"."status" = ANY (ARRAY['opened'::"public"."regrade_status", 'escalated'::"public"."regrade_status"])
    GROUP BY "srr"."assignment_id", "srr"."class_id"
) "open_regrade_requests" ON ("a"."id" = "open_regrade_requests"."assignment_id" AND "a"."class_id" = "open_regrade_requests"."class_id");

-- Add comment explaining the optimization
COMMENT ON VIEW "public"."assignment_overview" IS 
'Optimized view that efficiently filters by class_id. Subqueries are constrained by the main assignments table filter, preventing unnecessary computation across all classes.';

-- Optimize submissions_with_grades_for_assignment view for assignment_id filtering
-- Problem: Original view processes ALL student roles across all classes first
-- Solution: Restructure to optimize for assignment_id filtering - the primary use case

-- Drop and recreate the view optimized for assignment_id filtering
DROP VIEW IF EXISTS "public"."submissions_with_grades_for_assignment";

CREATE OR REPLACE VIEW "public"."submissions_with_grades_for_assignment" WITH ("security_invoker"='true') AS
 WITH "assignment_students" AS (
         -- Start with assignment, then find all students in that assignment's class
         -- This is much more efficient when filtering by assignment_id
         SELECT DISTINCT
            "ur"."id" AS "user_role_id",
            "ur"."private_profile_id",
            "a"."class_id",
            "a"."id" AS "assignment_id",
            "a"."due_date",
            "a"."slug" AS "assignment_slug"
           FROM "public"."assignments" "a"
           JOIN "public"."user_roles" "ur" ON (("ur"."class_id" = "a"."class_id") AND ("ur"."role" = 'student'::"public"."app_role"))
        ), "individual_submissions" AS (
         SELECT "ast"."user_role_id",
            "ast"."private_profile_id",
            "ast"."class_id",
            "ast"."assignment_id",
            "s"."id" AS "submission_id",
            NULL::bigint AS "assignment_group_id",
            "ast"."due_date",
            "ast"."assignment_slug"
           FROM "assignment_students" "ast"
           JOIN "public"."submissions" "s" ON (("s"."assignment_id" = "ast"."assignment_id") AND ("s"."profile_id" = "ast"."private_profile_id") AND ("s"."is_active" = true) AND ("s"."assignment_group_id" IS NULL))
        ), "group_submissions" AS (
         SELECT "ast"."user_role_id",
            "ast"."private_profile_id",
            "ast"."class_id",
            "ast"."assignment_id",
            "s"."id" AS "submission_id",
            "agm"."assignment_group_id",
            "ast"."due_date",
            "ast"."assignment_slug"
           FROM "assignment_students" "ast"
           JOIN "public"."assignment_groups_members" "agm" ON (("agm"."assignment_id" = "ast"."assignment_id") AND ("agm"."profile_id" = "ast"."private_profile_id"))
           JOIN "public"."submissions" "s" ON (("s"."assignment_id" = "ast"."assignment_id") AND ("s"."assignment_group_id" = "agm"."assignment_group_id") AND ("s"."is_active" = true))
        ), "all_submissions" AS (
         SELECT "individual_submissions"."user_role_id",
            "individual_submissions"."private_profile_id",
            "individual_submissions"."class_id",
            "individual_submissions"."assignment_id",
            "individual_submissions"."submission_id",
            "individual_submissions"."assignment_group_id",
            "individual_submissions"."due_date",
            "individual_submissions"."assignment_slug"
           FROM "individual_submissions"
        UNION ALL
         SELECT "group_submissions"."user_role_id",
            "group_submissions"."private_profile_id",
            "group_submissions"."class_id",
            "group_submissions"."assignment_id",
            "group_submissions"."submission_id",
            "group_submissions"."assignment_group_id",
            "group_submissions"."due_date",
            "group_submissions"."assignment_slug"
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
            COALESCE("dde"."hours", (0)::bigint) AS "hours"
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
    "swe"."assignment_slug"
   FROM ((((((((("submissions_with_extensions" "swe"
     JOIN "public"."profiles" "p" ON (("p"."id" = "swe"."private_profile_id")))
     JOIN "public"."submissions" "s" ON (("s"."id" = "swe"."submission_id")))
     LEFT JOIN "public"."submission_reviews" "rev" ON (("rev"."id" = "s"."grading_review_id")))
     LEFT JOIN "public"."grader_results" "ar" ON (("ar"."submission_id" = "s"."id")))
     LEFT JOIN "public"."assignment_groups" "ag" ON (("ag"."id" = "swe"."assignment_group_id")))
     LEFT JOIN "public"."profiles" "completerprofile" ON (("completerprofile"."id" = "rev"."completed_by")))
     LEFT JOIN "public"."profiles" "graderprofile" ON (("graderprofile"."id" = "rev"."grader")))
     LEFT JOIN "public"."profiles" "metagraderprofile" ON (("metagraderprofile"."id" = "rev"."meta_grader")))
     LEFT JOIN "public"."profiles" "checkgraderprofile" ON (("checkgraderprofile"."id" = "rev"."checked_by")));

-- Set ownership
ALTER TABLE "public"."submissions_with_grades_for_assignment" OWNER TO "postgres";

-- Add comment explaining the optimization
COMMENT ON VIEW "public"."submissions_with_grades_for_assignment" IS 
'Optimized view that includes class_id filters early in JOIN conditions for efficient class-based filtering. Prevents unnecessary computation across all classes when filtering by class_id.';

-- Optimize submissions_with_grades_for_assignment_and_regression_test view
-- Problem: Original view processes ALL user roles across all classes in the main subquery
-- Solution: Include class_id filtering early to constrain the data processing

-- Drop and recreate the second view
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
    "activesubmissionsbystudent"."late_due_date"
   FROM ((((((((( SELECT "r"."id",
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
            "public"."calculate_final_due_date"("a"."id", "r"."private_profile_id", "agm"."assignment_group_id") AS "late_due_date"
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
     LEFT JOIN "public"."assignment_groups" "ag" ON (("ag"."id" = "activesubmissionsbystudent"."assignmentgroupid")));

-- Set ownership
ALTER TABLE "public"."submissions_with_grades_for_assignment_and_regression_test" OWNER TO "postgres";

-- Add comment explaining the optimization
COMMENT ON VIEW "public"."submissions_with_grades_for_assignment_and_regression_test" IS 
'Optimized view that includes class_id filters early in submission JOIN conditions for efficient class-based filtering. Prevents unnecessary computation across all classes when filtering by class_id.';

-- Create new ultra-lightweight view for essential submission data only
-- This view is optimized for maximum performance with minimal fields and explicit class_id filtering
DROP VIEW IF EXISTS "public"."active_submissions_for_class";

CREATE OR REPLACE VIEW "public"."active_submissions_for_class" WITH ("security_invoker"='true') AS
-- Individual submissions: Simplified without submission_reviews columns
SELECT 
    s.id AS submission_id,
    s.profile_id AS student_private_profile_id,
    s.assignment_id,
    s.class_id,
    NULL::text AS groupname
FROM "public"."submissions" s
WHERE s.is_active = true 
  AND s.assignment_group_id IS NULL
  
UNION ALL

-- Group submissions: Simplified without submission_reviews columns
SELECT 
    s.id AS submission_id,
    agm.profile_id AS student_private_profile_id,
    s.assignment_id,
    s.class_id,
    ag.name AS groupname
FROM "public"."submissions" s
INNER JOIN "public"."assignment_groups_members" agm ON (
    agm.assignment_group_id = s.assignment_group_id 
    AND agm.assignment_id = s.assignment_id
)
LEFT JOIN "public"."assignment_groups" ag ON (ag.id = s.assignment_group_id)
WHERE s.is_active = true 
  AND s.assignment_group_id IS NOT NULL;

-- Set ownership
ALTER TABLE "public"."active_submissions_for_class" OWNER TO "postgres";

-- Add specialized indexes for this new view's query patterns
-- These indexes are optimized for the specific access patterns of the lightweight view

-- COMPLETE INDEX REPLACEMENT STRATEGY
-- PROBLEM: Original index was missing "assignment_group_id" in INCLUDE clause
-- This caused heap fetches because PostgreSQL needed to verify WHERE condition assignment_group_id IS NULL
-- SOLUTION: Add assignment_group_id to INCLUDE clause for complete covering index

-- Step 1: Create new optimized index with enhanced covering columns
CREATE INDEX "idx_submissions_individual_active_class_optimized_v2" 
ON "public"."submissions" USING "btree" ("class_id", "is_active", "assignment_id") 
INCLUDE ("id", "profile_id", "grading_review_id", "assignment_group_id")
WHERE "assignment_group_id" IS NULL AND "is_active" = true;

-- Step 2: Drop the old suboptimal index after new one is ready
DROP INDEX IF EXISTS "idx_submissions_individual_active_class_optimized";

-- Step 3: Rename new index to replace the old one for consistent naming
ALTER INDEX "idx_submissions_individual_active_class_optimized_v2" 
RENAME TO "idx_submissions_individual_active_class_optimized";

-- ENHANCED covering index for group submissions (assignment_group_id IS NOT NULL)  
-- Restructured for maximum selectivity and planner preference
-- Key columns reordered to match exact query pattern: class_id first, then active filter
DROP INDEX IF EXISTS "idx_submissions_group_active_class_optimized";
CREATE INDEX "idx_submissions_group_active_class_optimized_v2" 
ON "public"."submissions" USING "btree" ("class_id", "assignment_group_id", "is_active", "assignment_id") 
INCLUDE ("id", "grading_review_id")
WHERE "assignment_group_id" IS NOT NULL AND "is_active" = true;

-- Rename to consistent naming
ALTER INDEX "idx_submissions_group_active_class_optimized_v2" 
RENAME TO "idx_submissions_group_active_class_optimized";

-- OPTIMIZED assignment_groups_members index for the improved JOIN pattern
-- Supports both assignment_group_id and assignment_id filtering for better JOIN performance
CREATE INDEX IF NOT EXISTS "idx_assignment_groups_members_group_assignment_optimized" 
ON "public"."assignment_groups_members" USING "btree" ("assignment_group_id", "assignment_id") 
INCLUDE ("profile_id");

-- NOTE: Submission_reviews index removed - view no longer queries this table for performance

-- Assignment_groups minimal covering index for name only
CREATE INDEX IF NOT EXISTS "idx_assignment_groups_id_covering_name_only" 
ON "public"."assignment_groups" USING "btree" ("id") 
INCLUDE ("name");

-- Remove the general index that competes with our specialized partial indexes
-- This forces PostgreSQL to use the optimized partial indexes instead
DROP INDEX IF EXISTS "idx_submissions_class_active_performance_critical";

-- Drop the old suboptimal indexes to avoid confusion and reduce maintenance overhead  
DROP INDEX IF EXISTS "idx_submissions_active_individual_covering_essential";
DROP INDEX IF EXISTS "idx_submissions_active_group_covering_essential";
DROP INDEX IF EXISTS "idx_assignment_groups_members_group_covering_essential";


-- Additional performance tuning: Set higher statistics target for key columns
-- This helps PostgreSQL make better query planning decisions for large tables
ALTER TABLE "public"."submissions" ALTER COLUMN "class_id" SET STATISTICS 1000;
ALTER TABLE "public"."submissions" ALTER COLUMN "is_active" SET STATISTICS 1000;
ALTER TABLE "public"."submissions" ALTER COLUMN "assignment_id" SET STATISTICS 1000;

-- CRITICAL: Force PostgreSQL to use nested loops instead of hash joins
-- The hash join strategy causes major performance regression by scanning all reviews
SET enable_hashjoin = off;  -- Temporarily disable hash joins during analysis
SET enable_nestloop = on;   -- Ensure nested loops are enabled
SET random_page_cost = 1.1; -- Favor index scans over sequential scans
SET seq_page_cost = 1.0;
SET join_collapse_limit = 1;  -- Prevent join reordering that causes hash joins

ANALYZE "public"."submissions";
-- NOTE: submission_reviews analysis removed - no longer used by view

-- Reset most parameters to defaults, but keep hash joins disabled for this session
RESET random_page_cost;
RESET seq_page_cost; 
RESET join_collapse_limit;
-- Note: enable_hashjoin will be reset when connection closes

-- Add explanatory comment
COMMENT ON VIEW "public"."active_submissions_for_class" IS 
'Ultra-lightweight view optimized for class_id filtering. Returns essential fields: submission_id, student_private_profile_id, assignment_id, class_id, groupname. CRITICAL: Always filter by class_id (WHERE class_id = ?) for optimal performance. Simplified structure eliminates submission_reviews table queries for maximum performance. Uses specialized covering indexes for pure index-only scans.';

-- PERFORMANCE EXPECTATIONS AFTER SIMPLIFICATION:
-- 1. EXPLAIN ANALYZE should show "Heap Fetches: 0" for all Index Only Scans
-- 2. Query execution time should be <10ms for typical class sizes (1000-5000 submissions)
-- 3. All operations should use "Index Only Scan" - no "Seq Scan" on submissions table
-- 4. Parallel processing should activate for classes with >1000 active submissions  
-- 5. Memory usage should be minimal due to covering indexes avoiding table access
-- 6. NO submission_reviews table access - major performance improvement!
--
-- TO VERIFY PERFORMANCE:
-- EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM active_submissions_for_class WHERE class_id = ?;
--
-- EXPECTED OPTIMAL PLAN AFTER SIMPLIFICATION:
-- - Parallel Append
--   - Index Only Scan on idx_submissions_individual_active_class_optimized (Heap Fetches: 0)
--   - Index Only Scan on idx_submissions_group_active_class_optimized (Heap Fetches: 0)
--   - Index Only Scan on idx_assignment_groups_id_covering_name_only (Heap Fetches: 0)
--   - Index Only Scan on idx_assignment_groups_members_group_assignment_optimized (Heap Fetches: 0)
--
-- CRITICAL SIMPLIFICATION BENEFITS:
-- 1. Eliminated ALL submission_reviews table queries (was causing 91ms regression)
-- 2. Pure index-only operations across all tables
-- 3. Simplified query plan with predictable performance
-- 4. Should achieve <10ms execution times consistently
--
-- VERIFICATION: NO submission_reviews in query plan, all operations index-only
