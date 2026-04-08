-- Fix: auto-created assignment gradebook columns should get a sort_order
-- Previously they were left NULL, which broke column grouping and reorder features.

CREATE OR REPLACE FUNCTION public.create_gradebook_column_for_assignment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    gradebook_id bigint;
    new_col_id bigint;
    next_sort_order integer;
BEGIN
    -- Get the gradebook_id for this class
    SELECT g.id INTO gradebook_id
    FROM public.gradebooks g
    WHERE g.class_id = NEW.class_id;

    -- Determine next sort_order: max existing sort_order + 1, or 0 if none exist
    SELECT COALESCE(MAX(sort_order), -1) + 1 INTO next_sort_order
    FROM public.gradebook_columns
    WHERE class_id = NEW.class_id
      AND sort_order IS NOT NULL;

    -- Create the gradebook column
    INSERT INTO public.gradebook_columns (
        name,
        max_score,
        slug,
        class_id,
        gradebook_id,
        score_expression,
        released,
        dependencies,
        sort_order
    ) VALUES (
        NEW.title,
        NEW.total_points,
        'assignment-' || NEW.slug,
        NEW.class_id,
        gradebook_id,
        'assignments("' || NEW.slug || '")',
        false,
        jsonb_build_object('assignments', jsonb_build_array(NEW.id)),
        next_sort_order
    ) RETURNING id into new_col_id;

    -- Since this is an AFTER INSERT trigger, we need to UPDATE the assignments table
    -- to set the gradebook_column_id
    UPDATE public.assignments
    SET gradebook_column_id = new_col_id
    WHERE id = NEW.id;

    RETURN NEW;
END;
$function$;

-- Backfill NULL sort_orders on existing assignment gradebook columns.
-- Assign sequential sort_orders per class, starting after the current max.
DO $$
DECLARE
    rec RECORD;
    current_class_id bigint := -1;
    next_order integer := 0;
BEGIN
    FOR rec IN
        SELECT gc.id, gc.class_id
        FROM gradebook_columns gc
        WHERE gc.sort_order IS NULL
        ORDER BY gc.class_id, gc.id
    LOOP
        IF rec.class_id <> current_class_id THEN
            current_class_id := rec.class_id;
            SELECT COALESCE(MAX(sort_order), -1) + 1 INTO next_order
            FROM gradebook_columns
            WHERE class_id = current_class_id
              AND sort_order IS NOT NULL;
        END IF;

        UPDATE gradebook_columns SET sort_order = next_order WHERE id = rec.id;
        next_order := next_order + 1;
    END LOOP;
END $$;
