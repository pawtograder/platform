-- When instructor_only is cleared on a column (typically when releasing a staff-only column),
-- enqueue recalculation for all student rows so public rows transition from frozen snapshot
-- to normal recalculation/sync behavior.

CREATE OR REPLACE FUNCTION public.recalculate_gradebook_column_for_all_students_statement() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
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
