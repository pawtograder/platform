-- Not CONCURRENTLY: migrate.sh runs each migration in a transaction, where CONCURRENTLY fails.
-- The key is the completion as Forgejo reports it: the run id and its stop time. run_attempt is
-- inferred from the submissions visible at delivery, so it can differ between a delivery and its
-- replay and is kept as metadata only. A re-run keeps its run id but stops at a new time, so it
-- still gets its own row.
-- NULLS NOT DISTINCT: redeliveries of a completion with no stop time must still collide.

DELETE FROM public.workflow_events a
USING public.workflow_events b
WHERE a.event_type = 'completed'
  AND a.payload->>'provider' = 'forgejo'
  AND b.event_type = 'completed'
  AND b.payload->>'provider' = 'forgejo'
  AND a.workflow_run_id = b.workflow_run_id
  AND a.run_updated_at IS NOT DISTINCT FROM b.run_updated_at
  AND a.id > b.id;

CREATE UNIQUE INDEX IF NOT EXISTS workflow_events_forgejo_completion_key
  ON public.workflow_events (workflow_run_id, run_updated_at) NULLS NOT DISTINCT
  WHERE event_type = 'completed' AND payload->>'provider' = 'forgejo';
