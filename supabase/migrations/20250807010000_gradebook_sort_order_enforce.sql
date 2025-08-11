-- Ensure unique sort_order per gradebook by shifting neighbors instead of erroring
-- Uses advisory locks to avoid races and pg_trigger_depth() to avoid recursive trigger calls

-- Drop legacy trigger/function if they exist
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trigger_handle_gradebook_column_sort_order'
  ) THEN
    DROP TRIGGER trigger_handle_gradebook_column_sort_order ON public.gradebook_columns;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname = 'handle_gradebook_column_sort_order'
  ) THEN
    DROP FUNCTION public.handle_gradebook_column_sort_order();
  END IF;
END$$;


CREATE OR REPLACE FUNCTION public.gradebook_columns_enforce_sort_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  max_order integer;
  target_order integer;
BEGIN
  -- Avoid re-entrant work when our own UPDATEs fire the trigger
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  -- Allow bypassing trigger enforcement during bulk operations for specific gradebooks
  -- This avoids the need for ACCESS EXCLUSIVE locks when disabling triggers globally
  IF current_setting('pawtograder.bypass_sort_order_trigger_' || NEW.gradebook_id::text, true) = 'true' THEN
    RETURN NEW;
  END IF;

  -- Take per-gradebook advisory locks to serialize operations and avoid races
  IF TG_OP = 'UPDATE' AND NEW.gradebook_id IS DISTINCT FROM OLD.gradebook_id THEN
    IF OLD.gradebook_id < NEW.gradebook_id THEN
      PERFORM pg_advisory_xact_lock(OLD.gradebook_id);
      PERFORM pg_advisory_xact_lock(NEW.gradebook_id);
    ELSE
      PERFORM pg_advisory_xact_lock(NEW.gradebook_id);
      PERFORM pg_advisory_xact_lock(OLD.gradebook_id);
    END IF;
  ELSE
    PERFORM pg_advisory_xact_lock(NEW.gradebook_id);
  END IF;

  -- Handle NULL or negative sort_order
  IF NEW.sort_order IS NULL THEN
    SELECT COALESCE(MAX(sort_order), -1) + 1
      INTO NEW.sort_order
      FROM public.gradebook_columns
     WHERE gradebook_id = NEW.gradebook_id
       AND id != NEW.id;
  ELSIF NEW.sort_order < 0 THEN
    NEW.sort_order := 0;
  END IF;

  -- Handle conflicts by shifting other rows
  IF TG_OP = 'INSERT' THEN
    -- Shift right any conflicting or following columns
    UPDATE public.gradebook_columns
       SET sort_order = sort_order + 1
     WHERE gradebook_id = NEW.gradebook_id
       AND sort_order >= NEW.sort_order
       AND id != NEW.id;

  ELSIF TG_OP = 'UPDATE' THEN
    -- Moving across gradebooks: close gap in old, insert into new
    IF NEW.gradebook_id IS DISTINCT FROM OLD.gradebook_id THEN
      -- Close gap in old gradebook
      IF OLD.sort_order IS NOT NULL THEN
        UPDATE public.gradebook_columns
           SET sort_order = sort_order - 1
         WHERE gradebook_id = OLD.gradebook_id
           AND sort_order > OLD.sort_order
           AND id != NEW.id;
      END IF;

      -- Make room in new gradebook
      UPDATE public.gradebook_columns
         SET sort_order = sort_order + 1
       WHERE gradebook_id = NEW.gradebook_id
         AND sort_order >= NEW.sort_order
         AND id != NEW.id;

    -- Within same gradebook: reposition if changed
    ELSIF NEW.sort_order IS DISTINCT FROM OLD.sort_order THEN
      -- Simple approach: shift everything at the target position and beyond
      UPDATE public.gradebook_columns
         SET sort_order = sort_order + 1
       WHERE gradebook_id = NEW.gradebook_id
         AND sort_order >= NEW.sort_order
         AND id != NEW.id;
      
      -- Close the gap where this column used to be
      IF OLD.sort_order IS NOT NULL THEN
        UPDATE public.gradebook_columns
           SET sort_order = sort_order - 1
         WHERE gradebook_id = NEW.gradebook_id
           AND sort_order > OLD.sort_order
           AND id != NEW.id;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END
$$;

-- Replace trigger to use the new function and avoid recursion
DROP TRIGGER IF EXISTS gradebook_columns_enforce_sort_order_tr ON public.gradebook_columns;

CREATE TRIGGER gradebook_columns_enforce_sort_order_tr
BEFORE INSERT OR UPDATE OF sort_order, gradebook_id ON public.gradebook_columns
FOR EACH ROW
EXECUTE FUNCTION public.gradebook_columns_enforce_sort_order();


