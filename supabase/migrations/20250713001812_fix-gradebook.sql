-- Function to create a gradebook column for a new assignment
CREATE OR REPLACE FUNCTION public.create_gradebook_column_for_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    gradebook_id bigint;
    new_col_id bigint;
BEGIN
    -- Get the gradebook_id for this class
    SELECT g.id INTO gradebook_id
    FROM public.gradebooks g
    WHERE g.class_id = NEW.class_id;

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

    NEW.gradebook_column_id = new_col_id;

    RETURN NEW;
END;
$function$;
