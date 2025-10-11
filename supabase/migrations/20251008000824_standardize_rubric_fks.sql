-- Migration: Standardize Rubric Foreign Keys for Independent TableController Filtering
-- Purpose: Add assignment_id and rubric_id to rubric-related tables to enable efficient filtering
-- without requiring joins through the entire hierarchy

-- Step 1: Add assignment_id to rubric_parts
ALTER TABLE public.rubric_parts
ADD COLUMN IF NOT EXISTS assignment_id bigint;

-- Step 2: Add assignment_id to rubric_criteria (already has rubric_id)
ALTER TABLE public.rubric_criteria
ADD COLUMN IF NOT EXISTS assignment_id bigint;

-- Step 3: Add assignment_id to rubric_checks (and rubric_id for completeness)
ALTER TABLE public.rubric_checks
ADD COLUMN IF NOT EXISTS assignment_id bigint,
ADD COLUMN IF NOT EXISTS rubric_id bigint;

-- Step 4: Add assignment_id and rubric_id to rubric_check_references
ALTER TABLE public.rubric_check_references
ADD COLUMN IF NOT EXISTS assignment_id bigint,
ADD COLUMN IF NOT EXISTS rubric_id bigint;

-- Step 5: Backfill assignment_id in rubric_parts from rubrics
UPDATE public.rubric_parts rp
SET assignment_id = r.assignment_id
FROM public.rubrics r
WHERE rp.rubric_id = r.id
AND rp.assignment_id IS NULL;

-- Step 6: Backfill assignment_id in rubric_criteria from rubrics
UPDATE public.rubric_criteria rcrit
SET assignment_id = r.assignment_id
FROM public.rubrics r
WHERE rcrit.rubric_id = r.id
AND rcrit.assignment_id IS NULL;

-- Step 7: Backfill assignment_id and rubric_id in rubric_checks from rubric_criteria → rubric_parts → rubrics
UPDATE public.rubric_checks rc
SET 
  assignment_id = r.assignment_id,
  rubric_id = r.id
FROM public.rubric_criteria rcrit
INNER JOIN public.rubric_parts rp ON rcrit.rubric_part_id = rp.id
INNER JOIN public.rubrics r ON rp.rubric_id = r.id
WHERE rc.rubric_criteria_id = rcrit.id
AND (rc.assignment_id IS NULL OR rc.rubric_id IS NULL);

-- Step 8: Backfill assignment_id and rubric_id in rubric_check_references from rubric_checks
UPDATE public.rubric_check_references rcr
SET 
  assignment_id = rc.assignment_id,
  rubric_id = rc.rubric_id
FROM public.rubric_checks rc
WHERE rcr.referencing_rubric_check_id = rc.id
AND (rcr.assignment_id IS NULL OR rcr.rubric_id IS NULL);

-- Step 9: Make assignment_id NOT NULL after backfill
ALTER TABLE public.rubric_parts
ALTER COLUMN assignment_id SET NOT NULL;

ALTER TABLE public.rubric_criteria
ALTER COLUMN assignment_id SET NOT NULL;

ALTER TABLE public.rubric_checks
ALTER COLUMN assignment_id SET NOT NULL,
ALTER COLUMN rubric_id SET NOT NULL;

ALTER TABLE public.rubric_check_references
ALTER COLUMN assignment_id SET NOT NULL,
ALTER COLUMN rubric_id SET NOT NULL;

-- Step 10: Add foreign key constraints
ALTER TABLE public.rubric_parts
ADD CONSTRAINT rubric_parts_assignment_id_fkey 
FOREIGN KEY (assignment_id) REFERENCES public.assignments(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE public.rubric_criteria
ADD CONSTRAINT rubric_criteria_assignment_id_fkey 
FOREIGN KEY (assignment_id) REFERENCES public.assignments(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE public.rubric_checks
ADD CONSTRAINT rubric_checks_assignment_id_fkey 
FOREIGN KEY (assignment_id) REFERENCES public.assignments(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE public.rubric_checks
ADD CONSTRAINT rubric_checks_rubric_id_fkey 
FOREIGN KEY (rubric_id) REFERENCES public.rubrics(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE public.rubric_check_references
ADD CONSTRAINT rubric_check_references_assignment_id_fkey 
FOREIGN KEY (assignment_id) REFERENCES public.assignments(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE public.rubric_check_references
ADD CONSTRAINT rubric_check_references_rubric_id_fkey 
FOREIGN KEY (rubric_id) REFERENCES public.rubrics(id) ON UPDATE CASCADE ON DELETE CASCADE;

-- Step 11: Add indexes for efficient filtering by assignment_id
CREATE INDEX IF NOT EXISTS idx_rubric_parts_assignment_id 
ON public.rubric_parts(assignment_id);

CREATE INDEX IF NOT EXISTS idx_rubric_parts_assignment_rubric 
ON public.rubric_parts(assignment_id, rubric_id);

CREATE INDEX IF NOT EXISTS idx_rubric_criteria_assignment_id 
ON public.rubric_criteria(assignment_id);

CREATE INDEX IF NOT EXISTS idx_rubric_criteria_assignment_rubric 
ON public.rubric_criteria(assignment_id, rubric_id);

CREATE INDEX IF NOT EXISTS idx_rubric_checks_assignment_id 
ON public.rubric_checks(assignment_id);

CREATE INDEX IF NOT EXISTS idx_rubric_checks_assignment_rubric 
ON public.rubric_checks(assignment_id, rubric_id);

CREATE INDEX IF NOT EXISTS idx_rubric_checks_rubric_id 
ON public.rubric_checks(rubric_id);

CREATE INDEX IF NOT EXISTS idx_rubric_check_references_assignment_id 
ON public.rubric_check_references(assignment_id);

CREATE INDEX IF NOT EXISTS idx_rubric_check_references_rubric_id 
ON public.rubric_check_references(rubric_id);

-- Step 12: Create triggers to cascade UPDATE operations (maintain consistency)

-- Trigger to cascade assignment_id updates from rubrics to rubric_parts and rubric_criteria
CREATE OR REPLACE FUNCTION public.sync_rubric_parts_assignment_id() 
RETURNS TRIGGER 
LANGUAGE plpgsql 
SECURITY DEFINER
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.assignment_id IS DISTINCT FROM NEW.assignment_id THEN
    -- Update all rubric_parts when rubric's assignment_id changes
    UPDATE public.rubric_parts
    SET assignment_id = NEW.assignment_id
    WHERE rubric_id = NEW.id;
    
    -- Also update rubric_criteria (which reference rubrics directly)
    UPDATE public.rubric_criteria
    SET assignment_id = NEW.assignment_id
    WHERE rubric_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sync_rubric_parts_assignment_id_trigger
AFTER UPDATE OF assignment_id ON public.rubrics
FOR EACH ROW
EXECUTE FUNCTION public.sync_rubric_parts_assignment_id();

-- Step 13: Create triggers to cascade updates

-- Cascade assignment_id updates from rubric_criteria to rubric_checks
CREATE OR REPLACE FUNCTION public.sync_rubric_checks_assignment_id() 
RETURNS TRIGGER 
LANGUAGE plpgsql 
SECURITY DEFINER
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.assignment_id IS DISTINCT FROM NEW.assignment_id THEN
    -- Update rubric_checks.assignment_id when rubric_criteria changes
    UPDATE public.rubric_checks
    SET assignment_id = NEW.assignment_id
    WHERE rubric_criteria_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sync_rubric_checks_assignment_id_trigger
AFTER UPDATE OF assignment_id ON public.rubric_criteria
FOR EACH ROW
EXECUTE FUNCTION public.sync_rubric_checks_assignment_id();

-- Cascade assignment_id and rubric_id updates from rubric_checks to rubric_check_references
CREATE OR REPLACE FUNCTION public.sync_rubric_check_references_ids() 
RETURNS TRIGGER 
LANGUAGE plpgsql 
SECURITY DEFINER
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.assignment_id IS DISTINCT FROM NEW.assignment_id OR OLD.rubric_id IS DISTINCT FROM NEW.rubric_id) THEN
    -- Update rubric_check_references when rubric_check changes
    UPDATE public.rubric_check_references
    SET 
      assignment_id = NEW.assignment_id,
      rubric_id = NEW.rubric_id
    WHERE referencing_rubric_check_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sync_rubric_check_references_ids_trigger
AFTER UPDATE OF assignment_id, rubric_id ON public.rubric_checks
FOR EACH ROW
EXECUTE FUNCTION public.sync_rubric_check_references_ids();

-- Step 14: Add comments explaining the denormalization
COMMENT ON COLUMN public.rubric_parts.assignment_id IS 'Denormalized from rubrics.assignment_id for efficient filtering by assignment';
COMMENT ON COLUMN public.rubric_criteria.assignment_id IS 'Denormalized from rubrics.assignment_id for efficient filtering by assignment';
COMMENT ON COLUMN public.rubric_checks.assignment_id IS 'Denormalized from rubrics.assignment_id via rubric_criteria for efficient filtering by assignment';
COMMENT ON COLUMN public.rubric_checks.rubric_id IS 'Denormalized from rubrics.id via rubric_criteria for efficient filtering by rubric';
COMMENT ON COLUMN public.rubric_check_references.assignment_id IS 'Denormalized from rubrics.assignment_id via rubric_checks for efficient filtering by assignment';
COMMENT ON COLUMN public.rubric_check_references.rubric_id IS 'Denormalized from rubrics.id via rubric_checks for efficient filtering by rubric';
