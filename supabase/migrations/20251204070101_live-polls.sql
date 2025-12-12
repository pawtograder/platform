DROP TABLE IF EXISTS live_poll_responses CASCADE;
DROP TABLE IF EXISTS live_polls CASCADE;
DROP FUNCTION IF EXISTS set_live_poll_response_submitted_at() CASCADE;
DROP FUNCTION IF EXISTS deactivate_expired_polls() CASCADE;
DROP FUNCTION IF EXISTS broadcast_live_poll_change() CASCADE;
DROP FUNCTION IF EXISTS broadcast_live_poll_response_change() CASCADE;
DROP INDEX IF EXISTS idx_live_polls_class_is_live;
DROP INDEX IF EXISTS idx_live_poll_responses_poll_id;

-- Create live_polls table
CREATE TABLE IF NOT EXISTS live_polls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_id BIGINT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES user_roles(public_profile_id) ON DELETE CASCADE,
    question JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_live BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deactivates_at TIMESTAMPTZ DEFAULT NULL,
    require_login BOOLEAN NOT NULL DEFAULT FALSE
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

-- Broadcast triggers for live polls
CREATE OR REPLACE FUNCTION public.broadcast_live_poll_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    target_class_id bigint;
    staff_payload jsonb;
    affected_profile_ids uuid[];
    profile_id uuid;
BEGIN
    -- Get the class_id from the record
    IF TG_OP = 'INSERT' THEN
        target_class_id := NEW.class_id;
    ELSIF TG_OP = 'UPDATE' THEN
        target_class_id := COALESCE(NEW.class_id, OLD.class_id);
    ELSIF TG_OP = 'DELETE' THEN
        target_class_id := OLD.class_id;
    END IF;

    IF target_class_id IS NOT NULL THEN
        -- Create payload
        staff_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END,
            'data', CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,
            'class_id', target_class_id,
            'timestamp', NOW()
        );

        -- Broadcast to staff channel
        PERFORM realtime.send(
            staff_payload,
            'broadcast',
            'class:' || target_class_id || ':staff',
            true
        );

        -- Broadcast to all students in the class (for live poll visibility)
        SELECT ARRAY(
            SELECT ur.private_profile_id
            FROM user_roles ur
            WHERE ur.class_id = target_class_id AND ur.role = 'student'
        ) INTO affected_profile_ids;

        FOREACH profile_id IN ARRAY affected_profile_ids LOOP
            PERFORM realtime.send(
                staff_payload,
                'broadcast',
                'class:' || target_class_id || ':user:' || profile_id,
                true
            );
        END LOOP;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$;

-- Create trigger for live_polls
DROP TRIGGER IF EXISTS broadcast_live_polls_realtime ON live_polls;
CREATE TRIGGER broadcast_live_polls_realtime
    AFTER INSERT OR UPDATE OR DELETE ON live_polls
    FOR EACH ROW
    EXECUTE FUNCTION broadcast_live_poll_change();


-- Function for live_poll_responses (needs to get class_id from parent poll)
-- Only broadcasts to staff channel since students don't see response counts
CREATE OR REPLACE FUNCTION public.broadcast_live_poll_response_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    target_class_id bigint;
    target_poll_id uuid;
    staff_payload jsonb;
BEGIN
    -- Get the poll_id and class_id
    IF TG_OP = 'INSERT' THEN
        target_poll_id := NEW.live_poll_id;
    ELSIF TG_OP = 'UPDATE' THEN
        target_poll_id := COALESCE(NEW.live_poll_id, OLD.live_poll_id);
    ELSIF TG_OP = 'DELETE' THEN
        target_poll_id := OLD.live_poll_id;
    END IF;

    -- Get class_id from the parent poll
    SELECT class_id INTO target_class_id
    FROM live_polls
    WHERE id = target_poll_id;

    IF target_class_id IS NOT NULL THEN
        -- Create payload
        staff_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END,
            'data', CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,
            'class_id', target_class_id,
            'live_poll_id', target_poll_id,
            'timestamp', NOW()
        );

        -- Only broadcast to staff channel (students don't need response updates)
        PERFORM realtime.send(
            staff_payload,
            'broadcast',
            'class:' || target_class_id || ':staff',
            true
        );
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$;

-- Create trigger for live_poll_responses
DROP TRIGGER IF EXISTS broadcast_live_poll_responses_realtime ON live_poll_responses;
CREATE TRIGGER broadcast_live_poll_responses_realtime
    AFTER INSERT OR UPDATE OR DELETE ON live_poll_responses
    FOR EACH ROW
    EXECUTE FUNCTION broadcast_live_poll_response_change();

-- Enable RLS on both tables
ALTER TABLE live_polls ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_poll_responses ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS live_polls_all_staff ON live_polls;
DROP POLICY IF EXISTS live_polls_select ON live_polls;
DROP POLICY IF EXISTS live_polls_responses_all_staff ON live_poll_responses;
DROP POLICY IF EXISTS live_polls_responses_insert ON live_poll_responses;
DROP POLICY IF EXISTS live_polls_responses_select ON live_poll_responses;

-- Staff (instructors and graders) can do everything on live polls
CREATE POLICY live_polls_all_staff_insert ON live_polls
  FOR INSERT
  TO authenticated
  WITH CHECK (
    authorizeforclassgrader(live_polls.class_id)
    AND authorizeforprofile(live_polls.created_by)
  );

CREATE POLICY live_polls_all_staff_update ON live_polls
  FOR UPDATE
  TO authenticated
  USING (authorizeforclassgrader(live_polls.class_id))
  WITH CHECK (
    authorizeforclassgrader(live_polls.class_id)
    -- Prevent created_by from being changed: NEW.created_by must equal existing created_by
    AND live_polls.created_by = (
      SELECT created_by 
      FROM live_polls 
      WHERE id = live_polls.id
    )
  );

CREATE POLICY live_polls_all_staff_delete ON live_polls
  FOR DELETE
  TO authenticated
  USING (authorizeforclassgrader(live_polls.class_id));

-- Students and anyone can select live polls
-- Frontend handles require_login logic (shows login prompt if needed)
CREATE POLICY live_polls_select ON live_polls
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Staff (instructors and graders) can do everything on live poll responses
CREATE POLICY live_polls_responses_all_staff ON live_poll_responses
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.live_polls lp
      WHERE lp.id = live_poll_responses.live_poll_id
        AND authorizeforclassgrader(lp.class_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.live_polls lp
      WHERE lp.id = live_poll_responses.live_poll_id
        AND authorizeforclassgrader(lp.class_id)
    )
  );

-- can_access_poll_response function handles anonymous users (auth.uid() IS NULL)
CREATE OR REPLACE FUNCTION can_access_poll_response(poll_id uuid, profile_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT CASE
    -- Early exit: if require_login is false, anyone can access (no user_roles query needed)
    WHEN NOT lp.require_login THEN true
    -- If require_login is true, user must be authenticated
    WHEN lp.require_login AND auth.uid() IS NULL THEN false
    -- If require_login is true and user is authenticated, verify class membership and profile ownership
    WHEN lp.require_login AND auth.uid() IS NOT NULL THEN
      -- User must belong to the poll's class
      authorizeforclass(lp.class_id)
      -- Profile_id must be provided when require_login is true
      AND profile_id IS NOT NULL
      -- Profile_id must belong to the authenticated user (prevents impersonation)
      AND authorizeforprofile(profile_id)
    ELSE false
  END
  FROM public.live_polls lp
  WHERE lp.id = poll_id;
$$;

-- Students can insert responses if:
-- 1. require_login is false (anyone can respond, including anonymous with null profile_id), OR
-- 2. require_login is true AND user is authenticated, belongs to the class, and profile_id belongs to the authenticated user
-- Note: Must allow both anon and authenticated roles for anonymous responses when require_login is false
CREATE POLICY live_polls_responses_insert ON live_poll_responses
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (can_access_poll_response(live_poll_responses.live_poll_id, live_poll_responses.public_profile_id));

-- Trigger to automatically set deactivates_at when is_live becomes true
CREATE OR REPLACE FUNCTION public.set_poll_deactivates_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- When is_live changes from false to true, set deactivates_at to 1 hour from now
  IF NEW.is_live = true AND (OLD.is_live = false OR OLD.is_live IS NULL) THEN
    NEW.deactivates_at := NOW() + INTERVAL '1 hour';
  END IF;
  
  -- When is_live changes from true to false, clear deactivates_at
  IF NEW.is_live = false AND OLD.is_live = true THEN
    NEW.deactivates_at := NULL;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create the trigger
DROP TRIGGER IF EXISTS set_poll_deactivates_at_trigger ON live_polls;
CREATE TRIGGER set_poll_deactivates_at_trigger
  BEFORE UPDATE ON live_polls
  FOR EACH ROW
  EXECUTE FUNCTION public.set_poll_deactivates_at();

COMMENT ON FUNCTION public.set_poll_deactivates_at() IS 
'Automatically sets deactivates_at to 1 hour when is_live becomes true, and clears it when is_live becomes false.';


