-- Issue #520: Instructor-only gradebook columns (hidden from students until column is "released").
-- On release the application clears instructor_only, so the column becomes a normal visible column.

ALTER TABLE public.gradebook_columns
  ADD COLUMN IF NOT EXISTS instructor_only boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.gradebook_columns.instructor_only IS
  'When true, students cannot see the column or their cell rows until the column is released; after release they see a frozen copy of the staff (is_private=true) row. Public rows are not recalculated from the student dependency view for these columns.';

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
