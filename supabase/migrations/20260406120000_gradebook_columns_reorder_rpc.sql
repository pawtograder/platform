-- Bulk reorder gradebook columns (sets contiguous sort_order 0..n-1).
-- SECURITY DEFINER with instructor check (same pattern as gradebook_auto_layout).

CREATE OR REPLACE FUNCTION public.gradebook_columns_reorder(p_ordered_column_ids bigint[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_gradebook_id bigint;
  v_class_id bigint;
  v_expected_count integer;
  v_payload_count integer;
  v_distinct_payload integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_payload_count := COALESCE(array_length(p_ordered_column_ids, 1), 0);

  IF v_payload_count = 0 THEN
    RETURN;
  END IF;

  SELECT COUNT(DISTINCT x) INTO v_distinct_payload
  FROM unnest(p_ordered_column_ids) AS x;

  IF v_distinct_payload <> v_payload_count THEN
    RAISE EXCEPTION 'Duplicate column IDs in reorder payload';
  END IF;

  SELECT gc.gradebook_id INTO v_gradebook_id
  FROM public.gradebook_columns AS gc
  WHERE gc.id = p_ordered_column_ids[1];

  IF v_gradebook_id IS NULL THEN
    RAISE EXCEPTION 'gradebook column % not found', p_ordered_column_ids[1];
  END IF;

  SELECT class_id INTO v_class_id
  FROM public.gradebooks
  WHERE id = v_gradebook_id;

  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'gradebook % not found', v_gradebook_id;
  END IF;

  IF NOT public.authorizeforclassinstructor(v_class_id) THEN
    RAISE EXCEPTION 'insufficient permissions: instructor access required for class %', v_class_id;
  END IF;

  SELECT COUNT(*)::integer INTO v_expected_count
  FROM public.gradebook_columns
  WHERE gradebook_id = v_gradebook_id;

  IF v_expected_count <> v_payload_count THEN
    RAISE EXCEPTION 'Payload count (%) does not match gradebook column count (%)', v_payload_count, v_expected_count;
  END IF;

  IF (
    SELECT COUNT(*)::integer
    FROM public.gradebook_columns
    WHERE gradebook_id = v_gradebook_id
      AND id = ANY (p_ordered_column_ids)
  ) <> v_payload_count THEN
    RAISE EXCEPTION 'One or more column IDs do not belong to this gradebook';
  END IF;

  -- Single-key form (bigint); the two-key form requires (integer, integer), not (int, bigint).
  -- Same namespace as gradebook_column_move_left/right — serializes all column-order updates per gradebook.
  PERFORM pg_advisory_xact_lock(v_gradebook_id);
  PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_gradebook_id::text, 'true', true);

  BEGIN
    UPDATE public.gradebook_columns AS gc
    SET sort_order = ord.new_order
    FROM (
      SELECT id, (ordinality - 1)::integer AS new_order
      FROM unnest(p_ordered_column_ids) WITH ORDINALITY AS t(id, ordinality)
    ) AS ord
    WHERE gc.id = ord.id
      AND gc.gradebook_id = v_gradebook_id;
  EXCEPTION
    WHEN OTHERS THEN
      PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_gradebook_id::text, 'false', true);
      RAISE;
  END;

  PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_gradebook_id::text, 'false', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.gradebook_columns_reorder(bigint[]) TO "anon", "authenticated", "service_role";

-- Extend get_gradebook_records_for_all_students payload with per-entry updated_at so the client
-- can set an incremental-fetch watermark consistent with the SSR seed (see GradebookCellController).

CREATE OR REPLACE FUNCTION "public"."get_gradebook_records_for_all_students"("p_class_id" bigint)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path TO pg_catalog,public
AS $$
BEGIN
    IF NOT public.authorizeforclassgrader(p_class_id) THEN
        RETURN '[]'::jsonb;
    END IF;

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
                            'incomplete_values', gcs.incomplete_values,
                            'updated_at', to_jsonb(gcs.updated_at)
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
