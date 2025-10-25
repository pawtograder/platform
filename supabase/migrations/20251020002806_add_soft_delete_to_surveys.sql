-- Add soft delete fields to surveys and survey_responses tables

-- Add deleted_at field to surveys table
ALTER TABLE surveys ADD COLUMN deleted_at TIMESTAMPTZ DEFAULT NULL;

-- Add deleted_at field to survey_responses table  
ALTER TABLE survey_responses ADD COLUMN deleted_at TIMESTAMPTZ DEFAULT NULL;

-- Create indexes for better performance on soft delete queries
CREATE INDEX idx_surveys_deleted_at ON surveys(deleted_at);
CREATE INDEX idx_survey_responses_deleted_at ON survey_responses(deleted_at);

-- Update RLS policies to exclude soft-deleted records
-- Note: This assumes RLS is enabled. If not, these will be ignored.

-- Update surveys policies to exclude soft-deleted surveys
DROP POLICY IF EXISTS "Instructors can manage surveys" ON surveys;
DROP POLICY IF EXISTS "Students can view published surveys" ON surveys;

CREATE POLICY "Instructors can manage surveys" ON surveys
  FOR ALL USING (
    authorizeforclassinstructor(class_id) AND deleted_at IS NULL
  ) WITH CHECK (
    authorizeforclassinstructor(class_id) AND deleted_at IS NULL
  );

CREATE POLICY "Students can view published surveys" ON surveys
  FOR SELECT USING (
    authorizeforclass(class_id) AND status = 'published' AND deleted_at IS NULL
  );

-- Update survey_responses policies to exclude soft-deleted responses
DROP POLICY IF EXISTS "Instructors can view all survey responses" ON survey_responses;
DROP POLICY IF EXISTS "Students can view and submit their own responses" ON survey_responses;

CREATE POLICY "Instructors can view all survey responses" ON survey_responses
  FOR SELECT USING (
    authorizeforclassinstructor((SELECT class_id FROM surveys WHERE id = survey_id)) 
    AND deleted_at IS NULL
  );

CREATE POLICY "Students can view and submit their own responses" ON survey_responses
  FOR ALL USING (
    authorizeforclass((SELECT class_id FROM surveys WHERE id = survey_id)) 
    AND auth.uid() = profile_id 
    AND deleted_at IS NULL
  ) WITH CHECK (
    authorizeforclass((SELECT class_id FROM surveys WHERE id = survey_id)) 
    AND auth.uid() = profile_id 
    AND deleted_at IS NULL
  );
