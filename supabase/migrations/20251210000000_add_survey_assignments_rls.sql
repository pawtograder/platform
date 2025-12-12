-- Add class_id column to survey_assignments for RLS checks
ALTER TABLE survey_assignments 
  ADD COLUMN IF NOT EXISTS class_id BIGINT REFERENCES classes(id) ON DELETE CASCADE;

-- Backfill class_id from surveys table
UPDATE survey_assignments sa
SET class_id = s.class_id
FROM surveys s
WHERE sa.survey_id = s.id
  AND sa.class_id IS NULL;

-- Make class_id NOT NULL after backfill
ALTER TABLE survey_assignments 
  ALTER COLUMN class_id SET NOT NULL;

-- Create index for class_id lookups
CREATE INDEX IF NOT EXISTS idx_survey_assignments_class_id ON survey_assignments(class_id);

-- Enable RLS on survey_assignments table
ALTER TABLE survey_assignments ENABLE ROW LEVEL SECURITY;

-- Policy: Instructors can SELECT/UPDATE/DELETE survey assignments in their class
CREATE POLICY survey_assignments_manage_instructors ON survey_assignments
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (authorizeforclassinstructor(class_id));

CREATE POLICY survey_assignments_update_instructors ON survey_assignments
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (authorizeforclassinstructor(class_id))
  WITH CHECK (authorizeforclassinstructor(class_id));

CREATE POLICY survey_assignments_delete_instructors ON survey_assignments
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING (authorizeforclassinstructor(class_id));

-- Policy: Instructors can INSERT survey assignments in their class
CREATE POLICY survey_assignments_insert_instructors ON survey_assignments
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (authorizeforclassinstructor(class_id));

-- Policy: Graders can view survey assignments in their class
CREATE POLICY survey_assignments_select_graders ON survey_assignments
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (authorizeforclassgrader(class_id));

-- Policy: Assignees can view their own survey assignments
CREATE POLICY survey_assignments_select_assignee ON survey_assignments
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.user_privileges up
      WHERE up.user_id = auth.uid()
        AND (up.private_profile_id = survey_assignments.profile_id 
             OR up.public_profile_id = survey_assignments.profile_id)
    )
  );

-- Policy: Class members can view survey assignments for surveys in their class
-- This is needed for the surveys_select_students policy to correctly evaluate
-- the EXISTS check for survey_assignments
CREATE POLICY survey_assignments_select_class_member ON survey_assignments
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (authorizeforclass(class_id));

-- Update the create_survey_assignments function to include class_id
CREATE OR REPLACE FUNCTION create_survey_assignments(
  p_survey_id UUID,
  p_profile_ids UUID[]
)
RETURNS void AS $$
DECLARE
  v_class_id BIGINT;
BEGIN
  -- Verify the caller is an instructor for this survey's class
  SELECT class_id INTO v_class_id
  FROM public.surveys
  WHERE id = p_survey_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Survey not found';
  END IF;
  
  IF NOT authorizeforclassinstructor(v_class_id) THEN
    RAISE EXCEPTION 'Permission denied: only instructors can manage survey assignments';
  END IF;
  
  -- Delete existing assignments for this survey
  DELETE FROM survey_assignments WHERE survey_id = p_survey_id;
  
  -- Insert new assignments with class_id
  INSERT INTO survey_assignments (survey_id, profile_id, class_id)
  SELECT p_survey_id, unnest(p_profile_ids), v_class_id
  ON CONFLICT (survey_id, profile_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;