-- Fix assignment_overview view performance by using correlated subqueries
-- Problem: Current view scans ALL active submissions in class (14,594 rows) then groups
-- Solution: Use correlated subqueries that count submissions per assignment individually

-- Add optimized indexes specifically for the correlated subquery pattern
-- These indexes are optimized for (assignment_id, is_active) lookups
CREATE INDEX IF NOT EXISTS "idx_submissions_assignment_active_optimized" 
ON "public"."submissions" USING "btree" ("assignment_id", "is_active")
WHERE "is_active" = true;

CREATE INDEX IF NOT EXISTS "idx_submission_regrade_requests_assignment_status_optimized" 
ON "public"."submission_regrade_requests" USING "btree" ("assignment_id", "status")
WHERE "status" IN ('opened', 'escalated');

-- Drop and recreate the view with correlated subqueries
DROP VIEW IF EXISTS "public"."assignment_overview";

CREATE OR REPLACE VIEW "public"."assignment_overview" WITH ("security_invoker"='true') AS
SELECT 
    "a"."id",
    "a"."title", 
    "a"."release_date",
    "a"."due_date",
    "a"."class_id",
    -- Correlated subquery: Only counts submissions for THIS assignment
    COALESCE((
        SELECT COUNT(*)
        FROM "public"."submissions" "s"
        WHERE "s"."assignment_id" = "a"."id" 
          AND "s"."is_active" = true
    ), 0) AS "active_submissions_count",
    -- Correlated subquery: Only counts regrade requests for THIS assignment  
    COALESCE((
        SELECT COUNT(*)
        FROM "public"."submission_regrade_requests" "srr"
        WHERE "srr"."assignment_id" = "a"."id"
          AND "srr"."status" = ANY (ARRAY['opened'::"public"."regrade_status", 'escalated'::"public"."regrade_status"])
    ), 0) AS "open_regrade_requests_count"
FROM "public"."assignments" "a";

-- Add comment explaining the optimization
COMMENT ON VIEW "public"."assignment_overview" IS 
'Optimized view using correlated subqueries. When filtered by class_id, PostgreSQL processes only assignments in that class and counts submissions individually per assignment, avoiding expensive GroupAggregate operations over large submission sets.';

-- PERFORMANCE EXPECTATIONS:
-- 1. When filtering by class_id with few assignments (typical case), should be <10ms
-- 2. Uses assignment_id indexes directly for each count operation
-- 3. Avoids scanning all class submissions upfront
-- 4. Scales with number of assignments, not total submissions in class
--
-- QUERY PATTERN FOR OPTIMAL PERFORMANCE:
-- SELECT * FROM assignment_overview WHERE class_id = ?;
--
-- EXPECTED PLAN:
-- - Nested Loop for each assignment in class
-- - Index Only Scan on assignments by class_id  
-- - For each assignment: Index Only Scan on submissions by assignment_id
-- - For each assignment: Index Only Scan on regrade_requests by assignment_id
