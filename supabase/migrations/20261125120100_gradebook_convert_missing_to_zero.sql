-- "Convert Missing to 0" as one statement, so a grade entered while the dialog is open is never
-- overwritten.
--
-- The dialog used to select the missing cells and then write each one through
-- update_gradebook_column_student_with_recalc, which applies its updates unconditionally. A grade
-- saved between the select and the write was replaced by 0. Here the missing test is the UPDATE's
-- own WHERE clause: under READ COMMITTED, Postgres re-checks it against the latest version of each
-- row it had to wait for, so a cell that stopped being missing is skipped and one that is still
-- missing is converted.
--
-- An assignment-backed column is recomputed from submissions on every recalculation, so its
-- converted 0 is a score_override (which the recalculation keeps and dependents read). A manual
-- column is never recomputed, so its score is set. Every converted row is queued for recalculation
-- so averages and topic standings that read the column pick up the 0.

CREATE OR REPLACE FUNCTION public.convert_gradebook_column_missing_to_zero(p_column_id bigint)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_class_id bigint;
  v_is_calculated boolean;
  v_rows jsonb[];
BEGIN
  SELECT gc.class_id, gc.score_expression IS NOT NULL
  INTO v_class_id, v_is_calculated
  FROM public.gradebook_columns gc
  WHERE gc.id = p_column_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'gradebook_columns row with id % not found', p_column_id;
  END IF;

  IF auth.role() IS DISTINCT FROM 'service_role'
     AND v_class_id NOT IN (SELECT public.user_class_ids_with_capability('manage_gradebook')) THEN
    RAISE EXCEPTION 'Access denied: manage_gradebook required for class %', v_class_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  WITH converted AS (
    UPDATE public.gradebook_column_students gcs
    SET
      score = CASE WHEN v_is_calculated THEN gcs.score ELSE 0 END,
      score_override = CASE WHEN v_is_calculated THEN 0 ELSE gcs.score_override END,
      is_missing = false,
      score_override_note = 'Missing value converted to 0'
    WHERE gcs.gradebook_column_id = p_column_id
      AND gcs.is_private = true
      AND (gcs.is_missing = true OR (gcs.score IS NULL AND gcs.score_override IS NULL))
    RETURNING gcs.class_id, gcs.gradebook_id, gcs.student_id, gcs.is_private
  )
  SELECT array_agg(DISTINCT jsonb_build_object(
    'class_id', c.class_id,
    'gradebook_id', c.gradebook_id,
    'student_id', c.student_id,
    'is_private', c.is_private
  ))
  INTO v_rows
  FROM converted c;

  IF v_rows IS NULL THEN
    RETURN 0;
  END IF;

  PERFORM public.enqueue_gradebook_row_recalculation_batch(v_rows);
  RETURN cardinality(v_rows);
END;
$function$;

REVOKE ALL ON FUNCTION public.convert_gradebook_column_missing_to_zero(p_column_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convert_gradebook_column_missing_to_zero(p_column_id bigint) TO authenticated, service_role;

COMMENT ON FUNCTION public.convert_gradebook_column_missing_to_zero(bigint) IS
  'Converts a column''s missing private cells to 0 (an override for calculated columns) and queues their rows for recalculation. Needs manage_gradebook. Returns the number of rows converted.';
