-- Create survey_assignments table
CREATE TABLE IF NOT EXISTS survey_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    survey_id UUID NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT survey_assignments_unique_per_profile UNIQUE (survey_id, profile_id)
);

-- Create index for efficient lookups
CREATE INDEX idx_survey_assignments_survey_id ON survey_assignments(survey_id);
CREATE INDEX idx_survey_assignments_profile_id ON survey_assignments(profile_id);

-- Add a column to surveys table to track assignment mode
ALTER TABLE surveys ADD COLUMN IF NOT EXISTS assigned_to_all BOOLEAN NOT NULL DEFAULT TRUE;

-- Create comment explaining the new column
COMMENT ON COLUMN surveys.assigned_to_all IS 'If true, survey is assigned to all students in the class. If false, only assigned to specific students in survey_assignments table.';

-- Update the surveys_select_students policy to respect survey assignments
-- First drop the existing policy
DROP POLICY IF EXISTS surveys_select_students ON surveys;

-- Recreate it with assignment checks
CREATE POLICY surveys_select_students ON surveys
  FOR SELECT
  USING (
    authorizeforclass(class_id) 
    AND deleted_at IS NULL 
    AND status IN ('published', 'closed')
    AND (
      -- Either survey is assigned to all students
      assigned_to_all = TRUE
      OR
      -- Or the current user is specifically assigned to this survey
      EXISTS (
        SELECT 1
        FROM public.survey_assignments sa
        JOIN public.user_privileges up ON (up.private_profile_id = sa.profile_id OR up.public_profile_id = sa.profile_id)
        WHERE sa.survey_id = surveys.id
          AND up.user_id = auth.uid()
          AND up.class_id = surveys.class_id
      )
    )
  );

-- Create a function to help with bulk assignment creation
-- Uses SECURITY DEFINER to bypass RLS and avoid circular dependency issues
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
  
  -- Insert new assignments
  INSERT INTO survey_assignments (survey_id, profile_id)
  SELECT p_survey_id, unnest(p_profile_ids)
  ON CONFLICT (survey_id, profile_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION create_survey_assignments(UUID, UUID[]) TO authenticated;

-- Add comment
COMMENT ON FUNCTION create_survey_assignments IS 'Bulk create survey assignments for specific students. Only callable by instructors.';