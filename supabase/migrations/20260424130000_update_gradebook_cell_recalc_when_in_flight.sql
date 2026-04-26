-- Fix: update_gradebook_column_student_with_recalc was skipping the
-- dependent-recalc enqueue when the student's row was already
-- is_recalculating=true. That gating made user edits silently lose their
-- propagation to dependent calculated columns:
--
--   1. user edits cell A (e.g. Participation) while a previous
--      recalculation is still in flight for the same student row.
--   2. RPC writes the new value to gradebook_column_students but, seeing
--      is_recalculating=true, declines to enqueue another row recalc.
--   3. The in-flight worker is still running with the OLD cell value, so
--      its result reflects the old A, not the new A.
--   4. Worker finishes, sets is_recalculating=false. Nothing else is
--      dirty for this row, so no further recalc fires. Cell A's
--      dependents (e.g. Final Grade) stay stale until something else
--      touches the row.
--
-- Surfaced as a flake in the gradebook E2E ("Editing a manual column
-- updates the Participation cell value" — Final Grade observed at the
-- pre-edit value of 51.95 instead of the post-edit 51.5) but the bug is
-- production-visible: any rapid sequence of user edits on a row whose
-- recalc is in flight loses dependent updates.
--
-- The batch enqueue function (enqueue_gradebook_row_recalculation_batch)
-- already handles the in-flight case correctly: it allows re-enqueue
-- when is_recalculating=true and bumps the row-state version, which the
-- worker uses to detect stale results and re-run. Drop the wrapper RPC's
-- short-circuit and always call the batch enqueue when relevant fields
-- changed.

CREATE OR REPLACE FUNCTION public.update_gradebook_column_student_with_recalc(
  p_id bigint,
  p_updates jsonb
) RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
DECLARE
  updated_row public.gradebook_column_students%ROWTYPE;
  old_row public.gradebook_column_students%ROWTYPE;
BEGIN
  -- Get the old row values
  SELECT * INTO old_row FROM public.gradebook_column_students WHERE id = p_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'gradebook_column_students row with id % not found', p_id;
  END IF;

  -- Perform the UPDATE
  UPDATE public.gradebook_column_students
  SET
    score = CASE WHEN p_updates ? 'score' THEN (p_updates->>'score')::numeric ELSE score END,
    score_override = CASE WHEN p_updates ? 'score_override' THEN (p_updates->>'score_override')::numeric ELSE score_override END,
    is_missing = CASE WHEN p_updates ? 'is_missing' THEN (p_updates->>'is_missing')::boolean ELSE is_missing END,
    is_excused = CASE WHEN p_updates ? 'is_excused' THEN (p_updates->>'is_excused')::boolean ELSE is_excused END,
    is_droppable = CASE WHEN p_updates ? 'is_droppable' THEN (p_updates->>'is_droppable')::boolean ELSE is_droppable END,
    released = CASE WHEN p_updates ? 'released' THEN (p_updates->>'released')::boolean ELSE released END,
    score_override_note = CASE WHEN p_updates ? 'score_override_note' THEN (p_updates->>'score_override_note')::text ELSE score_override_note END,
    incomplete_values = CASE WHEN p_updates ? 'incomplete_values' THEN p_updates->'incomplete_values' ELSE incomplete_values END
  WHERE id = p_id
  RETURNING * INTO updated_row;

  -- Check if any relevant fields changed
  IF (
    updated_row.score IS DISTINCT FROM old_row.score OR
    updated_row.score_override IS DISTINCT FROM old_row.score_override OR
    updated_row.is_missing IS DISTINCT FROM old_row.is_missing OR
    updated_row.is_droppable IS DISTINCT FROM old_row.is_droppable OR
    updated_row.is_excused IS DISTINCT FROM old_row.is_excused
  ) THEN
    -- Always enqueue: batch enqueue's own gating allows re-enqueue when a
    -- recalc is in flight (it bumps the row-state version so the worker
    -- detects stale results and re-runs).  Skipping here causes user edits
    -- to lose dependent-column propagation (see migration header).
    PERFORM public.enqueue_gradebook_row_recalculation_batch(ARRAY[
      jsonb_build_object(
        'class_id', updated_row.class_id,
        'gradebook_id', updated_row.gradebook_id,
        'student_id', updated_row.student_id,
        'is_private', updated_row.is_private
      )
    ]);
  END IF;
END;
$$;

COMMENT ON FUNCTION public.update_gradebook_column_student_with_recalc(bigint, jsonb)
  IS 'Updates a single gradebook_column_students row and enqueues dependent recalculations. Always enqueues when relevant fields change; the batch enqueue handles the is_recalculating=true case via row-state version bumps.';
