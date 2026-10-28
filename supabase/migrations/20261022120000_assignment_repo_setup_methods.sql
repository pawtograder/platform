-- New github-async-worker methods for creating an assignment's STAFF repositories (the handout
-- and the solution/grader repo) server-side.
--
-- Kept in a file of its own because a value added by ALTER TYPE ... ADD VALUE cannot be used in
-- the transaction that adds it, and 20261022120100_assignment_repo_setup.sql writes these values
-- (api_gateway_calls.method, async_worker_dlq_messages.method). Same split as
-- 20260311140001_repository_analytics_repo_status.sql.
ALTER TYPE public.github_async_method ADD VALUE IF NOT EXISTS 'setup_handout_repo';
ALTER TYPE public.github_async_method ADD VALUE IF NOT EXISTS 'setup_solution_repo';
