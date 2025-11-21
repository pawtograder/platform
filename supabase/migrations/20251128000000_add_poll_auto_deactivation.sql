-- Add automatic deactivation support for live polls
-- This allows polls to automatically deactivate after a specified time (e.g., 1 hour)

-- Add deactivates_at column to live_polls table
ALTER TABLE live_polls
ADD COLUMN IF NOT EXISTS deactivates_at TIMESTAMPTZ DEFAULT NULL;

-- Create composite partial index for efficient deactivation queries
-- This index covers the exact WHERE clause used in deactivate_expired_polls()
CREATE INDEX IF NOT EXISTS idx_live_polls_deactivation
  ON live_polls (deactivates_at)
  WHERE is_live = true AND deactivates_at IS NOT NULL;

-- Function to automatically deactivate polls where deactivates_at has passed
CREATE OR REPLACE FUNCTION public.deactivate_expired_polls()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Deactivate polls where deactivates_at has passed
  UPDATE live_polls
  SET is_live = false
  WHERE is_live = true
    AND deactivates_at IS NOT NULL
    AND deactivates_at <= NOW();
END;
$$;

-- Grant execute permission to service_role
REVOKE ALL ON FUNCTION public.deactivate_expired_polls() FROM public;
GRANT EXECUTE ON FUNCTION public.deactivate_expired_polls() TO service_role;

-- Schedule the deactivation job to run once per hour
DO $$
BEGIN
  -- Only create the job if it doesn't already exist
  IF NOT EXISTS (
    SELECT 1 FROM cron.job 
    WHERE jobname = 'deactivate-expired-polls'
  ) THEN
    PERFORM cron.schedule(
      'deactivate-expired-polls',
      '0 * * * *', -- Run at the top of every hour
      'SELECT public.deactivate_expired_polls();'
    );
    RAISE NOTICE 'Scheduled poll auto-deactivation job to run hourly';
  ELSE
    RAISE NOTICE 'Poll auto-deactivation job already exists';
  END IF;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Insufficient privileges to schedule cron job - must be run by superuser';
  WHEN OTHERS THEN
    RAISE NOTICE 'Failed to schedule poll auto-deactivation job: %', SQLERRM;
END $$;

COMMENT ON FUNCTION public.deactivate_expired_polls() IS 
'Automatically deactivates polls where deactivates_at has passed. Scheduled to run hourly via pg_cron.';

COMMENT ON COLUMN live_polls.deactivates_at IS 
'Timestamp when the poll should automatically deactivate. If NULL, the poll will not auto-deactivate.';

