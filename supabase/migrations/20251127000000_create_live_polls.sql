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
    title TEXT NOT NULL,
    question JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_live BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create live_poll_responses table
CREATE TABLE live_poll_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  live_poll_id UUID NOT NULL REFERENCES live_polls(id) ON DELETE CASCADE,
  public_profile_id UUID NOT NULL REFERENCES user_roles(public_profile_id) ON DELETE CASCADE,
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

