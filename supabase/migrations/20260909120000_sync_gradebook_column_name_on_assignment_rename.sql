-- Keep an assignment's auto-created gradebook column named after the assignment (#891).
--
-- create_gradebook_column_for_assignment copies assignments.title into
-- gradebook_columns.name once, on INSERT. Nothing propagated a later rename, so
-- the gradebook header kept showing whatever the assignment was first called.
-- total_points already had an AFTER UPDATE sync (update_gradebook_column_max_score);
-- this folds the name into the same trigger rather than adding a second one.
--
-- The rename is skipped when the column's name no longer equals the assignment's
-- previous title: an instructor who deliberately gave the column its own name keeps
-- it. That also means no backfill -- existing drift may be intentional, and there
-- is no way to tell from the data.

CREATE OR REPLACE FUNCTION public.sync_gradebook_column_from_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.gradebook_column_id IS NULL THEN
        RETURN NEW;
    END IF;

    IF OLD.total_points IS DISTINCT FROM NEW.total_points THEN
        UPDATE public.gradebook_columns
        SET max_score = NEW.total_points
        WHERE id = NEW.gradebook_column_id;
    END IF;

    IF OLD.title IS DISTINCT FROM NEW.title THEN
        UPDATE public.gradebook_columns
        SET name = NEW.title
        WHERE id = NEW.gradebook_column_id
          AND name = OLD.title;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS update_gradebook_column_max_score_trigger ON public.assignments;
DROP FUNCTION IF EXISTS public.update_gradebook_column_max_score();

CREATE TRIGGER sync_gradebook_column_from_assignment_trigger
AFTER UPDATE OF title, total_points ON public.assignments
FOR EACH ROW EXECUTE FUNCTION public.sync_gradebook_column_from_assignment();
