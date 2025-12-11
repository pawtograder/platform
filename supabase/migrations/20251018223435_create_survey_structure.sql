-- Drop existing objects (tables CASCADE will drop their triggers automatically)
DROP TABLE IF EXISTS survey_responses CASCADE;
DROP TABLE IF EXISTS survey_templates CASCADE;
DROP TABLE IF EXISTS surveys CASCADE;

-- Drop functions and types
DROP FUNCTION IF EXISTS update_updated_at_survey_column() CASCADE;
DROP FUNCTION IF EXISTS set_survey_submitted_at() CASCADE;
DROP TYPE IF EXISTS survey_status CASCADE;

-- Create ENUM type for survey status
CREATE TYPE survey_status AS ENUM ('draft', 'published', 'closed');

CREATE TYPE template_scope AS ENUM ('global', 'course');
CREATE TYPE survey_type AS ENUM('assign_all', 'specific', 'peer');

-- Create surveys table
CREATE TABLE surveys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    survey_id UUID NOT NULL DEFAULT gen_random_uuid(),
    class_id BIGINT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    -- class_section_id BIGINT REFERENCES class_sections(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    json JSONB NOT NULL DEFAULT '[]'::jsonb,
    status survey_status NOT NULL DEFAULT 'draft',
    allow_response_editing BOOLEAN NOT NULL DEFAULT FALSE,
    due_date TIMESTAMPTZ DEFAULT NULL,
    validation_errors TEXT DEFAULT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ DEFAULT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    type survey_type NOT NULL DEFAULT 'assign_all'
);

-- Create survey_templates table
CREATE TABLE survey_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    template JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1,
    scope template_scope NOT NULL DEFAULT 'course',
    class_id BIGINT NOT NULL REFERENCES classes(id) ON DELETE CASCADE
);

-- Create survey_responses table
CREATE TABLE survey_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id UUID NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  response JSONB NOT NULL DEFAULT '{}'::jsonb,
  submitted_at TIMESTAMPTZ DEFAULT NULL,
  is_submitted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ DEFAULT NULL,
  CONSTRAINT survey_responses_unique_per_profile UNIQUE (survey_id, profile_id)
);

-- Create unique constraint to prevent duplicate responses from same user
CREATE UNIQUE INDEX idx_responses_survey_user
  ON survey_responses(survey_id, profile_id);

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
  -- Only set submitted_at when is_submitted flips from false -> true
  IF NEW.is_submitted = TRUE
     AND (OLD.is_submitted = FALSE OR OLD.is_submitted IS NULL) THEN
    NEW.submitted_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_survey_submitted_at_trigger
  BEFORE INSERT OR UPDATE ON survey_responses
  FOR EACH ROW
  EXECUTE FUNCTION set_survey_submitted_at();

-- Helpful indexes for instructor dashboard / soft delete filtering
CREATE INDEX idx_surveys_class_active
  ON surveys (class_id, deleted_at)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_surveys_survey_id_version
  ON surveys (survey_id, version DESC);

CREATE INDEX idx_surveys_created_by
  ON surveys (created_by);

CREATE INDEX idx_survey_responses_survey_id_active
  ON survey_responses (survey_id)
  WHERE deleted_at IS NULL;

--CREATE INDEX idx_survey_responses_student_id_active
  --ON survey_responses (student_id)
  --WHERE deleted_at IS NULL;

--

-- TODO: ENABLE RLS
ALTER TABLE surveys ENABLE ROW LEVEL SECURITY;
ALTER TABLE survey_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE survey_templates ENABLE ROW LEVEL SECURITY;

-- Surveys: staff can see all active surveys
CREATE POLICY surveys_select_staff ON surveys
  FOR SELECT
  USING (authorizeforclassgrader(class_id) AND deleted_at IS NULL);

-- Surveys: students see only published/closed, non-deleted surveys
CREATE POLICY surveys_select_students ON surveys
  FOR SELECT
  USING (authorizeforclass(class_id) AND deleted_at IS NULL AND status IN ('published', 'closed'));

-- Surveys: only instructors can create
CREATE POLICY surveys_insert_instructors ON surveys
  FOR INSERT
  WITH CHECK (authorizeforclassinstructor(class_id));

-- Surveys: only instructors can update
CREATE POLICY surveys_update_instructors ON surveys
  FOR UPDATE
  USING (authorizeforclassinstructor(class_id))
  WITH CHECK (authorizeforclassinstructor(class_id));

-- Survey templates: staff can read
CREATE POLICY survey_templates_select ON survey_templates
  FOR SELECT
  USING (authorizeforclassgrader(class_id));

-- Survey templates: instructors can create
CREATE POLICY survey_templates_insert ON survey_templates
  FOR INSERT
  WITH CHECK (authorizeforclassinstructor(class_id));

-- Survey templates: instructors can update
CREATE POLICY survey_templates_update ON survey_templates
  FOR UPDATE
  USING (authorizeforclassinstructor(class_id))
  WITH CHECK (authorizeforclassinstructor(class_id));

-- Survey responses: owners can read
CREATE POLICY survey_responses_select_owner ON survey_responses
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.user_privileges up
      WHERE up.user_id = auth.uid()
        AND (up.public_profile_id = profile_id OR up.private_profile_id = profile_id)
    )
  );

-- Survey responses: staff can read
CREATE POLICY survey_responses_select_staff ON survey_responses
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.surveys s
      JOIN public.user_privileges up ON up.class_id = s.class_id
      WHERE s.id = survey_responses.survey_id
        AND up.user_id = auth.uid()
        AND up.role IN ('instructor', 'grader')
    )
  );

-- Survey responses: owners can create
CREATE POLICY survey_responses_insert_owner ON survey_responses
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.user_privileges up
      WHERE up.user_id = auth.uid()
        AND (up.public_profile_id = profile_id OR up.private_profile_id = profile_id)
    )
  );

-- Survey responses: owners can update their own
CREATE POLICY survey_responses_update_owner ON survey_responses
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM public.user_privileges up
      WHERE up.user_id = auth.uid()
        AND (up.public_profile_id = profile_id OR up.private_profile_id = profile_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.user_privileges up
      WHERE up.user_id = auth.uid()
        AND (up.public_profile_id = profile_id OR up.private_profile_id = profile_id)
    )
  );

-- If survey is published or closed, only then students have access to a survey
-- Instructors can view and create new surveys
-- No one can ever delete a survey
-- No user can directly update a survey, only use prev as template
-- Survey responses can be viewed by instructor/course staff
-- Survey responses can be edited as long as the profile who made an original response tries to and its allowed

-- RPC: Soft delete a survey and its responses atomically
CREATE OR REPLACE FUNCTION soft_delete_survey(
  p_survey_id UUID,
  p_survey_logical_id UUID
)
RETURNS void AS $$
DECLARE
  v_class_id BIGINT;
BEGIN
  SET LOCAL search_path = pg_catalog, public;

  -- Verify survey exists and capture class for authorization
  SELECT class_id
  INTO v_class_id
  FROM public.surveys
  WHERE id = p_survey_id
    AND survey_id = p_survey_logical_id
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Survey not found';
  END IF;

  IF NOT authorizeforclassinstructor(v_class_id) THEN
    RAISE EXCEPTION 'Permission denied: instructor access required';
  END IF;

  -- Soft delete responses tied to any version of this survey
  UPDATE public.survey_responses
  SET deleted_at = NOW()
  WHERE survey_id IN (
    SELECT id FROM public.surveys WHERE survey_id = p_survey_logical_id
  )
    AND deleted_at IS NULL;

  -- Soft delete all survey versions sharing the logical id
  UPDATE public.surveys
  SET deleted_at = NOW()
  WHERE survey_id = p_survey_logical_id
    AND deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION soft_delete_survey(UUID, UUID) TO authenticated;

COMMENT ON FUNCTION soft_delete_survey IS 'Soft deletes all survey versions and responses atomically for the given survey logical id';
