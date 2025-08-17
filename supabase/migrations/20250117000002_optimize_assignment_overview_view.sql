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
