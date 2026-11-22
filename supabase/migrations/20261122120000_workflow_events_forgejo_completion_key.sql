-- Not CONCURRENTLY: migrate.sh runs each migration in a transaction, where CONCURRENTLY fails.
-- NULLS NOT DISTINCT: a completion that can't be tied to one attempt is stored with a null
-- run_attempt, and its redeliveries must still collide.

DELETE FROM public.workflow_events a
USING public.workflow_events b
WHERE a.event_type = 'completed'
  AND a.payload->>'provider' = 'forgejo'
  AND b.event_type = 'completed'
  AND b.payload->>'provider' = 'forgejo'
  AND a.workflow_run_id = b.workflow_run_id
  AND a.run_attempt IS NOT DISTINCT FROM b.run_attempt
  AND a.run_updated_at IS NOT DISTINCT FROM b.run_updated_at
  AND a.id > b.id;

CREATE UNIQUE INDEX IF NOT EXISTS workflow_events_forgejo_completion_key
  ON public.workflow_events (workflow_run_id, run_attempt, run_updated_at) NULLS NOT DISTINCT
  WHERE event_type = 'completed' AND payload->>'provider' = 'forgejo';
