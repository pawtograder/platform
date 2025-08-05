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

DROP TRIGGER IF EXISTS trigger_handle_gradebook_column_sort_order ON public.gradebook_columns;

-- Simple replacement that just assigns sort_order without shifting existing columns
CREATE OR REPLACE FUNCTION public.handle_gradebook_column_sort_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    max_sort_order integer;
BEGIN
    -- Only assign sort_order if it's NULL, don't shift existing columns
    IF NEW.sort_order IS NULL THEN
        SELECT COALESCE(MAX(sort_order), -1) + 1
        INTO max_sort_order
        FROM public.gradebook_columns
        WHERE gradebook_id = NEW.gradebook_id;
        
        NEW.sort_order := max_sort_order;
    END IF;
    
    RETURN NEW;
END;
$function$;

-- Create a simpler trigger that doesn't cause race conditions
CREATE TRIGGER trigger_handle_gradebook_column_sort_order
BEFORE INSERT ON public.gradebook_columns
FOR EACH ROW
EXECUTE FUNCTION public.handle_gradebook_column_sort_order();

-- Create unified broadcast function for gradebook changes
CREATE OR REPLACE FUNCTION broadcast_gradebook_data_change()
RETURNS TRIGGER AS $$
DECLARE
    class_id_val BIGINT;
    student_id_val UUID;
    staff_payload JSONB;
    user_payload JSONB;
BEGIN
    -- Get the relevant IDs and context based on table and operation
    IF TG_TABLE_NAME = 'gradebook_column_students' THEN
        IF TG_OP = 'INSERT' THEN
            class_id_val := NEW.class_id;
            student_id_val := NEW.student_id;
        ELSIF TG_OP = 'UPDATE' THEN
            class_id_val := COALESCE(NEW.class_id, OLD.class_id);
            student_id_val := COALESCE(NEW.student_id, OLD.student_id);
        ELSIF TG_OP = 'DELETE' THEN
            class_id_val := OLD.class_id;
            student_id_val := OLD.student_id;
        END IF;
    ELSIF TG_TABLE_NAME = 'gradebook_columns' THEN
        IF TG_OP = 'INSERT' THEN
            class_id_val := NEW.class_id;
        ELSIF TG_OP = 'UPDATE' THEN
            class_id_val := COALESCE(NEW.class_id, OLD.class_id);
        ELSIF TG_OP = 'DELETE' THEN
            class_id_val := OLD.class_id;
        END IF;
    END IF;

    -- Only broadcast if there's a class_id
    IF class_id_val IS NOT NULL THEN
        -- Create payload for staff (instructors/graders see everything with full data)
        staff_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'data', CASE
                WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
                ELSE to_jsonb(NEW)
            END,
            'class_id', class_id_val,
            'timestamp', NOW()
        );

        -- Broadcast to staff channel (instructors/graders see all changes)
        PERFORM realtime.send(
            staff_payload,
            'broadcast',
            'gradebook:' || class_id_val || ':staff',
            true
        );

        -- For gradebook_column_students, also broadcast to the affected student
        -- Only broadcast to student if grades are not private (is_private = false)
        IF TG_TABLE_NAME = 'gradebook_column_students' AND student_id_val IS NOT NULL THEN
            -- Check if this should be visible to the student
            -- For INSERT/UPDATE: only if is_private = false
            -- For DELETE: always notify (student should know their grade was removed)
            IF TG_OP = 'DELETE' OR
               (TG_OP IN ('INSERT', 'UPDATE') AND NEW.is_private = false) THEN
                
                user_payload := staff_payload || jsonb_build_object('target_audience', 'student');
                
                PERFORM realtime.send(
                    user_payload,
                    'broadcast',
                    'gradebook:' || class_id_val || ':student:' || student_id_val,
                    true
                );
            END IF;
        ELSIF TG_TABLE_NAME = 'gradebook_columns' THEN
            -- For gradebook_columns changes, broadcast to all students in the class
            -- since column changes (like new assignments) affect everyone
            user_payload := staff_payload || jsonb_build_object('target_audience', 'student');
            
            -- Broadcast to a general student channel for the class
            PERFORM realtime.send(
                user_payload,
                'broadcast',
                'gradebook:' || class_id_val || ':students',
                true
            );
        END IF;
    END IF;

    -- Return the appropriate record
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create triggers for gradebook tables
CREATE OR REPLACE TRIGGER broadcast_gradebook_column_students_unified
    AFTER INSERT OR UPDATE OR DELETE ON "public"."gradebook_column_students"
    FOR EACH ROW
    EXECUTE FUNCTION broadcast_gradebook_data_change();

CREATE OR REPLACE TRIGGER broadcast_gradebook_columns_unified
    AFTER INSERT OR UPDATE OR DELETE ON "public"."gradebook_columns"
    FOR EACH ROW
    EXECUTE FUNCTION broadcast_gradebook_data_change();

-- Create function to pre-create gradebook channels when class is created
CREATE OR REPLACE FUNCTION create_gradebook_staff_channel()
RETURNS TRIGGER AS $$
BEGIN
    -- Pre-create the gradebook staff channel by sending an initial message
    PERFORM realtime.send(
        jsonb_build_object(
            'type', 'channel_created',
            'class_id', NEW.id,
            'created_at', NOW()
        ),
        'system',
        'gradebook:' || NEW.id || ':staff',
        true
    );
    
    -- Pre-create the gradebook students channel by sending an initial message
    PERFORM realtime.send(
        jsonb_build_object(
            'type', 'channel_created',
            'class_id', NEW.id,
            'created_at', NOW()
        ),
        'system',
        'gradebook:' || NEW.id || ':students',
        true
    );
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create function to pre-create gradebook student channel when student is added
CREATE OR REPLACE FUNCTION create_gradebook_student_channel()
RETURNS TRIGGER AS $$
BEGIN
    -- Only create channel for students
    IF NEW.role = 'student' THEN
        -- Pre-create the individual student gradebook channel
        PERFORM realtime.send(
            jsonb_build_object(
                'type', 'channel_created',
                'class_id', NEW.class_id,
                'student_id', NEW.private_profile_id,
                'created_at', NOW()
            ),
            'system',
            'gradebook:' || NEW.class_id || ':student:' || NEW.private_profile_id,
            true
        );
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create triggers to pre-create gradebook channels
CREATE OR REPLACE TRIGGER create_gradebook_staff_channel_trigger
    AFTER INSERT ON "public"."classes"
    FOR EACH ROW
    EXECUTE FUNCTION create_gradebook_staff_channel();

CREATE OR REPLACE TRIGGER create_gradebook_student_channel_trigger
    AFTER INSERT ON "public"."user_roles"
    FOR EACH ROW
    EXECUTE FUNCTION create_gradebook_student_channel();

-- Pre-create gradebook channels for all existing classes
DO $$
DECLARE
    class_record RECORD;
BEGIN
    FOR class_record IN SELECT id FROM "public"."classes"
    LOOP
        -- Pre-create the gradebook staff channel
        PERFORM realtime.send(
            jsonb_build_object(
                'type', 'channel_created',
                'class_id', class_record.id,
                'created_at', NOW()
            ),
            'system',
            'gradebook:' || class_record.id || ':staff',
            true
        );
        
        -- Pre-create the gradebook students channel
        PERFORM realtime.send(
            jsonb_build_object(
                'type', 'channel_created',
                'class_id', class_record.id,
                'created_at', NOW()
            ),
            'system',
            'gradebook:' || class_record.id || ':students',
            true
        );
    END LOOP;
END $$;

-- Pre-create gradebook channels for all existing students
DO $$
DECLARE
    student_record RECORD;
BEGIN
    FOR student_record IN SELECT class_id, private_profile_id FROM "public"."user_roles" WHERE role = 'student'
    LOOP
        -- Pre-create the individual student gradebook channel
        PERFORM realtime.send(
            jsonb_build_object(
                'type', 'channel_created',
                'class_id', student_record.class_id,
                'student_id', student_record.private_profile_id,
                'created_at', NOW()
            ),
            'system',
            'gradebook:' || student_record.class_id || ':student:' || student_record.private_profile_id,
            true
        );
    END LOOP;
END $$;

-- Create RLS authorization function for gradebook channels
CREATE OR REPLACE FUNCTION check_gradebook_realtime_authorization(topic_text text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    topic_parts text[];
    class_id_text text;
    student_id_text text;
    class_id_bigint bigint;
    student_id_uuid uuid;
    is_class_grader boolean;
    is_student_owner boolean;
BEGIN
    -- Parse topic - should be gradebook:123:staff, gradebook:123:students, or gradebook:123:student:uuid
    topic_parts := string_to_array(topic_text, ':');
    
    -- Must have at least 3 parts and start with 'gradebook'
    IF array_length(topic_parts, 1) < 3 OR topic_parts[1] != 'gradebook' THEN
        RETURN false;
    END IF;
    
    class_id_text := topic_parts[2];
    
    -- Convert class_id to bigint
    BEGIN
        class_id_bigint := class_id_text::bigint;
    EXCEPTION WHEN OTHERS THEN
        RETURN false;
    END;
    
    -- Handle different channel types
    IF topic_parts[3] = 'staff' THEN
        -- Staff channel - only graders/instructors
        RETURN authorizeforclassgrader(class_id_bigint);
        
    ELSIF topic_parts[3] = 'students' THEN
        -- General students channel - students and staff
        RETURN authorizeforclass(class_id_bigint);
        
    ELSIF topic_parts[3] = 'student' THEN
        -- Individual student channel - must have 4 parts
        IF array_length(topic_parts, 1) != 4 THEN
            RETURN false;
        END IF;
        
        student_id_text := topic_parts[4];
        
        -- Convert student_id to uuid
        BEGIN
            student_id_uuid := student_id_text::uuid;
        EXCEPTION WHEN OTHERS THEN
            RETURN false;
        END;
        
        -- Check if user is grader/instructor OR is the specific student
        is_class_grader := authorizeforclassgrader(class_id_bigint);
        is_student_owner := authorizeforprofile(student_id_uuid);
        
        RETURN is_class_grader OR is_student_owner;
        
    ELSE
        RETURN false;
    END IF;
END;
$$;

-- Update the existing unified RLS authorization function to handle gradebook channels
CREATE OR REPLACE FUNCTION check_unified_realtime_authorization(topic_text text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    topic_parts text[];
    topic_type text;
BEGIN
    -- Parse topic to get the first part
    topic_parts := string_to_array(topic_text, ':');
    
    IF array_length(topic_parts, 1) < 1 THEN
        RETURN false;
    END IF;
    
    topic_type := topic_parts[1];
    
    -- Handle gradebook channels
    IF topic_type = 'gradebook' THEN
        RETURN check_gradebook_realtime_authorization(topic_text);
    END IF;
    
    -- Fall back to original authorization logic for other channels
    DECLARE
        class_id_text text;
        submission_id_text text;
        profile_id_text text;
        class_id_bigint bigint;
        submission_id_bigint bigint;
        profile_id_uuid uuid;
        is_class_grader boolean;
        is_submission_authorized boolean;
        is_profile_owner boolean;
        channel_type text;
    BEGIN
        -- Must have at least 3 parts
        IF array_length(topic_parts, 1) < 3 THEN
            RETURN false;
        END IF;
        
        -- Handle class-level channels (for review_assignments, etc.)
        IF topic_type = 'class' THEN
            class_id_text := topic_parts[2];
            channel_type := topic_parts[3];
            
            -- Convert class_id to bigint
            BEGIN
                class_id_bigint := class_id_text::bigint;
            EXCEPTION WHEN OTHERS THEN
                RETURN false;
            END;
            
            -- Handle staff channel
            IF channel_type = 'staff' THEN
                RETURN authorizeforclassgrader(class_id_bigint);
            
            -- Handle user channel
            ELSIF channel_type = 'user' THEN
                -- Must have 4 parts for user channel
                IF array_length(topic_parts, 1) != 4 THEN
                    RETURN false;
                END IF;
                
                profile_id_text := topic_parts[4];
                
                -- Convert profile_id to uuid
                BEGIN
                    profile_id_uuid := profile_id_text::uuid;
                EXCEPTION WHEN OTHERS THEN
                    RETURN false;
                END;
                
                -- Check if user is grader/instructor OR is the profile owner
                is_class_grader := authorizeforclassgrader(class_id_bigint);
                is_profile_owner := authorizeforprofile(profile_id_uuid);
                
                RETURN is_class_grader OR is_profile_owner;
            
            ELSE
                RETURN false;
            END IF;
        
        -- Handle submission-level channels (for submission comments, etc.)
        ELSIF topic_type = 'submission' THEN
            submission_id_text := topic_parts[2];
            channel_type := topic_parts[3];
            
            -- Convert submission_id to bigint
            BEGIN
                submission_id_bigint := submission_id_text::bigint;
            EXCEPTION WHEN OTHERS THEN
                RETURN false;
            END;
            
            -- Handle graders channel
            IF channel_type = 'graders' THEN
                -- Get class_id from submission to check grader authorization
                SELECT s.class_id INTO class_id_bigint
                FROM submissions s
                WHERE s.id = submission_id_bigint;
                
                IF class_id_bigint IS NULL THEN
                    RETURN false;
                END IF;
                
                RETURN authorizeforclassgrader(class_id_bigint);
            
            -- Handle profile_id channel
            ELSIF channel_type = 'profile_id' THEN
                -- Must have 4 parts for profile_id channel
                IF array_length(topic_parts, 1) != 4 THEN
                    RETURN false;
                END IF;
                
                profile_id_text := topic_parts[4];
                
                -- Convert profile_id to uuid
                BEGIN
                    profile_id_uuid := profile_id_text::uuid;
                EXCEPTION WHEN OTHERS THEN
                    RETURN false;
                END;
                
                -- Check if user has access to the submission OR is the profile owner
                is_submission_authorized := authorize_for_submission(submission_id_bigint);
                is_profile_owner := authorizeforprofile(profile_id_uuid);
                
                -- Also check if user is a grader for the class (for extra access)
                SELECT s.class_id INTO class_id_bigint
                FROM submissions s
                WHERE s.id = submission_id_bigint;
                
                IF class_id_bigint IS NOT NULL THEN
                    is_class_grader := authorizeforclassgrader(class_id_bigint);
                ELSE
                    is_class_grader := false;
                END IF;
                
                RETURN is_class_grader OR is_submission_authorized OR is_profile_owner;
            
            ELSE
                RETURN false;
            END IF;
        
        ELSE
            RETURN false;
        END IF;
    END;
END;
$$;

-- Add comments for documentation
COMMENT ON FUNCTION broadcast_gradebook_data_change() IS
'Broadcasts changes to gradebook tables using gradebook-specific channels. For gradebook_column_students: sends full data to gradebook:$class_id:staff and gradebook:$class_id:student:$student_id channels (students only see when is_private = false). For gradebook_columns: sends to gradebook:$class_id:staff and gradebook:$class_id:students channels.';

COMMENT ON FUNCTION create_gradebook_staff_channel() IS
'Pre-creates gradebook staff and students channels when a new class is created';

COMMENT ON FUNCTION create_gradebook_student_channel() IS
'Pre-creates individual gradebook student channel when a new student is added to a class';

COMMENT ON FUNCTION check_gradebook_realtime_authorization(text) IS
'Authorizes access to gradebook broadcast channels. Supports gradebook:$class_id:staff (graders only), gradebook:$class_id:students (all class members), and gradebook:$class_id:student:$student_id (graders or specific student only).';

COMMENT ON TRIGGER broadcast_gradebook_column_students_unified ON "public"."gradebook_column_students" IS
'Broadcasts changes to gradebook_column_students table with full data. Staff see all changes via gradebook:$class_id:staff channel. Students see their own grades via gradebook:$class_id:student:$student_id channel only when is_private = false.';

COMMENT ON TRIGGER broadcast_gradebook_columns_unified ON "public"."gradebook_columns" IS
'Broadcasts changes to gradebook_columns table with full data to gradebook:$class_id:staff and gradebook:$class_id:students channels. Column changes (like new assignments) are visible to instructors/graders and students immediately.';