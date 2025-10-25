-- Create function to manage is_latest_version field
-- This ensures exactly one row per survey_id has is_latest_version=true

CREATE OR REPLACE FUNCTION manage_survey_latest_version()
RETURNS TRIGGER AS $$
BEGIN
  -- Only process if survey_id is not null
  IF NEW.survey_id IS NOT NULL THEN
    -- If this is a new survey (INSERT) or survey_id changed (UPDATE)
    IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND (OLD.survey_id IS DISTINCT FROM NEW.survey_id OR OLD.survey_id IS NULL)) THEN
      -- Set all other versions of this survey to is_latest_version = false
      UPDATE surveys 
      SET is_latest_version = false 
      WHERE survey_id = NEW.survey_id 
        AND id != NEW.id
        AND deleted_at IS NULL;
      
      -- Set this version as the latest
      NEW.is_latest_version = true;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically manage is_latest_version
CREATE TRIGGER manage_survey_latest_version_trigger
  BEFORE INSERT OR UPDATE ON surveys
  FOR EACH ROW
  EXECUTE FUNCTION manage_survey_latest_version();

-- Update existing data to ensure consistency
-- Set all existing surveys to is_latest_version = false first
UPDATE surveys SET is_latest_version = false WHERE deleted_at IS NULL;

-- Then set the latest version for each survey_id
WITH latest_versions AS (
  SELECT DISTINCT ON (survey_id) 
    id, 
    survey_id
  FROM surveys 
  WHERE deleted_at IS NULL 
    AND survey_id IS NOT NULL
  ORDER BY survey_id, created_at DESC, id DESC
)
UPDATE surveys 
SET is_latest_version = true 
WHERE id IN (SELECT id FROM latest_versions);

-- For surveys without survey_id (legacy data), set them as latest if they're the only one
UPDATE surveys 
SET is_latest_version = true 
WHERE survey_id IS NULL 
  AND deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM surveys s2 
    WHERE s2.id != surveys.id 
      AND s2.survey_id IS NULL 
      AND s2.deleted_at IS NULL
  );
