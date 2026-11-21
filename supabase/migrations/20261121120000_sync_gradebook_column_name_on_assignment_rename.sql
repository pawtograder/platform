-- Keep an assignment's auto-created gradebook column named after the assignment (#891).
--
-- create_gradebook_column_for_assignment copies assignments.title into
-- gradebook_columns.name once, on INSERT. Nothing propagated a later rename, so
-- the gradebook header kept showing whatever the assignment was first called.
-- total_points already had an AFTER UPDATE sync (update_gradebook_column_max_score);
-- this folds the name into the same trigger rather than adding a second one.
--
-- A column belongs to the assignment when its score expression is exactly
-- assignments("<slug>"), which is how create_gradebook_column_for_assignment writes it
-- and how 20251124233922 backfilled gradebook_column_id. That holds even when
-- gradebook_column_id is unset, and it leaves alone code-walk columns
-- (assignments("<slug>", "code-walk")) and columns whose expression an instructor
-- changed. A hand-renamed header on a matching column follows the title again.
-- No backfill: existing names stay until the next rename.

CREATE OR REPLACE FUNCTION public.sync_gradebook_column_from_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF OLD.total_points IS DISTINCT FROM NEW.total_points AND NEW.gradebook_column_id IS NOT NULL THEN
        UPDATE public.gradebook_columns
        SET max_score = NEW.total_points
        WHERE id = NEW.gradebook_column_id;
    END IF;

    -- OLD.slug: the expression was written with the slug the column was created under,
    -- which is still the old one if this same update also changes the slug.
    IF OLD.title IS DISTINCT FROM NEW.title THEN
        UPDATE public.gradebook_columns
        SET name = NEW.title
        WHERE class_id = NEW.class_id
          AND score_expression = 'assignments("' || OLD.slug || '")';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS update_gradebook_column_max_score_trigger ON public.assignments;
DROP FUNCTION IF EXISTS public.update_gradebook_column_max_score();

CREATE TRIGGER sync_gradebook_column_from_assignment_trigger
AFTER UPDATE OF title, total_points ON public.assignments
FOR EACH ROW EXECUTE FUNCTION public.sync_gradebook_column_from_assignment();
