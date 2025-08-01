-- Fix double-triggering of gradebook column recalculation on new columns
CREATE OR REPLACE FUNCTION public.gradebook_column_student_recalculate_dependents()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    messages jsonb[];
BEGIN

    -- Skip if this is a new INSERT (no OLD record exists... in that case we should already be triggering a recalculate)
    IF TG_OP = 'INSERT' THEN
        RETURN NEW;
    END IF;

    -- Only trigger if score or is_missing status has changed
    IF (NEW.score IS NOT DISTINCT FROM OLD.score AND NEW.score_override IS NOT DISTINCT FROM OLD.score_override AND NEW.is_missing IS NOT DISTINCT FROM OLD.is_missing
    AND NEW.is_droppable IS NOT DISTINCT FROM OLD.is_droppable AND NEW.is_excused IS NOT DISTINCT FROM OLD.is_excused) THEN
        RETURN NEW;
    END IF;

    IF (NEW.is_recalculating) THEN
        RETURN NEW;
    END IF;

    -- Build an array of messages for all dependent columns
    SELECT array_agg(
        jsonb_build_object(
            'gradebook_column_id', gradebook_columns.id,
            'student_id', NEW.student_id,
            'is_private', gcs.is_private,
            'gradebook_column_student_id', gcs.id,
            'reason', 'gradebook_column_student_recalculate_dependents',
            'trigger_id', NEW.id
        )
    )
    INTO messages
    FROM public.gradebook_columns
    INNER JOIN public.gradebook_column_students gcs ON gcs.gradebook_column_id = gradebook_columns.id AND gcs.student_id = NEW.student_id AND gcs.is_private = NEW.is_private
    WHERE dependencies->'gradebook_columns' @> to_jsonb(ARRAY[NEW.gradebook_column_id]::bigint[])
    AND NOT gcs.is_recalculating;

    -- Send messages using helper function
    PERFORM public.send_gradebook_recalculation_messages(messages);

    RETURN NEW;
END;
$function$
;

-- Fix the gradebook trigger conflict by converting row-level trigger to statement-level
-- This prevents the "tuple to be updated was already modified" error

-- Drop the existing row-level trigger
DROP TRIGGER IF EXISTS trigger_recalculate_dependent_columns ON public.gradebook_column_students;

-- Create a new statement-level function that processes all changed rows at once
CREATE OR REPLACE FUNCTION public.gradebook_column_student_recalculate_dependents_statement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    messages jsonb[];
BEGIN
    -- Only process UPDATE operations (skip INSERT since those are handled by the statement-level trigger)
    IF TG_OP = 'INSERT' THEN
        RETURN NULL;
    END IF;

    -- Build messages for all changed records in this statement
    -- Compare new_table with old_table to find records that actually changed
    SELECT array_agg(
        jsonb_build_object(
            'gradebook_column_id', gradebook_columns.id,
            'student_id', new_rec.student_id,
            'is_private', gcs.is_private,
            'gradebook_column_student_id', gcs.id,
            'reason', 'gradebook_column_student_recalculate_dependents_statement',
            'trigger_id', new_rec.id
        )
    )
    INTO messages
    FROM new_table new_rec
    INNER JOIN old_table old_rec ON new_rec.id = old_rec.id
    INNER JOIN public.gradebook_columns ON dependencies->'gradebook_columns' @> to_jsonb(ARRAY[new_rec.gradebook_column_id]::bigint[])
    INNER JOIN public.gradebook_column_students gcs ON gcs.gradebook_column_id = gradebook_columns.id 
        AND gcs.student_id = new_rec.student_id 
        AND gcs.is_private = new_rec.is_private
    WHERE NOT gcs.is_recalculating
    AND (
        -- Only include records that actually changed
        new_rec.score IS DISTINCT FROM old_rec.score OR
        new_rec.score_override IS DISTINCT FROM old_rec.score_override OR
        new_rec.is_missing IS DISTINCT FROM old_rec.is_missing OR
        new_rec.is_droppable IS DISTINCT FROM old_rec.is_droppable OR
        new_rec.is_excused IS DISTINCT FROM old_rec.is_excused
    );

    -- Send messages using helper function
    PERFORM public.send_gradebook_recalculation_messages(messages);

    RETURN NULL;
END;
$function$;

-- Create the new statement-level trigger
CREATE TRIGGER trigger_recalculate_dependent_columns_statement
AFTER UPDATE ON public.gradebook_column_students
    REFERENCING NEW TABLE AS new_table OLD TABLE AS old_table
FOR EACH STATEMENT
EXECUTE FUNCTION public.gradebook_column_student_recalculate_dependents_statement(); 

-- Helper function to send gradebook column recalculation messages
CREATE OR REPLACE FUNCTION public.send_gradebook_recalculation_messages(messages jsonb[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
    -- Send all messages in a single batch if there are any
    IF messages IS NOT NULL THEN
        PERFORM pgmq_public.send_batch(
            queue_name := 'gradebook_column_recalculate',
            messages := messages
        );
        
        -- Update all gradebook_column_students to set is_recalculating=true in a single operation
        UPDATE public.gradebook_column_students
        SET is_recalculating = true
        WHERE gradebook_column_students.id = ANY(
            SELECT (message->>'gradebook_column_student_id')::bigint
            FROM unnest(messages) AS message
        );
    END IF;
END;
$function$;

-- Helper function to send gradebook column recalculation messages
CREATE OR REPLACE FUNCTION public.invoke_gradebook_recalculation_background_task()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
    PERFORM public.call_edge_function_internal(
        '/functions/v1/gradebook-column-recalculate', 
        'POST', 
        '{"Content-type":"application/json","x-supabase-webhook-source":"gradebook_column_recalculate"}', 
        '{}', 
        5000,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL
    );
        PERFORM public.call_edge_function_internal(
        '/functions/v1/gradebook-column-recalculate', 
        'POST', 
        '{"Content-type":"application/json","x-supabase-webhook-source":"gradebook_column_recalculate"}', 
        '{}', 
        5000,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL
    );
        PERFORM public.call_edge_function_internal(
        '/functions/v1/gradebook-column-recalculate', 
        'POST', 
        '{"Content-type":"application/json","x-supabase-webhook-source":"gradebook_column_recalculate"}', 
        '{}', 
        5000,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL
    );
        PERFORM public.call_edge_function_internal(
        '/functions/v1/gradebook-column-recalculate', 
        'POST', 
        '{"Content-type":"application/json","x-supabase-webhook-source":"gradebook_column_recalculate"}', 
        '{}', 
        5000,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL
    );
        PERFORM public.call_edge_function_internal(
        '/functions/v1/gradebook-column-recalculate', 
        'POST', 
        '{"Content-type":"application/json","x-supabase-webhook-source":"gradebook_column_recalculate"}', 
        '{}', 
        5000,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL
    );
END;
$function$;
select
cron.schedule('invoke-gradebook-recalculation-background-task-every-minute', '* * * * *', 'SELECT invoke_gradebook_recalculation_background_task();');