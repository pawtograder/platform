-- Add no_submission flag to assignments
alter table "public"."assignments" add column if not exists "no_submission" boolean not null default false;

-- Update function to skip creating gradebook column for no-submission assignments
CREATE OR REPLACE FUNCTION public.create_gradebook_column_for_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    gradebook_id bigint;
    new_col_id bigint;
BEGIN
    -- Skip creating a gradebook column for no-submission assignments
    IF NEW.no_submission THEN
        RETURN NEW;
    END IF;

    -- Get the gradebook_id for this class
    SELECT g.id INTO gradebook_id
    FROM public.gradebooks g
    WHERE g.class_id = NEW.class_id;

    IF NOT FOUND OR gradebook_id IS NULL THEN
        RAISE EXCEPTION 'No gradebook found for class_id=% when creating gradebook column for assignment id=%',
            NEW.class_id, NEW.id;
    END IF;

    -- Create the gradebook column
    INSERT INTO public.gradebook_columns (
        name,
        max_score,
        slug,
        class_id,
        gradebook_id,
        score_expression,
        released,
        dependencies
    ) VALUES (
        NEW.title,
        NEW.total_points,
        'assignment-' || NEW.slug,
        NEW.class_id,
        gradebook_id,
        'assignments("' || NEW.slug || '")',
        false,
        jsonb_build_object('assignments', jsonb_build_array(NEW.id))
    ) RETURNING id into new_col_id;

    -- Persist the generated column id on the assignment row
    UPDATE public.assignments
    SET gradebook_column_id = new_col_id
    WHERE id = NEW.id;

    RETURN NEW;
END;
$function$;