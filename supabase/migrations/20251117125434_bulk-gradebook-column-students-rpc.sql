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
DECLARE
    invalid_student_ids text[];
    invalid_column_ids text[];
    element_text text;
BEGIN
    -- Validate input types: both parameters must be JSONB arrays
    IF jsonb_typeof(p_student_ids) != 'array' THEN
        RAISE EXCEPTION 'p_student_ids must be a JSONB array, got type: %', jsonb_typeof(p_student_ids)
            USING ERRCODE = 'invalid_parameter_value';
    END IF;
    
    IF jsonb_typeof(p_gradebook_column_ids) != 'array' THEN
        RAISE EXCEPTION 'p_gradebook_column_ids must be a JSONB array, got type: %', jsonb_typeof(p_gradebook_column_ids)
            USING ERRCODE = 'invalid_parameter_value';
    END IF;
    
    -- Validate and collect invalid student_id elements before casting
    invalid_student_ids := ARRAY[]::text[];
    FOR element_text IN SELECT jsonb_array_elements_text(p_student_ids) LOOP
        -- Check if element can be cast to UUID
        BEGIN
            PERFORM element_text::uuid;
        EXCEPTION WHEN OTHERS THEN
            invalid_student_ids := array_append(invalid_student_ids, element_text);
        END;
    END LOOP;
    
    IF array_length(invalid_student_ids, 1) > 0 THEN
        RAISE EXCEPTION 'Invalid UUID values in p_student_ids: %', array_to_string(invalid_student_ids, ', ')
            USING ERRCODE = 'invalid_parameter_value';
    END IF;
    
    -- Validate and collect invalid gradebook_column_id elements before casting
    invalid_column_ids := ARRAY[]::text[];
    FOR element_text IN SELECT jsonb_array_elements_text(p_gradebook_column_ids) LOOP
        -- Check if element can be cast to bigint (must be numeric and within bigint range)
        BEGIN
            PERFORM element_text::bigint;
        EXCEPTION WHEN OTHERS THEN
            invalid_column_ids := array_append(invalid_column_ids, element_text);
        END;
    END LOOP;
    
    IF array_length(invalid_column_ids, 1) > 0 THEN
        RAISE EXCEPTION 'Invalid bigint values in p_gradebook_column_ids: %', array_to_string(invalid_column_ids, ', ')
            USING ERRCODE = 'invalid_parameter_value';
    END IF;
    
    -- Create temporary tables for efficient joins
    CREATE TEMP TABLE temp_student_ids (student_id uuid PRIMARY KEY) ON COMMIT DROP;
    CREATE TEMP TABLE temp_gradebook_column_ids (gradebook_column_id bigint PRIMARY KEY) ON COMMIT DROP;
    
    -- Populate temporary tables from JSONB arrays (validation passed, safe to cast)
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

COMMENT ON FUNCTION "public"."get_gradebook_column_students_bulk"(jsonb, jsonb) IS 
'Efficiently fetch gradebook_column_students rows for large arrays of student_ids and gradebook_column_ids. 
Uses temporary tables with joins instead of IN clauses to avoid PostgreSQL limitations.

Input format:
- p_student_ids: JSONB array of UUID strings, e.g., ["550e8400-e29b-41d4-a716-446655440000", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"]
- p_gradebook_column_ids: JSONB array of numeric strings or numbers, e.g., [1, 2, 3] or ["1", "2", "3"]

The function validates input types and element formats before processing:
- Both parameters must be JSONB arrays (jsonb_typeof = ''array'')
- All p_student_ids elements must be valid UUID strings
- All p_gradebook_column_ids elements must be valid bigint values (numeric strings or numbers)

Raises exceptions with descriptive error messages if validation fails, failing fast on invalid input.';

