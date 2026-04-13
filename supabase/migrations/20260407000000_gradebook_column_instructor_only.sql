-- Issue #520: Instructor-only gradebook columns (hidden from students until column is "released").
-- Includes: RLS, sync triggers for release/unrelease, recalculation when instructor_only is cleared,
-- and release_instructor_only_gradebook_column RPC for atomic release + flag clear.

ALTER TABLE public.gradebook_columns
  ADD COLUMN IF NOT EXISTS instructor_only boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.gradebook_columns.instructor_only IS
  'When true, students cannot see the column or their cell rows. On release, the application clears this flag and the column becomes a normal visible column with standard recalculation and sync behavior.';

-- Students see normal columns always; staff-only columns only after the column is released (metadata + cells).
ALTER POLICY "everyone in class can view"
ON public.gradebook_columns
USING (
  EXISTS (
    SELECT 1
    FROM public.user_privileges up
    WHERE up.user_id = auth.uid()
      AND up.class_id = gradebook_columns.class_id
  )
  AND (
    EXISTS (
      SELECT 1
      FROM public.user_privileges up2
      WHERE up2.user_id = auth.uid()
        AND up2.class_id = gradebook_columns.class_id
        AND up2.role IN ('instructor', 'grader')
    )
    OR COALESCE(gradebook_columns.instructor_only, false) = false
    OR gradebook_columns.released = true
  )
);

-- Students may read their public cell row when the column is visible (not staff-only, or staff-only and released).
ALTER POLICY "student views non-private only"
ON public.gradebook_column_students
USING (
  EXISTS (
    SELECT 1
    FROM public.user_privileges up
    WHERE up.user_id = auth.uid()
      AND (up.public_profile_id = student_id OR up.private_profile_id = student_id)
  )
  AND is_private = false
  AND EXISTS (
    SELECT 1
    FROM public.gradebook_columns gc
    WHERE gc.id = gradebook_column_students.gradebook_column_id
      AND (
        COALESCE(gc.instructor_only, false) = false
        OR gc.released = true
      )
  )
);

-- Manual columns: sync private <-> public only when not instructor-only (existing behavior),
-- plus release/unrelease for instructor-only (mirror instructor row to frozen student view).
CREATE OR REPLACE FUNCTION public.sync_private_gradebook_column_student()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM new_table
    INNER JOIN old_table ON new_table.id = old_table.id
    INNER JOIN public.gradebook_columns gc ON gc.id = new_table.gradebook_column_id
    WHERE new_table.is_private = true
      AND new_table.released IS DISTINCT FROM old_table.released
      AND gc.score_expression IS NULL
      AND COALESCE(gc.instructor_only, false) = false
  )
  AND NOT EXISTS (
    SELECT 1
    FROM new_table
    INNER JOIN old_table ON new_table.id = old_table.id
    INNER JOIN public.gradebook_columns gc ON gc.id = new_table.gradebook_column_id
    WHERE new_table.is_private = true
      AND new_table.released IS DISTINCT FROM old_table.released
      AND COALESCE(gc.instructor_only, false) = true
  ) THEN
    RETURN NULL;
  END IF;

  UPDATE public.gradebook_column_students AS gcs
  SET
    score = CASE
      WHEN new_table.score_override IS NOT NULL THEN new_table.score_override
      ELSE new_table.score
    END,
    is_missing = new_table.is_missing,
    is_droppable = new_table.is_droppable,
    is_excused = new_table.is_excused,
    released = true
  FROM new_table
  INNER JOIN old_table ON new_table.id = old_table.id
  INNER JOIN public.gradebook_columns gc ON gc.id = new_table.gradebook_column_id
  WHERE gcs.gradebook_column_id = new_table.gradebook_column_id
    AND gcs.student_id = new_table.student_id
    AND gcs.is_private = false
    AND new_table.is_private = true
    AND new_table.released = true
    AND old_table.released = false
    AND old_table.is_recalculating = false
    AND new_table.is_recalculating = false
    AND gcs.released = false
    AND (
      (gc.score_expression IS NULL AND COALESCE(gc.instructor_only, false) = false)
      OR COALESCE(gc.instructor_only, false) = true
    );

  UPDATE public.gradebook_column_students AS gcs
  SET
    score = NULL,
    is_missing = false,
    is_droppable = false,
    is_excused = false,
    released = false
  FROM new_table
  INNER JOIN old_table ON new_table.id = old_table.id
  INNER JOIN public.gradebook_columns gc ON gc.id = new_table.gradebook_column_id
  WHERE gcs.gradebook_column_id = new_table.gradebook_column_id
    AND gcs.student_id = new_table.student_id
    AND gcs.is_private = false
    AND new_table.is_private = true
    AND new_table.released = false
    AND old_table.released = true
    AND old_table.is_recalculating = false
    AND new_table.is_recalculating = false
    AND gcs.released = true
    AND (
      (gc.score_expression IS NULL AND COALESCE(gc.instructor_only, false) = false)
      OR COALESCE(gc.instructor_only, false) = true
    );

  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_private_gradebook_column_student_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM new_table
    INNER JOIN old_table ON new_table.id = old_table.id
    INNER JOIN public.gradebook_columns gc ON gc.id = new_table.gradebook_column_id
    WHERE new_table.is_private = true
      AND new_table.released = true
      AND gc.score_expression IS NULL
      AND COALESCE(gc.instructor_only, false) = false
      AND (
        new_table.score IS DISTINCT FROM old_table.score
        OR new_table.score_override IS DISTINCT FROM old_table.score_override
        OR new_table.is_missing IS DISTINCT FROM old_table.is_missing
        OR new_table.is_droppable IS DISTINCT FROM old_table.is_droppable
        OR new_table.is_excused IS DISTINCT FROM old_table.is_excused
      )
  ) THEN
    RETURN NULL;
  END IF;

  UPDATE public.gradebook_column_students AS gcs
  SET
    score = CASE
      WHEN new_table.score_override IS NOT NULL THEN new_table.score_override
      ELSE new_table.score
    END,
    is_missing = new_table.is_missing,
    is_droppable = new_table.is_droppable,
    is_excused = new_table.is_excused
  FROM new_table
  INNER JOIN old_table ON new_table.id = old_table.id
  INNER JOIN public.gradebook_columns gc ON gc.id = new_table.gradebook_column_id
  WHERE gcs.gradebook_column_id = new_table.gradebook_column_id
    AND gcs.student_id = new_table.student_id
    AND gcs.is_private = false
    AND new_table.is_private = true
    AND new_table.released = true
    AND old_table.is_recalculating = false
    AND new_table.is_recalculating = false
    AND gc.score_expression IS NULL
    AND COALESCE(gc.instructor_only, false) = false;

  RETURN NULL;
END;
$function$;

-- Calculated columns: legacy sync on score_override for normal columns only.
-- Instructor-only calculated columns get a one-time copy to the public row when the private row
-- is released (see sync_private_gradebook_column_student); the public row is not updated again.
CREATE OR REPLACE FUNCTION public.sync_private_gradebook_column_student_fields_for_calculated_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM new_table
    INNER JOIN old_table ON new_table.id = old_table.id
    INNER JOIN public.gradebook_columns gc ON gc.id = new_table.gradebook_column_id
    WHERE new_table.is_private = true
      AND gc.score_expression IS NOT NULL
      AND COALESCE(gc.instructor_only, false) = false
      AND new_table.score_override IS DISTINCT FROM old_table.score_override
  ) THEN
    RETURN NULL;
  END IF;

  UPDATE public.gradebook_column_students AS gcs
  SET
    score_override = new_table.score_override,
    is_missing = new_table.is_missing,
    is_droppable = new_table.is_droppable,
    is_excused = new_table.is_excused
  FROM new_table
  INNER JOIN old_table ON new_table.id = old_table.id
  INNER JOIN public.gradebook_columns gc ON gc.id = new_table.gradebook_column_id
  WHERE gcs.gradebook_column_id = new_table.gradebook_column_id
    AND gcs.student_id = new_table.student_id
    AND gcs.is_private = false
    AND new_table.is_private = true
    AND old_table.is_recalculating = false
    AND new_table.is_recalculating = false
    AND gc.score_expression IS NOT NULL
    AND COALESCE(gc.instructor_only, false) = false
    AND new_table.score_override IS DISTINCT FROM old_table.score_override;

  RETURN NULL;
END;
$function$;

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
