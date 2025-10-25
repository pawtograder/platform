-- Rename profile_id to student_id in survey_responses table
-- This aligns with the schema specification where student_id is the foreign key to profiles

-- First, drop the existing foreign key constraint
ALTER TABLE survey_responses DROP CONSTRAINT IF EXISTS survey_responses_profile_id_fkey;

-- Rename the column from profile_id to student_id
ALTER TABLE survey_responses RENAME COLUMN profile_id TO student_id;

-- Add the foreign key constraint back with the new column name
ALTER TABLE survey_responses ADD CONSTRAINT survey_responses_student_id_fkey 
  FOREIGN KEY (student_id) REFERENCES profiles(id) ON DELETE CASCADE;

-- Update the unique constraint to use the new column name
ALTER TABLE survey_responses DROP CONSTRAINT IF EXISTS unique_survey_response_per_profile;
ALTER TABLE survey_responses ADD CONSTRAINT unique_survey_response_per_student 
  UNIQUE (survey_id, student_id);

-- Update RLS policies to use the new column name
DROP POLICY IF EXISTS "Students can view and submit their own responses" ON survey_responses;
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
