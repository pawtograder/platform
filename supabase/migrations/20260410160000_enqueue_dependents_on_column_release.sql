-- Fix: when a gradebook column is released (or unreleased), enqueue recalculation
-- for all columns that depend on it.
--
-- Background: the auto-dependent trigger on gradebook_column_students was removed
-- in 20251102 (reduce-rt-spam) and replaced with explicit RPC calls. However, the
-- column-release path (update_gradebook_column_students_released → sync_private →
-- public row scores change) bypasses those RPCs, so dependent calculated columns
-- never get enqueued for recalculation when a source column is released.
--
-- This caused a production incident on 2026-04-10 where releasing column 1377
-- left dependent column 1378's student-visible scores stale for ~3 hours until
-- a manual bulk recalc was triggered.

CREATE OR REPLACE FUNCTION public.update_gradebook_column_students_released()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
  rows_to_enqueue jsonb[];
BEGIN
  -- Propagate released status to private cells (existing behavior)
  UPDATE public.gradebook_column_students gcs
  SET released = NEW.released
  WHERE gradebook_column_id = NEW.id
    AND is_private = true
    AND released <> NEW.released;

  -- When released status changes, enqueue recalculation for all dependent
  -- columns' public student rows. Uses source='deps_update' to bypass the
  -- dirty-skip gating (the student may already be dirty from the column's
  -- own recalc, but dependents still need a fresh pass with the new scores).
  IF NEW.released IS DISTINCT FROM OLD.released THEN
    WITH dep_rows AS (
      SELECT DISTINCT gcs.class_id, gcs.gradebook_id, gcs.student_id
      FROM public.gradebook_columns gc
      JOIN public.gradebook_column_students gcs
        ON gcs.gradebook_column_id = gc.id
        AND gcs.is_private = false
      WHERE gc.dependencies->'gradebook_columns' @> to_jsonb(ARRAY[NEW.id]::bigint[])
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
  END IF;

  RETURN NEW;
END;
$$;
