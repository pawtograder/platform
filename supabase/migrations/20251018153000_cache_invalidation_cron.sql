-- Schedule cache invalidation worker to run every 10 seconds
-- This processes pending cache invalidations and sends them to Vercel

-- First, unschedule if it already exists (for idempotent migrations)
SELECT cron.unschedule('cache-invalidation-worker')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'cache-invalidation-worker'
);

-- Schedule worker to run every 10 seconds
-- Uses pg_net to call the edge function asynchronously
SELECT cron.schedule(
  'cache-invalidation-worker',
  '*/10 * * * * *', -- Every 10 seconds (note: 6-field cron syntax with seconds)
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_project_url') 
           || '/functions/v1/cache-invalidation-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000
  );
  $$
);

-- Add comment for documentation
COMMENT ON EXTENSION cron IS 'pg_cron extension for scheduling cache invalidation worker';

