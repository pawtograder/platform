-- Drop existing objects (tables CASCADE will drop their triggers automatically)
DROP TABLE IF EXISTS live_poll_responses CASCADE;
DROP TABLE IF EXISTS live_polls CASCADE;

-- Drop function
DROP FUNCTION IF EXISTS set_live_poll_response_submitted_at() CASCADE;

-- Create live_polls table
CREATE TABLE live_polls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_id BIGINT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES user_roles(public_profile_id) ON DELETE CASCADE,
    question JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_live BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deactivates_at TIMESTAMPTZ DEFAULT NULL
);

-- Create live_poll_responses table
CREATE TABLE live_poll_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  live_poll_id UUID NOT NULL REFERENCES live_polls(id) ON DELETE CASCADE,
  public_profile_id UUID REFERENCES user_roles(public_profile_id) ON DELETE CASCADE, --Anonymous responses are allowed
  response JSONB NOT NULL DEFAULT '{}'::jsonb, 
  submitted_at TIMESTAMPTZ DEFAULT NULL,
  is_submitted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT live_poll_responses_unique_per_profile UNIQUE (live_poll_id, public_profile_id)
);

-- Automatically set submitted_at when a response is submitted
CREATE OR REPLACE FUNCTION set_live_poll_response_submitted_at()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.is_submitted = TRUE
     AND (OLD.is_submitted = FALSE OR OLD.is_submitted IS NULL) THEN
    NEW.submitted_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_live_poll_responses_set_submitted_at
  BEFORE INSERT OR UPDATE ON live_poll_responses
  FOR EACH ROW
  EXECUTE FUNCTION set_live_poll_response_submitted_at();

-- Helpful indexes for querying
CREATE INDEX idx_live_polls_class_is_live
  ON live_polls (class_id, is_live);

CREATE INDEX idx_live_poll_responses_poll_id
  ON live_poll_responses (live_poll_id);

CREATE INDEX idx_live_poll_responses_profile_id
  ON live_poll_responses (public_profile_id);




-- Index for efficient deactivation queries
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

