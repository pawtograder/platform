-- Fix survey_responses RLS policies to work with user_privileges optimization
-- The issue is that the staff policy uses a subquery that doesn't work efficiently
-- with the optimized authorize functions

-- Drop existing policies
DROP POLICY IF EXISTS survey_responses_select_owner ON survey_responses;
DROP POLICY IF EXISTS survey_responses_select_staff ON survey_responses;
DROP POLICY IF EXISTS survey_responses_insert_owner ON survey_responses;
DROP POLICY IF EXISTS survey_responses_update_owner ON survey_responses;

-- Survey responses: owners can read their own responses
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

-- Survey responses: staff can read all responses in their class
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

-- Survey responses: owners can create their own responses
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

-- Survey responses: owners can update their own responses
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