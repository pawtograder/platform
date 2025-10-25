-- Fix RLS policies for survey_responses table to use correct column names
-- The soft delete migration was using profile_id but the column was renamed to student_id

-- Drop the incorrect policies
DROP POLICY IF EXISTS "Instructors can view all survey responses" ON survey_responses;
DROP POLICY IF EXISTS "Students can view and submit their own responses" ON survey_responses;

-- Create correct policies using student_id column
CREATE POLICY "Instructors can view all survey responses" ON survey_responses
  FOR SELECT USING (
    authorizeforclassinstructor((SELECT class_id FROM surveys WHERE id = survey_id)) 
    AND deleted_at IS NULL
  );

CREATE POLICY "Students can view and submit their own responses" ON survey_responses
  FOR ALL USING (
    authorizeforclass((SELECT class_id FROM surveys WHERE id = survey_id)) 
    AND auth.uid() = student_id 
    AND deleted_at IS NULL
  ) WITH CHECK (
    authorizeforclass((SELECT class_id FROM surveys WHERE id = survey_id)) 
    AND auth.uid() = student_id 
    AND deleted_at IS NULL
  );
