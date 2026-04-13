-- When instructor_only is cleared on a column (typically when releasing a staff-only column),
-- enqueue recalculation for all student rows so public rows transition from frozen snapshot
-- to normal recalculation/sync behavior.

CREATE OR REPLACE FUNCTION public.recalculate_gradebook_column_for_all_students_statement() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
DECLARE
  rows_to_enqueue jsonb[];
  row_rec RECORD;
BEGIN
  rows_to_enqueue := ARRAY[]::jsonb[];

  FOR row_rec IN (
    SELECT DISTINCT gcs.class_id, gcs.gradebook_id, gcs.student_id, gcs.is_private
    FROM new_table n
    JOIN old_table o ON n.id = o.id
    JOIN public.gradebook_column_students gcs ON gcs.gradebook_column_id = n.id
    WHERE n.score_expression IS DISTINCT FROM o.score_expression
       OR n.instructor_only IS DISTINCT FROM o.instructor_only
  ) LOOP
    rows_to_enqueue := array_append(rows_to_enqueue,
      jsonb_build_object(
        'class_id', row_rec.class_id,
        'gradebook_id', row_rec.gradebook_id,
        'student_id', row_rec.student_id,
        'is_private', row_rec.is_private
      )
    );
  END LOOP;

  IF array_length(rows_to_enqueue, 1) > 0 THEN
    PERFORM public.enqueue_gradebook_row_recalculation_batch(rows_to_enqueue);
  END IF;

  RETURN NULL;
END;
$$;

-- Update column comment to reflect the new release-clears-flag behavior.
COMMENT ON COLUMN public.gradebook_columns.instructor_only IS
  'When true, students cannot see the column or their cell rows. On release, the application clears this flag and the column becomes a normal visible column with standard recalculation and sync behavior.';

-- Atomic release for instructor-only columns: sets released=true then clears instructor_only
-- in a single transaction to prevent partial state.
CREATE OR REPLACE FUNCTION public.release_instructor_only_gradebook_column(p_column_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_class_id bigint;
BEGIN
  SELECT class_id INTO v_class_id
  FROM public.gradebook_columns
  WHERE id = p_column_id;

  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'Column % does not exist', p_column_id;
  END IF;

  IF NOT public.authorizeforclassgrader(v_class_id) THEN
    RAISE EXCEPTION 'Access denied: insufficient permissions for class %', v_class_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Step 1: Release while still instructor_only — triggers snapshot sync
  UPDATE public.gradebook_columns
  SET released = true
  WHERE id = p_column_id AND instructor_only = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Column % is not an instructor-only column or does not exist', p_column_id;
  END IF;

  -- Step 2: Clear instructor_only — column now behaves normally; triggers recalc
  UPDATE public.gradebook_columns
  SET instructor_only = false
  WHERE id = p_column_id;
END;
$$;
