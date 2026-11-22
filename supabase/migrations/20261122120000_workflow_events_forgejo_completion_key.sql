-- One workflow_events row per Forgejo run completion; forgejo-repo-webhook treats a unique violation as
-- "already logged". Re-runs keep the run id, so run_updated_at (the stop time) keeps them distinct.
-- Plain CREATE INDEX: migrate.sh runs each migration in one transaction, where CONCURRENTLY fails.

DELETE FROM public.workflow_events a
USING public.workflow_events b
WHERE a.event_type = 'completed'
  AND a.payload->>'provider' = 'forgejo'
  AND b.event_type = 'completed'
  AND b.payload->>'provider' = 'forgejo'
  AND a.workflow_run_id = b.workflow_run_id
  AND a.run_attempt = b.run_attempt
  AND a.run_updated_at = b.run_updated_at
  AND a.id > b.id;

CREATE UNIQUE INDEX IF NOT EXISTS workflow_events_forgejo_completion_key
  ON public.workflow_events (workflow_run_id, run_attempt, run_updated_at)
  WHERE event_type = 'completed' AND payload->>'provider' = 'forgejo';
