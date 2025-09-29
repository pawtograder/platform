-- Migration: Gradebook performance improvements (hoist RLS check, remove inline checks)
-- Goal: Perform a single early authorization check, then run pure SQL without repeated checks

-- get_gradebook_records_for_all_students: early RLS check, then fast aggregation
CREATE OR REPLACE FUNCTION "public"."get_gradebook_records_for_all_students"("p_class_id" bigint)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path TO pg_catalog,public
AS $$
BEGIN
    -- Early authorization guard - return immediately if unauthorized
    IF NOT public.authorizeforclassgrader(p_class_id) THEN
        RETURN '[]'::jsonb;
    END IF;
    
    -- Only execute heavy query if authorized
    RETURN (
        SELECT COALESCE(jsonb_agg(student_data ORDER BY student_id), '[]'::jsonb)
        FROM (
            SELECT 
                gcs.student_id,
                jsonb_build_object(
                    'private_profile_id', gcs.student_id::text,
                    'entries', jsonb_agg(
                        jsonb_build_object(
                            'gcs_id', gcs.id,
                            'gc_id', gcs.gradebook_column_id,
                            'is_private', gcs.is_private,
                            'score', gcs.score,
                            'score_override', gcs.score_override,
                            'is_missing', gcs.is_missing,
                            'is_excused', gcs.is_excused,
                            'is_droppable', gcs.is_droppable,
                            'released', gcs.released,
                            'score_override_note', gcs.score_override_note,
                            'is_recalculating', gcs.is_recalculating,
                            'incomplete_values', gcs.incomplete_values
                        ) ORDER BY gc.sort_order ASC NULLS LAST, gc.id ASC
                    )
                ) as student_data
            FROM public.gradebook_column_students gcs
            INNER JOIN public.gradebook_columns gc ON gc.id = gcs.gradebook_column_id
            WHERE gcs.class_id = p_class_id
            GROUP BY gcs.student_id
        ) grouped_data
    );
END;
$$;

-- Array variant: early RLS check, then array aggregation
CREATE OR REPLACE FUNCTION "public"."get_gradebook_records_for_all_students_array"("p_class_id" bigint)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
PARALLEL SAFE  
SECURITY DEFINER  
SET search_path TO pg_catalog,public
AS $$
BEGIN
    -- Early authorization guard - return immediately if unauthorized
    IF NOT public.authorizeforclassgrader(p_class_id) THEN
        RETURN '[]'::jsonb;
    END IF;
    
    -- Only execute heavy query if authorized
    RETURN (
        SELECT COALESCE(jsonb_agg(
            jsonb_build_object(
                'private_profile_id', student_id::text,
                'entries', entries_array
            ) ORDER BY student_id
        ), '[]'::jsonb)
        FROM (
            SELECT 
                gcs.student_id,
                jsonb_agg(
                    ARRAY[
                        gcs.id::text,
                        gcs.gradebook_column_id::text, 
                        gcs.is_private::text,
                        COALESCE(gcs.score::text, ''),
                        COALESCE(gcs.score_override::text, ''),
                        gcs.is_missing::text,
                        gcs.is_excused::text,
                        gcs.is_droppable::text,
                        gcs.released::text,
                        COALESCE(gcs.score_override_note, ''),
                        gcs.is_recalculating::text,
                        COALESCE(gcs.incomplete_values::text, '')
                    ] ORDER BY gc.sort_order ASC NULLS LAST, gc.id ASC
                ) as entries_array
            FROM public.gradebook_column_students gcs
            INNER JOIN public.gradebook_columns gc ON gc.id = gcs.gradebook_column_id
            WHERE gcs.class_id = p_class_id
            GROUP BY gcs.student_id
        ) array_data
    );
END;
$$;

-- Maintain ownership and permissions consistent with prior migrations
ALTER FUNCTION "public"."get_gradebook_records_for_all_students"("class_id" bigint) OWNER TO "postgres";
ALTER FUNCTION "public"."get_gradebook_records_for_all_students_array"("class_id" bigint) OWNER TO "postgres";

GRANT EXECUTE ON FUNCTION "public"."get_gradebook_records_for_all_students"("class_id" bigint) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."get_gradebook_records_for_all_students"("class_id" bigint) TO "service_role";
GRANT EXECUTE ON FUNCTION "public"."get_gradebook_records_for_all_students_array"("class_id" bigint) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."get_gradebook_records_for_all_students_array"("class_id" bigint) TO "service_role";

COMMENT ON FUNCTION "public"."get_gradebook_records_for_all_students"("class_id" bigint) IS 
'Ultra-high-performance function with early authorization guard; removes inline checks for faster execution on large datasets.';

COMMENT ON FUNCTION "public"."get_gradebook_records_for_all_students_array"("class_id" bigint) IS 
'Array-optimized variant with early authorization guard; avoids repeated RLS checks for maximum throughput.';
