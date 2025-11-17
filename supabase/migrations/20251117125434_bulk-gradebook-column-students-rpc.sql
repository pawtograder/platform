-- Migration: Add RPC function to efficiently fetch gradebook_column_students for large arrays
-- This avoids PostgreSQL's IN clause limitations when dealing with many student_ids

CREATE OR REPLACE FUNCTION "public"."get_gradebook_column_students_bulk"(
    "p_student_ids" jsonb,
    "p_gradebook_column_ids" jsonb
)
RETURNS TABLE (
    id bigint,
    created_at timestamp with time zone,
    class_id bigint,
    gradebook_column_id bigint,
    gradebook_id bigint,
    is_droppable boolean,
    is_excused boolean,
    is_missing boolean,
    released boolean,
    score numeric,
    score_override numeric,
    score_override_note text,
    student_id uuid,
    is_private boolean,
    incomplete_values jsonb
)
LANGUAGE "plpgsql"
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
    -- Create temporary tables for efficient joins
    CREATE TEMP TABLE temp_student_ids (student_id uuid PRIMARY KEY) ON COMMIT DROP;
    CREATE TEMP TABLE temp_gradebook_column_ids (gradebook_column_id bigint PRIMARY KEY) ON COMMIT DROP;
    
    -- Populate temporary tables from JSONB arrays
    INSERT INTO temp_student_ids (student_id)
    SELECT DISTINCT jsonb_array_elements_text(p_student_ids)::uuid;
    
    INSERT INTO temp_gradebook_column_ids (gradebook_column_id)
    SELECT DISTINCT jsonb_array_elements_text(p_gradebook_column_ids)::bigint;
    
    -- Join against temporary tables for efficient filtering
    RETURN QUERY
    SELECT 
        gcs.id,
        gcs.created_at,
        gcs.class_id,
        gcs.gradebook_column_id,
        gcs.gradebook_id,
        gcs.is_droppable,
        gcs.is_excused,
        gcs.is_missing,
        gcs.released,
        gcs.score,
        gcs.score_override,
        gcs.score_override_note,
        gcs.student_id,
        gcs.is_private,
        gcs.incomplete_values
    FROM public.gradebook_column_students gcs
    INNER JOIN temp_student_ids ts ON gcs.student_id = ts.student_id
    INNER JOIN temp_gradebook_column_ids tgc ON gcs.gradebook_column_id = tgc.gradebook_column_id;
    
    -- Cleanup (tables will be dropped automatically on commit due to ON COMMIT DROP)
END;
$$;

-- Grant execute permissions to authenticated users (RLS still applies due to SECURITY INVOKER)
GRANT EXECUTE ON FUNCTION "public"."get_gradebook_column_students_bulk"(jsonb, jsonb) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."get_gradebook_column_students_bulk"(jsonb, jsonb) TO "service_role";

COMMENT ON FUNCTION "public"."get_gradebook_column_students_bulk"(jsonb, jsonb) IS 'Efficiently fetch gradebook_column_students rows for large arrays of student_ids and gradebook_column_ids. Uses array operations instead of IN clauses to avoid PostgreSQL limitations.';

