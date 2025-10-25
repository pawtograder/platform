-- Add survey_id column to surveys table to support versioning
-- This column groups multiple versions of the same survey together

ALTER TABLE surveys ADD COLUMN IF NOT EXISTS survey_id UUID DEFAULT gen_random_uuid();

-- Add is_latest_version column to track which version is current
ALTER TABLE surveys ADD COLUMN IF NOT EXISTS is_latest_version BOOLEAN DEFAULT true;

-- Update existing surveys to have unique survey_id values (since they're all individual surveys)
-- This ensures existing data works with the new versioning system
UPDATE surveys SET survey_id = id WHERE survey_id IS NULL;

-- Create index for better performance on survey_id queries
CREATE INDEX IF NOT EXISTS idx_surveys_survey_id ON surveys(survey_id);

-- Add comment to clarify the purpose of the survey_id column
COMMENT ON COLUMN surveys.survey_id IS 'Groups multiple versions of the same survey together. Each survey_id can have multiple versions with different id values.';
COMMENT ON COLUMN surveys.is_latest_version IS 'Indicates if this is the latest version of the survey for the given survey_id.';
