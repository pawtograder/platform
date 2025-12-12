-- Add CHECK constraint and trigger to enforce consistency between surveys.type and surveys.assigned_to_all

-- Step 1: Backfill inconsistent data
-- If assigned_to_all = TRUE, type should be 'assign_all'
UPDATE surveys
SET type = 'assign_all'
WHERE assigned_to_all = TRUE
  AND type != 'assign_all';

-- If assigned_to_all = FALSE and type = 'assign_all', set type to 'specific'
UPDATE surveys
SET type = 'specific'
WHERE assigned_to_all = FALSE
  AND type = 'assign_all';

-- Step 2: Create trigger function to keep type and assigned_to_all in sync
CREATE OR REPLACE FUNCTION sync_survey_type_with_assigned_to_all()
RETURNS TRIGGER AS $$
BEGIN
  -- If assigned_to_all is being set, derive type from it
  IF NEW.assigned_to_all IS DISTINCT FROM OLD.assigned_to_all THEN
    IF NEW.assigned_to_all = TRUE THEN
      NEW.type := 'assign_all';
    ELSIF NEW.type = 'assign_all' THEN
      -- If assigned_to_all is false but type wasn't changed, default to 'specific'
      NEW.type := 'specific';
    END IF;
  -- If type is being set, derive assigned_to_all from it
  ELSIF NEW.type IS DISTINCT FROM OLD.type THEN
    NEW.assigned_to_all := (NEW.type = 'assign_all');
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- For inserts, ensure consistency based on the values provided
CREATE OR REPLACE FUNCTION sync_survey_type_on_insert()
RETURNS TRIGGER AS $$
BEGIN
  -- Prioritize assigned_to_all since that's what the application uses
  IF NEW.assigned_to_all = TRUE THEN
    NEW.type := 'assign_all';
  ELSIF NEW.assigned_to_all = FALSE AND NEW.type = 'assign_all' THEN
    NEW.type := 'specific';
  END IF;
  
  -- Ensure assigned_to_all matches type
  NEW.assigned_to_all := (NEW.type = 'assign_all');
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers
DROP TRIGGER IF EXISTS sync_survey_type_trigger ON surveys;
CREATE TRIGGER sync_survey_type_trigger
  BEFORE UPDATE ON surveys
  FOR EACH ROW
  EXECUTE FUNCTION sync_survey_type_with_assigned_to_all();

DROP TRIGGER IF EXISTS sync_survey_type_on_insert_trigger ON surveys;
CREATE TRIGGER sync_survey_type_on_insert_trigger
  BEFORE INSERT ON surveys
  FOR EACH ROW
  EXECUTE FUNCTION sync_survey_type_on_insert();

-- Step 3: Add CHECK constraint to enforce consistency
ALTER TABLE surveys 
  DROP CONSTRAINT IF EXISTS chk_survey_type_assigned_to_all_consistency;

ALTER TABLE surveys 
  ADD CONSTRAINT chk_survey_type_assigned_to_all_consistency CHECK (
    -- If type is 'assign_all', then assigned_to_all must be TRUE
    -- If type is 'specific' or 'peer', then assigned_to_all must be FALSE
    (type = 'assign_all' AND assigned_to_all = TRUE)
    OR
    (type IN ('specific', 'peer') AND assigned_to_all = FALSE)
  );