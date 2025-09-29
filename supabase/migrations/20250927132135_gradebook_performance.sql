-- Migration: Gradebook performance improvements (hoist RLS check, remove inline checks)
-- Goal: Perform a single early authorization check, then run pure SQL without repeated checks

-- get_gradebook_records_for_all_students: early RLS check, then fast aggregation
CREATE OR REPLACE FUNCTION "public"."get_gradebook_records_for_all_students"("class_id" bigint)
RETURNS jsonb
LANGUAGE sql
STABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path TO ''
AS $$
    -- Early authorization guard
    SELECT (
      CASE WHEN public.authorizeforclassgrader(get_gradebook_records_for_all_students.class_id)
      THEN (
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
            GROUP BY gcs.student_id
        ) grouped_data
      )
      ELSE (SELECT '[]'::jsonb)
      END
    );
$$;

-- Array variant: early RLS check, then array aggregation
CREATE OR REPLACE FUNCTION "public"."get_gradebook_records_for_all_students_array"("class_id" bigint)
RETURNS jsonb
LANGUAGE sql
STABLE
PARALLEL SAFE  
SECURITY DEFINER  
SET search_path TO ''
AS $$
    -- Early authorization guard
    SELECT (
      CASE WHEN public.authorizeforclassgrader(get_gradebook_records_for_all_students_array.class_id)
      THEN (
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
            GROUP BY gcs.student_id
        ) array_data
      )
      ELSE (SELECT '[]'::jsonb)
      END
    );
$$;

-- Maintain ownership and permissions consistent with prior migrations
ALTER FUNCTION "public"."get_gradebook_records_for_all_students"("class_id" bigint) OWNER TO "postgres";
ALTER FUNCTION "public"."get_gradebook_records_for_all_students_array"("class_id" bigint) OWNER TO "postgres";

GRANT EXECUTE ON FUNCTION "public"."get_gradebook_records_for_all_students"("class_id" bigint) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."get_gradebook_records_for_all_students"("class_id" bigint) TO "service_role";
GRANT EXECUTE ON FUNCTION "public"."get_gradebook_records_for_all_students"("class_id" bigint) TO "anon";
GRANT EXECUTE ON FUNCTION "public"."get_gradebook_records_for_all_students_array"("class_id" bigint) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."get_gradebook_records_for_all_students_array"("class_id" bigint) TO "service_role";
GRANT EXECUTE ON FUNCTION "public"."get_gradebook_records_for_all_students_array"("class_id" bigint) TO "anon";

COMMENT ON FUNCTION "public"."get_gradebook_records_for_all_students"("class_id" bigint) IS 
'Ultra-high-performance function with early authorization guard; removes inline checks for faster execution on large datasets.';

COMMENT ON FUNCTION "public"."get_gradebook_records_for_all_students_array"("class_id" bigint) IS 
'Array-optimized variant with early authorization guard; avoids repeated RLS checks for maximum throughput.';

-- Streaming variants (set-returning) with keyset pagination
-- Returns one row per student to enable incremental fetching on the client
CREATE OR REPLACE FUNCTION "public"."get_gradebook_records_for_all_students_stream"(
  "class_id" bigint,
  "after_student_id" uuid DEFAULT NULL,
  "limit_rows" integer DEFAULT 300
)
RETURNS TABLE("private_profile_id" text, "entries" jsonb)
LANGUAGE sql
STABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path TO ''
AS $$
  IF NOT public.authorizeforclassgrader(get_gradebook_records_for_all_students_stream.class_id) THEN
    RETURN;
 END IF;

  WITH ids AS (
    SELECT DISTINCT gcs.student_id
    FROM public.gradebook_column_students gcs
    WHERE gcs.class_id = get_gradebook_records_for_all_students_stream.class_id
      AND (get_gradebook_records_for_all_students_stream.after_student_id IS NULL OR gcs.student_id > get_gradebook_records_for_all_students_stream.after_student_id)
    ORDER BY gcs.student_id
    LIMIT GREATEST(get_gradebook_records_for_all_students_stream.limit_rows, 1)
  )
  SELECT 
    ids.student_id::text AS private_profile_id,
    jsonb_agg(
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
    ) AS entries
  FROM ids
  JOIN public.gradebook_column_students gcs
    ON gcs.class_id = get_gradebook_records_for_all_students_stream.class_id
   AND gcs.student_id = ids.student_id
  JOIN public.gradebook_columns gc ON gc.id = gcs.gradebook_column_id
  GROUP BY ids.student_id
  ORDER BY ids.student_id;
$$;

CREATE OR REPLACE FUNCTION "public"."get_gradebook_records_for_all_students_array_stream"(
  "class_id" bigint,
  "after_student_id" uuid DEFAULT NULL,
  "limit_rows" integer DEFAULT 1000
)
RETURNS TABLE("private_profile_id" text, "entries" jsonb)
LANGUAGE sql
STABLE
PARALLEL SAFE
SECURITY DEFINER  
SET search_path TO ''
AS $$
  IF NOT public.authorizeforclassgrader(get_gradebook_records_for_all_students_array_stream.class_id) THEN
    RETURN;
 END IF;

  WITH ids AS (
    SELECT DISTINCT gcs.student_id
    FROM public.gradebook_column_students gcs
    WHERE gcs.class_id = get_gradebook_records_for_all_students_array_stream.class_id
      AND (get_gradebook_records_for_all_students_array_stream.after_student_id IS NULL OR gcs.student_id > get_gradebook_records_for_all_students_array_stream.after_student_id)
    ORDER BY gcs.student_id
    LIMIT GREATEST(get_gradebook_records_for_all_students_array_stream.limit_rows, 1)
  )
  SELECT 
    ids.student_id::text AS private_profile_id,
    jsonb_agg(
      jsonb_build_array(
        gcs.id,
        gcs.gradebook_column_id, 
        gcs.is_private,
        gcs.score,
        gcs.score_override,
        gcs.is_missing,
        gcs.is_excused,
        gcs.is_droppable,
        gcs.released,
        gcs.score_override_note,
        gcs.is_recalculating,
        gcs.incomplete_values
      ) ORDER BY gc.sort_order ASC NULLS LAST, gc.id ASC
    ) AS entries
  FROM ids
  JOIN public.gradebook_column_students gcs
    ON gcs.class_id = get_gradebook_records_for_all_students_array_stream.class_id
   AND gcs.student_id = ids.student_id
  JOIN public.gradebook_columns gc ON gc.id = gcs.gradebook_column_id
  GROUP BY ids.student_id
  ORDER BY ids.student_id;
$$;

ALTER FUNCTION "public"."get_gradebook_records_for_all_students_stream"("class_id" bigint, "after_student_id" uuid, "limit_rows" integer) OWNER TO "postgres";
ALTER FUNCTION "public"."get_gradebook_records_for_all_students_array_stream"("class_id" bigint, "after_student_id" uuid, "limit_rows" integer) OWNER TO "postgres";

GRANT EXECUTE ON FUNCTION "public"."get_gradebook_records_for_all_students_stream"("class_id" bigint, "after_student_id" uuid, "limit_rows" integer) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."get_gradebook_records_for_all_students_stream"("class_id" bigint, "after_student_id" uuid, "limit_rows" integer) TO "service_role";
GRANT EXECUTE ON FUNCTION "public"."get_gradebook_records_for_all_students_stream"("class_id" bigint, "after_student_id" uuid, "limit_rows" integer) TO "anon";
GRANT EXECUTE ON FUNCTION "public"."get_gradebook_records_for_all_students_array_stream"("class_id" bigint, "after_student_id" uuid, "limit_rows" integer) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."get_gradebook_records_for_all_students_array_stream"("class_id" bigint, "after_student_id" uuid, "limit_rows" integer) TO "service_role";
GRANT EXECUTE ON FUNCTION "public"."get_gradebook_records_for_all_students_array_stream"("class_id" bigint, "after_student_id" uuid, "limit_rows" integer) TO "anon";

COMMENT ON FUNCTION "public"."get_gradebook_records_for_all_students_stream"("class_id" bigint, "after_student_id" uuid, "limit_rows" integer) IS 
'Streaming per-student gradebook rows with keyset pagination and early authorization guard.';

COMMENT ON FUNCTION "public"."get_gradebook_records_for_all_students_array_stream"("class_id" bigint, "after_student_id" uuid, "limit_rows" integer) IS 
'Array-optimized streaming variant returning one row per student with keyset pagination and early authorization guard.';
