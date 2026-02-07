-- These indexes were originally created to optimize the assignment_overview view
-- but became obsolete after the correlated-subqueries refactor (see migration
-- 20250819000010_fix_assignment_overview_correlated_subqueries.sql).
-- The drops are safe and should be performed without failing on missing indexes.
DROP INDEX IF EXISTS idx_submissions_assignment_id;
DROP INDEX IF EXISTS submissions_repository_idx;
DROP INDEX IF EXISTS idx_submissions_assignment_id_is_active;
DROP INDEX IF EXISTS idx_submissions_assignment_group_assignment_active;
DROP INDEX IF EXISTS idx_submissions_class_profile_assignment_active_covering;
