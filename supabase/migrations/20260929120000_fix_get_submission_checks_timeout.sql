-- Fix the Checks tab timing out: get_submission_checks() scanned all of
-- workflow_events on every call ("canceling statement due to statement timeout").
--
-- Two causes, both fixed here:
--
-- 1. 20251006232741_reduce-db-ram-usage.sql dropped idx_workflow_events_head_sha
--    when nothing filtered on head_sha. 20260606000000_github_deployments.sql
--    later added get_submission_checks(), which does. Restore the index.
--
-- 2. Even with the index, the function as written could not use it for a
--    caller subject to RLS. It joined
--        workflow_events we ON we.head_sha = coalesce(s.head_sha, s.sha)
--    and under RLS the planner kept that join clause above workflow_events'
--    policy quals instead of using it as an index condition, so it seq-scanned
--    the table and filtered afterwards (production: 1.13M rows read, 9 kept,
--    ~4s). Resolving the sha first, as a scalar subquery, turns it into a
--    parameter the planner can use in an index condition.
--
--    Authorization is unchanged: the subquery reads submissions under the
--    caller's RLS (SECURITY INVOKER), so a submission the caller can't see
--    yields NULL, and NULL matches no row.
--
-- PLAIN CREATE INDEX, not CONCURRENTLY: migrate.sh applies each migration under
-- `psql --single-transaction`, where CONCURRENTLY errors and fails the deploy
-- (see 20260904120000_metrics_gap_remediation.sql). A plain build holds a lock
-- that blocks writes to workflow_events while it runs. If that matters, create
-- the index by hand first:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workflow_events_head_sha
--     ON public.workflow_events USING btree (head_sha);
--
-- and the CREATE INDEX below becomes a no-op.

CREATE INDEX IF NOT EXISTS idx_workflow_events_head_sha
  ON public.workflow_events USING btree (head_sha);

CREATE OR REPLACE FUNCTION public.get_submission_checks(p_submission_id bigint)
RETURNS SETOF public.workflow_events
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT we.*
  FROM public.workflow_events we
  WHERE we.head_sha = (
    SELECT coalesce(s.head_sha, s.sha)
    FROM public.submissions s
    WHERE s.id = p_submission_id
  );
$$;
