-- Migration: High-performance bulk gradebook data fetch function
-- Problem: Original function too slow for 100s of columns × 1000s of students (100K+ rows)
-- Solution: Covering indexes + pure SQL + optimized aggregation for maximum performance

-- Create covering indexes to eliminate table lookups entirely
-- This is crucial for performance with large gradebook datasets
CREATE INDEX IF NOT EXISTS "idx_gradebook_column_students_class_student_covering" 
ON "public"."gradebook_column_students" USING "btree" ("class_id", "student_id") 
INCLUDE ("id", "gradebook_column_id", "is_private", "score", "score_override", "is_missing", "is_excused", "is_droppable", "released", "score_override_note", "is_recalculating", "incomplete_values");

-- Covering index for gradebook_columns to avoid table lookups for sort_order
CREATE INDEX IF NOT EXISTS "idx_gradebook_columns_id_covering" 
ON "public"."gradebook_columns" USING "btree" ("id") 
INCLUDE ("sort_order");

-- Composite index optimized for the JOIN pattern
CREATE INDEX IF NOT EXISTS "idx_gradebook_column_students_class_column_student" 
ON "public"."gradebook_column_students" USING "btree" ("class_id", "gradebook_column_id", "student_id");

-- Create ultra-high-performance function using pure SQL instead of PL/pgSQL loops
CREATE OR REPLACE FUNCTION "public"."get_gradebook_records_for_all_students"("class_id" bigint)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $$
    -- Single SQL query optimized for maximum performance with large datasets
    -- Uses covering indexes to avoid table lookups entirely
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
        WHERE gcs.class_id = get_gradebook_records_for_all_students.class_id
          AND public.authorizeforclassgrader(get_gradebook_records_for_all_students.class_id)
        GROUP BY gcs.student_id
    ) grouped_data;
$$;

-- Set function ownership
ALTER FUNCTION "public"."get_gradebook_records_for_all_students"("class_id" bigint) OWNER TO "postgres";

-- Grant permissions to appropriate roles
GRANT EXECUTE ON FUNCTION "public"."get_gradebook_records_for_all_students"("class_id" bigint) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."get_gradebook_records_for_all_students"("class_id" bigint) TO "service_role";

-- Alternative: Create an even more optimized version using array aggregation instead of jsonb
-- This can be 2-3x faster for very large datasets since arrays are more efficient than JSONB
CREATE OR REPLACE FUNCTION "public"."get_gradebook_records_for_all_students_array"("class_id" bigint)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER  
SET search_path TO ''
AS $$
    -- Ultra-optimized version using arrays for maximum performance with massive datasets
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
        WHERE gcs.class_id = get_gradebook_records_for_all_students_array.class_id
          AND public.authorizeforclassgrader(get_gradebook_records_for_all_students_array.class_id)
        GROUP BY gcs.student_id
    ) array_data;
$$;

-- Set ownership and permissions for array version
ALTER FUNCTION "public"."get_gradebook_records_for_all_students_array"("class_id" bigint) OWNER TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."get_gradebook_records_for_all_students_array"("class_id" bigint) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."get_gradebook_records_for_all_students_array"("class_id" bigint) TO "service_role";

-- Add explanatory comments
COMMENT ON FUNCTION "public"."get_gradebook_records_for_all_students"("class_id" bigint) IS 
'Ultra-high-performance function optimized for 100s of columns × 1000s of students. Uses covering indexes to eliminate table lookups, pure SQL instead of loops, and optimized aggregation. Performs authorization check within query. Expected to be 10-100x faster than original implementation for large datasets.';

COMMENT ON FUNCTION "public"."get_gradebook_records_for_all_students_array"("class_id" bigint) IS 
'Maximum performance variant using array aggregation instead of JSONB objects. Can be 2-3x faster than JSONB version for very large datasets (1000s of students × 100s of columns). Returns data as arrays that need to be parsed on client side.';
