-- Add CHECK constraint and trigger to enforce consistency between surveys.type and surveys.assigned_to_all
--
-- RELIES ON NOT NULL CONSTRAINTS from earlier migrations:
--   - surveys.type: NOT NULL DEFAULT 'assign_all' (20251018223435_create_survey_structure.sql, line 35)
--   - surveys.assigned_to_all: NOT NULL DEFAULT TRUE (20251122000000_add_survey_assignments.sql, line 15)
--
-- The CHECK constraint below also explicitly requires NOT NULL as defense-in-depth,
-- preventing regressions if those constraints are ever removed.

-- Step 1: Backfill inconsistent data
UPDATE surveys
SET type = 'assign_all'
WHERE assigned_to_all = TRUE
  AND type != 'assign_all';

UPDATE surveys
SET type = 'specific'
WHERE assigned_to_all = FALSE
  AND type = 'assign_all';

-- Step 2: Trigger to keep type and assigned_to_all in sync on UPDATE
CREATE OR REPLACE FUNCTION sync_survey_type_with_assigned_to_all()
RETURNS TRIGGER AS $$
BEGIN
  -- Columns are NOT NULL, so direct comparisons are safe
  IF NEW.assigned_to_all IS DISTINCT FROM OLD.assigned_to_all THEN
    IF NEW.assigned_to_all = TRUE THEN
      NEW.type := 'assign_all';
    ELSIF NEW.type = 'assign_all' THEN
      NEW.type := 'specific';
    END IF;
  ELSIF NEW.type IS DISTINCT FROM OLD.type THEN
    NEW.assigned_to_all := (NEW.type = 'assign_all');
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Step 3: Trigger to ensure consistency on INSERT
CREATE OR REPLACE FUNCTION sync_survey_type_on_insert()
RETURNS TRIGGER AS $$
BEGIN
  -- Columns are NOT NULL with defaults, so direct comparisons are safe
  IF NEW.assigned_to_all = TRUE THEN
    NEW.type := 'assign_all';
  ELSIF NEW.type = 'assign_all' THEN
    NEW.type := 'specific';
  END IF;
  
  NEW.assigned_to_all := (NEW.type = 'assign_all');
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Step 4: Create triggers
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

-- Step 5: CHECK constraint enforces consistency + explicitly rejects NULL (defense-in-depth)
ALTER TABLE surveys 
  DROP CONSTRAINT IF EXISTS chk_survey_type_assigned_to_all_consistency;

ALTER TABLE surveys 
  ADD CONSTRAINT chk_survey_type_assigned_to_all_consistency CHECK (
    type IS NOT NULL
    AND assigned_to_all IS NOT NULL
    AND (
      (type = 'assign_all' AND assigned_to_all = TRUE)
      OR
      (type IN ('specific', 'peer') AND assigned_to_all = FALSE)
    )
  );