-- Create function to check if user is staff (instructor/grader) in ANY class
CREATE OR REPLACE FUNCTION public.authorizeforanyclassstaff()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_privileges up
    WHERE up.user_id = auth.uid()
    AND up.role IN ('instructor', 'grader')
  );
$$;

-- Drop existing policies to recreate them
DROP POLICY IF EXISTS survey_templates_select ON survey_templates;
DROP POLICY IF EXISTS survey_templates_insert ON survey_templates;
DROP POLICY IF EXISTS survey_templates_update ON survey_templates;
DROP POLICY IF EXISTS survey_templates_delete ON survey_templates;

-- Survey templates: staff can read
-- 1. Templates from their own classes
-- 2. Global templates if they are staff in ANY class
CREATE POLICY survey_templates_select ON survey_templates
  FOR SELECT
  USING (
    authorizeforclassgrader(class_id) 
    OR 
    (scope = 'global' AND authorizeforanyclassstaff())
  );

-- Survey templates: instructors can create
-- Must be an instructor in the class they are associating the template with
CREATE POLICY survey_templates_insert ON survey_templates
  FOR INSERT
  WITH CHECK (authorizeforclassinstructor(class_id));

-- Survey templates: instructors can update
-- Must be an instructor in the class (origin)
CREATE POLICY survey_templates_update ON survey_templates
  FOR UPDATE
  USING (authorizeforclassinstructor(class_id))
  WITH CHECK (authorizeforclassinstructor(class_id));

-- Survey templates: creator can delete
-- created_by refers to profiles(id) which corresponds to private_profile_id in user_roles
CREATE POLICY survey_templates_delete ON survey_templates
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE ur.user_id = auth.uid()
      AND ur.private_profile_id = survey_templates.created_by
    )
  );
