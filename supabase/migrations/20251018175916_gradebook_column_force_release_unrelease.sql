CREATE OR REPLACE FUNCTION "public"."update_gradebook_column_students_released"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
    -- Act on any gradebook_column_students that do not have released = NEW.released
    UPDATE public.gradebook_column_students gcs
    SET released = NEW.released
    WHERE gradebook_column_id = NEW.id AND is_private = true AND released <> NEW.released;
    RETURN NEW;
END;
$$;
