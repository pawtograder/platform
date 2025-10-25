-- Drop existing objects (tables CASCADE will drop their triggers automatically)
DROP TABLE IF EXISTS survey_responses CASCADE;
DROP TABLE IF EXISTS survey_templates CASCADE;
DROP TABLE IF EXISTS surveys CASCADE;

-- Drop functions and types
DROP FUNCTION IF EXISTS update_updated_at_survey_column() CASCADE;
DROP FUNCTION IF EXISTS set_survey_submitted_at() CASCADE;
DROP TYPE IF EXISTS survey_status CASCADE;

-- Create ENUM type for survey status
CREATE TYPE survey_status AS ENUM('draft', 'published', 'closed');

-- Create surveys table
CREATE TABLE surveys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id bigint NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  class_section_id bigint NOT NULL REFERENCES class_sections(id) ON DELETE CASCADE,
  assigned_by UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  status survey_status NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1
);

-- Create survey_templates table
CREATE TABLE survey_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    template JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create responses table
CREATE TABLE survey_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id UUID NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  response JSONB NOT NULL DEFAULT '{}'::jsonb,
  submitted_at TIMESTAMPTZ DEFAULT NULL,
  is_submitted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create unique constraint to prevent duplicate responses from same user
CREATE UNIQUE INDEX idx_responses_survey_user ON survey_responses(survey_id, profile_id);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_survey_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers to automatically update updated_at
CREATE TRIGGER update_surveys_updated_at
  BEFORE UPDATE ON surveys
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_survey_column();

CREATE TRIGGER update_survey_responses_updated_at
  BEFORE UPDATE ON survey_responses
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_survey_column();

CREATE TRIGGER update_survey_templates_updated_at
  BEFORE UPDATE ON survey_templates
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_survey_column();

-- Automatically set submitted_at when survey is submitted
CREATE OR REPLACE FUNCTION set_survey_submitted_at()
RETURNS TRIGGER AS $$
BEGIN
  -- Only set submitted_at when is_submitted changes from false to true
  IF NEW.is_submitted = TRUE AND (OLD.is_submitted = FALSE OR OLD.is_submitted IS NULL) THEN
    NEW.submitted_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_survey_submitted_at_trigger
  BEFORE UPDATE ON survey_responses
  FOR EACH ROW
  EXECUTE FUNCTION set_survey_submitted_at();

--TODO: ENABLE RLS