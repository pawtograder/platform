-- Expose the advisory suggested_due_date through assignment_overview so the Manage
-- Assignments list can show instructors and TAs when grading should start (#894).
--
-- suggested_due_date is the raw advisory column, display-only: it is not consulted by
-- submission enforcement, late tokens, or lab scheduling. Appended at the end of the select
-- list so existing positional consumers are unaffected.
--
-- Recreated verbatim from 20250819000010_fix_assignment_overview_correlated_subqueries.sql
-- (correlated subqueries, security_invoker) with the one new column added.

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
    ), 0) AS "open_regrade_requests_count",
    "a"."suggested_due_date"
FROM "public"."assignments" "a";

COMMENT ON VIEW "public"."assignment_overview" IS
'Optimized view using correlated subqueries. When filtered by class_id, PostgreSQL processes only assignments in that class and counts submissions individually per assignment, avoiding expensive GroupAggregate operations over large submission sets. Also exposes the advisory suggested_due_date for the Manage Assignments list.';
