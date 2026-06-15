-- Per-section / per-student release for normal (manual/imported) gradebook columns.
--
-- Background: release has historically been column-level. Setting
-- gradebook_columns.released flips EVERY private gradebook_column_students row
-- via update_gradebook_column_students_released(), and the per-row statement
-- trigger sync_private_gradebook_column_student() then syncs/clears each matching
-- public (is_private = false) row. Because that sync trigger already keys on
-- gcs.student_id = new_table.student_id, writing `released` on a SUBSET of private
-- rows correctly syncs only those students' public rows. This RPC exposes that
-- subset write so instructors can release/unrelease the currently-visible
-- (e.g. section-filtered) students without touching the whole class.
--
-- Scope guard: this only applies to NORMAL columns (no score_expression and not
-- instructor_only). Calculated columns derive their release from dependencies, and
-- instructor-only columns use the permanent atomic release_instructor_only_gradebook_column.
--
-- The column-level gradebook_columns.released is intentionally left untouched: a
-- partially-released column simply reads as "mixed" in the UI (derived from the
-- student rows). Mutating it here would re-trigger the column-wide clobber.

CREATE OR REPLACE FUNCTION public.set_gradebook_column_students_released(
  p_column_id bigint,
  p_student_ids jsonb,
  p_released boolean
) RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
DECLARE
  v_class_id bigint;
  v_score_expression text;
  v_instructor_only boolean;
  v_student_ids uuid[];
  v_invalid text[];
  v_element text;
  rows_to_enqueue jsonb[];
BEGIN
  -- Validate p_student_ids is a JSONB array of UUIDs (mirrors get_gradebook_column_students_bulk)
  IF jsonb_typeof(p_student_ids) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'p_student_ids must be a JSONB array, got type: %', jsonb_typeof(p_student_ids)
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_invalid := ARRAY[]::text[];
  FOR v_element IN SELECT jsonb_array_elements_text(p_student_ids) LOOP
    BEGIN
      PERFORM v_element::uuid;
    EXCEPTION WHEN OTHERS THEN
      v_invalid := array_append(v_invalid, v_element);
    END;
  END LOOP;
  IF array_length(v_invalid, 1) > 0 THEN
    RAISE EXCEPTION 'Invalid UUID values in p_student_ids: %', array_to_string(v_invalid, ', ')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT class_id, score_expression, COALESCE(instructor_only, false)
    INTO v_class_id, v_score_expression, v_instructor_only
  FROM public.gradebook_columns
  WHERE id = p_column_id;

  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'Column % does not exist', p_column_id;
  END IF;

  IF NOT public.authorizeforclassgrader(v_class_id) THEN
    RAISE EXCEPTION 'Access denied: insufficient permissions for class %', v_class_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Scope guard: only normal columns support per-student release.
  IF v_score_expression IS NOT NULL OR v_instructor_only THEN
    RAISE EXCEPTION 'Per-student release is only supported for normal columns (no score expression, not instructor-only). Column % does not qualify.', p_column_id
      USING ERRCODE = 'feature_not_supported';
  END IF;

  SELECT array_agg(DISTINCT e::uuid)
    INTO v_student_ids
  FROM jsonb_array_elements_text(p_student_ids) AS e;

  IF v_student_ids IS NULL OR array_length(v_student_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  -- Flip released on the PRIVATE rows for the requested students. The per-row
  -- sync_private_gradebook_column_student() statement trigger fires from this UPDATE
  -- and syncs (released = true) or clears (released = false) the matching public rows.
  UPDATE public.gradebook_column_students gcs
  SET released = p_released
  WHERE gcs.gradebook_column_id = p_column_id
    AND gcs.is_private = true
    AND gcs.student_id = ANY(v_student_ids)
    AND gcs.released IS DISTINCT FROM p_released;

  -- Enqueue recalculation for columns that depend on this one, scoped to the affected
  -- students' public rows (mirrors 20260410160000_enqueue_dependents_on_column_release).
  WITH dep_rows AS (
    SELECT DISTINCT gcs.class_id, gcs.gradebook_id, gcs.student_id
    FROM public.gradebook_columns gc
    JOIN public.gradebook_column_students gcs
      ON gcs.gradebook_column_id = gc.id
      AND gcs.is_private = false
    WHERE gc.dependencies->'gradebook_columns' @> to_jsonb(ARRAY[p_column_id]::bigint[])
      AND gcs.student_id = ANY(v_student_ids)
  )
  SELECT array_agg(
    jsonb_build_object(
      'class_id', class_id,
      'gradebook_id', gradebook_id,
      'student_id', student_id,
      'is_private', false,
      'source', 'deps_update'
    )
  )
  INTO rows_to_enqueue
  FROM dep_rows;

  IF rows_to_enqueue IS NOT NULL AND array_length(rows_to_enqueue, 1) > 0 THEN
    PERFORM public.enqueue_gradebook_row_recalculation_batch(rows_to_enqueue);
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_gradebook_column_students_released(bigint, jsonb, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_gradebook_column_students_released(bigint, jsonb, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_gradebook_column_students_released(bigint, jsonb, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_gradebook_column_students_released(bigint, jsonb, boolean) TO service_role;

COMMENT ON FUNCTION public.set_gradebook_column_students_released(bigint, jsonb, boolean) IS
'Release or unrelease a normal (no score_expression, not instructor_only) gradebook column for a SUBSET of students (e.g. a section-filtered view). Writes released on the private rows; the existing per-row sync trigger propagates to the public rows. Enqueues dependent-column recalculation for the affected students. The column-level released flag is intentionally not mutated.';
