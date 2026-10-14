-- Fixtures for scenario 5, the concurrency storm.
--
-- Six orgs x 400 ready messages. sleep_seconds in the storm is 600, so nothing a caller is handed
-- can become visible again during the run: every message the storm delivers is delivered exactly
-- once or the run has found a bug.
\set ON_ERROR_STOP on

select harness.reset();
delete from harness.claims where scenario = '5 concurrency';

select harness.seed(101, 400);
select harness.seed(102, 400);
select harness.seed(103, 400, false);   -- sync_repo_permissions shape: no args.org
select harness.seed(104, 400);
select harness.seed(105, 400, false);
select harness.seed(106, 400);

analyze pgmq.q_async_calls;
analyze public.classes;

select count(*) as messages_enqueued from pgmq.q_async_calls;
