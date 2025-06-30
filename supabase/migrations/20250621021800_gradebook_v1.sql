ALTER TABLE public.gradebook_column_students ADD COLUMN is_recalculating boolean NOT NULL DEFAULT false;
ALTER TABLE public.gradebooks ADD COLUMN expression_prefix text DEFAULT '';
alter table "public"."gradebook_columns" add column "show_calculated_ranges" boolean not null default true;

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

-- Function to recalculate newly inserted gradebook column student cells
CREATE OR REPLACE FUNCTION public.recalculate_new_gradebook_column_students()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    messages jsonb[];
BEGIN

    -- Build messages for all newly inserted gradebook column students
    -- Only for columns that have a non-null score_expression
    SELECT array_agg(
        jsonb_build_object(
            'gradebook_column_id', gcs.gradebook_column_id,
            'student_id', gcs.student_id,
            'gradebook_column_student_id', gcs.id,
            'is_private', gcs.is_private,
            'reason', 'gradebook_column_student_new_gradebook_column_students',
            'trigger_id', NEW.id
        )
    )
    INTO messages
    FROM new_table gcs
    JOIN public.gradebook_columns gc ON gc.id = gcs.gradebook_column_id
    WHERE gc.score_expression IS NOT NULL AND NOT gcs.is_recalculating;

    -- Send messages using helper function
    PERFORM public.send_gradebook_recalculation_messages(messages);

    RETURN NULL;
END;
$function$;

-- Create statement-level trigger for recalculating new gradebook column students
CREATE TRIGGER trigger_recalculate_new_gradebook_column_students
AFTER INSERT ON public.gradebook_column_students
    REFERENCING NEW TABLE AS new_table
FOR EACH STATEMENT
EXECUTE FUNCTION public.recalculate_new_gradebook_column_students();

CREATE OR REPLACE FUNCTION public.insert_gradebook_column_students_for_new_column()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  INSERT INTO public.gradebook_column_students (
    class_id,
    gradebook_id,
    gradebook_column_id,
    student_id,
    is_excused,
    is_missing,
    released,
    is_private
  )
  SELECT
    NEW.class_id,
    NEW.gradebook_id,
    NEW.id,
    ur.private_profile_id,           
    FALSE,
    FALSE,
    FALSE,
    FALSE
  FROM public.user_roles ur
  WHERE ur.class_id = NEW.class_id AND ur.role = 'student';
    INSERT INTO public.gradebook_column_students (
    class_id,
    gradebook_id,
    gradebook_column_id,
    student_id,
    is_excused,
    is_missing,
    released,
    is_private
  )
  SELECT
    NEW.class_id,
    NEW.gradebook_id,
    NEW.id,
    ur.private_profile_id,           
    FALSE,
    FALSE,
    FALSE,
    TRUE
  FROM public.user_roles ur
  WHERE ur.class_id = NEW.class_id AND ur.role = 'student';
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.insert_gradebook_column_students_for_new_student()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  -- Only act if the role is 'student'
  IF (NEW.role = 'student') THEN
    -- Only insert if this is a new student (not already present in gradebook_column_students for this class)
    INSERT INTO public.gradebook_column_students (
      class_id,
      gradebook_id,
      gradebook_column_id,
      student_id,
      is_droppable,
      is_excused,
      is_missing,
      released,
      is_private
    )
    SELECT
      gc.class_id,
      gc.gradebook_id,
      gc.id,
      NEW.private_profile_id,
      FALSE, FALSE, FALSE, FALSE, FALSE
    FROM public.gradebook_columns gc
    WHERE gc.class_id = NEW.class_id
      AND NOT EXISTS (
        SELECT 1 FROM public.gradebook_column_students gcs
        WHERE gcs.gradebook_column_id = gc.id
          AND gcs.student_id = NEW.private_profile_id
          AND gcs.is_private = FALSE
      );
          INSERT INTO public.gradebook_column_students (
      class_id,
      gradebook_id,
      gradebook_column_id,
      student_id,
      is_droppable,
      is_excused,
      is_missing,
      released,
      is_private
    )
    SELECT
      gc.class_id,
      gc.gradebook_id,
      gc.id,
      NEW.private_profile_id,
      FALSE, FALSE, FALSE, FALSE, TRUE
    FROM public.gradebook_columns gc
    WHERE gc.class_id = NEW.class_id
      AND NOT EXISTS (
        SELECT 1 FROM public.gradebook_column_students gcs
        WHERE gcs.gradebook_column_id = gc.id
          AND gcs.student_id = NEW.private_profile_id
          AND gcs.is_private = TRUE
      );
  END IF;
  RETURN NEW;
END;
$function$
;
drop policy "graders and the student views (if released)" on "public"."gradebook_column_students";

alter table "public"."gradebook_column_students" add column "is_private" boolean;
update public.gradebook_column_students set is_private = true;
alter table "public"."gradebook_column_students" alter column "is_private" set not null;

alter table "public"."gradebook_column_students" add column "incomplete_values" jsonb; 

create policy "instructors and graders view all"
on "public"."gradebook_column_students"
as permissive
for select
to public
using (authorizeforclassgrader(class_id));


create policy "student views non-private only"
on "public"."gradebook_column_students"
as permissive
for select
to public
using ((authorizeforprofile(student_id) AND (is_private = false)));

CREATE OR REPLACE FUNCTION public.gradebook_column_student_recalculate_dependents()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    messages jsonb[];
BEGIN

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

CREATE OR REPLACE FUNCTION public.submission_review_recalculate_dependent_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    assignment_id bigint;
    dependent_column RECORD;
    submission_student_id uuid;
    group_id bigint;
    messages jsonb[];
BEGIN

    IF TG_OP = 'UPDATE' AND NEW.total_score = OLD.total_score AND NEW.released = OLD.released THEN
        RETURN NEW;
    END IF;

    -- 1. Find the assignment, profile, and group for this submission review
    SELECT submissions.assignment_id, submissions.profile_id, submissions.assignment_group_id
      INTO assignment_id, submission_student_id, group_id
      FROM public.submissions
     WHERE submissions.id = NEW.submission_id;

    -- 2. For each gradebook_column that depends on this assignment
    FOR dependent_column IN
        SELECT gradebook_columns.id
        FROM public.gradebook_columns
        WHERE dependencies->'assignments' @> to_jsonb(ARRAY[assignment_id]::bigint[])
    LOOP
        IF submission_student_id IS NOT NULL THEN
            -- Individual submission: add one message
            messages := messages || (
                SELECT array_agg(
                    jsonb_build_object(
                        'gradebook_column_id', dependent_column.id,
                        'student_id', submission_student_id,
                        'is_private', gcs.is_private,
                        'gradebook_column_student_id', gcs.id,
                        'reason', 'individual_submission'
                    )
                )
                FROM public.gradebook_column_students gcs
                WHERE gcs.gradebook_column_id = dependent_column.id
                AND gcs.student_id = submission_student_id
            );
        ELSIF group_id IS NOT NULL THEN
            -- Group submission: add a message for each student in the group
            messages := messages || (
                SELECT array_agg(
                    jsonb_build_object(
                        'gradebook_column_id', dependent_column.id,
                        'student_id', agm.profile_id,
                        'is_private', gcs.is_private,
                        'gradebook_column_student_id', gcs.id,
                        'reason', 'group_submission'
                    )
                )
                FROM public.assignment_groups_members agm
                INNER JOIN public.gradebook_column_students gcs ON gcs.gradebook_column_id = dependent_column.id AND gcs.student_id = agm.profile_id
                WHERE agm.assignment_group_id = group_id
            );
        END IF;
    END LOOP;

    -- 3. Send messages using helper function
    PERFORM public.send_gradebook_recalculation_messages(messages);

    RETURN NEW;
END;
$function$
;

-- Function to sync private gradebook column student data to non-private record when released
CREATE OR REPLACE FUNCTION public.sync_private_gradebook_column_student()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
    -- Only proceed if there are private records that changed released status
    IF NOT EXISTS (
        SELECT 1 FROM new_table, old_table, public.gradebook_columns gc 
        WHERE new_table.is_private = true
        AND new_table.released IS DISTINCT FROM old_table.released
        AND gc.score_expression is null
        AND gc.id = new_table.gradebook_column_id
    ) THEN
        RETURN NULL;
    END IF;

    -- When private records are released, sync data to non-private records
    UPDATE public.gradebook_column_students
    SET 
        score = CASE 
            WHEN new_table.score_override IS NOT NULL THEN new_table.score_override
            ELSE new_table.score
        END,
        is_missing = new_table.is_missing,
        is_droppable = new_table.is_droppable,
        is_excused = new_table.is_excused,
        released = true
    FROM new_table, old_table, public.gradebook_columns gc
    WHERE gradebook_column_students.gradebook_column_id = new_table.gradebook_column_id
    AND gradebook_column_students.student_id = new_table.student_id
    AND gradebook_column_students.is_private = false
    AND new_table.is_private = true
    AND gc.id = new_table.gradebook_column_id
    AND new_table.released = true AND old_table.released = false
    AND gc.score_expression is null
    AND old_table.is_recalculating = false
    AND gradebook_column_students.released = false
    AND new_table.is_recalculating = false;

    -- When private records are unreleased, clear data in non-private records
    UPDATE public.gradebook_column_students
    SET 
        score = NULL,
        is_missing = false,
        is_droppable = false,
        is_excused = false,
        released = false
    FROM new_table, old_table, public.gradebook_columns gc
    WHERE gradebook_column_students.gradebook_column_id = new_table.gradebook_column_id
    AND gradebook_column_students.student_id = new_table.student_id
    AND gradebook_column_students.is_private = false
    AND new_table.is_private = true
    AND gc.id = new_table.gradebook_column_id
    AND new_table.released = false
    AND old_table.released = true
    AND gc.score_expression is null
    AND old_table.is_recalculating = false
    AND gradebook_column_students.released = true
    AND new_table.is_recalculating = false;

    RETURN NULL;
END;
$function$;

-- Create statement-level trigger for syncing private gradebook column student data
CREATE TRIGGER trigger_sync_private_gradebook_column_student
AFTER UPDATE ON public.gradebook_column_students
    REFERENCING NEW TABLE AS new_table OLD TABLE AS old_table
FOR EACH STATEMENT
EXECUTE FUNCTION public.sync_private_gradebook_column_student();

CREATE OR REPLACE FUNCTION public.update_gradebook_column_students_released()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
    -- Only act if the released field has changed
    IF NEW.released IS DISTINCT FROM OLD.released THEN
        UPDATE public.gradebook_column_students
        SET released = NEW.released
        WHERE gradebook_column_id = NEW.id AND is_private = true;
    END IF;
    RETURN NEW;
END;
$function$;

-- Function to sync field changes from private to public record when private is already released
CREATE OR REPLACE FUNCTION public.sync_private_gradebook_column_student_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
    -- Only proceed if there are private records that are released and have field changes
    IF NOT EXISTS (
        SELECT 1 FROM new_table, old_table, public.gradebook_columns gc
        WHERE new_table.is_private = true
        AND new_table.released = true
        AND gc.id = new_table.gradebook_column_id
        AND gc.score_expression is null
        AND (
            new_table.score IS DISTINCT FROM old_table.score OR
            new_table.score_override IS DISTINCT FROM old_table.score_override OR
            new_table.is_missing IS DISTINCT FROM old_table.is_missing OR
            new_table.is_droppable IS DISTINCT FROM old_table.is_droppable OR
            new_table.is_excused IS DISTINCT FROM old_table.is_excused
        )
    ) THEN
        RETURN NULL;
    END IF;

    -- Sync field changes from private to public record when private is already released
    UPDATE public.gradebook_column_students
    SET 
        score = CASE 
            WHEN new_table.score_override IS NOT NULL THEN new_table.score_override
            ELSE new_table.score
        END,
        is_missing = new_table.is_missing,
        is_droppable = new_table.is_droppable,
        is_excused = new_table.is_excused
    FROM new_table, old_table, public.gradebook_columns gc
    WHERE gradebook_column_students.gradebook_column_id = new_table.gradebook_column_id
    AND gradebook_column_students.student_id = new_table.student_id
    AND gradebook_column_students.is_private = false
    AND new_table.is_private = true
    AND new_table.released = true
    AND old_table.is_recalculating = false
    AND gc.score_expression is null
    AND gc.id = new_table.gradebook_column_id
    AND new_table.is_recalculating = false;

    RETURN NULL;
END;
$function$;

-- Function to sync field changes from private to public record when private is already released for calculated columns
CREATE OR REPLACE FUNCTION public.sync_private_gradebook_column_student_fields_for_calculated_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
    -- Only proceed if there are private records that are released and have field changes
    IF NOT EXISTS (
        SELECT 1 FROM new_table, old_table, public.gradebook_columns gc
        WHERE new_table.is_private = true
        AND gc.id = new_table.gradebook_column_id
        AND gc.score_expression is not null
        AND (
            new_table.score_override IS DISTINCT FROM old_table.score_override 
        )
    ) THEN
        RETURN NULL;
    END IF;

    -- Sync field changes from private to public record when private is already released
    UPDATE public.gradebook_column_students
    SET 
        score_override = new_table.score_override,
        is_missing = new_table.is_missing,
        is_droppable = new_table.is_droppable,
        is_excused = new_table.is_excused
    FROM new_table, old_table, public.gradebook_columns gc
    WHERE gradebook_column_students.gradebook_column_id = new_table.gradebook_column_id
    AND gradebook_column_students.student_id = new_table.student_id
    AND gradebook_column_students.is_private = false
    AND new_table.is_private = true
    AND old_table.is_recalculating = false
    AND gc.score_expression is not null
    AND gc.id = new_table.gradebook_column_id
    AND new_table.is_recalculating = false;

    RETURN NULL;
END;
$function$;


-- Trigger to recalculate all student cells for a column when its score_expression changes
CREATE OR REPLACE FUNCTION public.recalculate_gradebook_column_for_all_students()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    messages jsonb[];
BEGIN
    -- Only act if the score_expression has changed
    IF NEW.score_expression IS DISTINCT FROM OLD.score_expression THEN
        -- Gather all students for this column
        SELECT array_agg(
            jsonb_build_object(
                'gradebook_column_id', NEW.id,
                'student_id', gcs.student_id,
                'is_private', gcs.is_private,
                'gradebook_column_student_id', gcs.id,
                'reason', 'score_expression_change',
                'trigger_id', NEW.id
            )
        )
        INTO messages
        FROM gradebook_column_students gcs
        WHERE gcs.gradebook_column_id = NEW.id;

        -- Send all messages in a single batch if there are any
        IF messages IS NOT NULL THEN
            PERFORM public.send_gradebook_recalculation_messages(messages);
        END IF;
    END IF;
    RETURN NEW;
END;
$function$;

-- Create statement-level trigger for syncing field changes from private to public record
CREATE TRIGGER trigger_sync_private_gradebook_column_student_fields
AFTER UPDATE ON public.gradebook_column_students
    REFERENCING NEW TABLE AS new_table OLD TABLE AS old_table
FOR EACH STATEMENT
EXECUTE FUNCTION public.sync_private_gradebook_column_student_fields();

-- Create statement-level trigger for syncing field changes from private to public record for calculated columns
CREATE TRIGGER trigger_sync_private_gradebook_column_student_fields_for_calculated_columns
AFTER UPDATE ON public.gradebook_column_students
    REFERENCING NEW TABLE AS new_table OLD TABLE AS old_table
FOR EACH STATEMENT
EXECUTE FUNCTION public.sync_private_gradebook_column_student_fields_for_calculated_columns();

alter table "public"."gradebook_columns" add column "external_data" jsonb;

create policy "instructors delete"
on "public"."gradebook_column_students"
as permissive
for delete
to public
using (authorizeforclassinstructor(class_id));