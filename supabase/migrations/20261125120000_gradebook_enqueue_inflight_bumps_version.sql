-- A grade change on a row that is already queued or being recalculated now bumps the row's
-- version, as enqueue_gradebook_row_recalculation_batch already does.
--
-- The single-row enqueue's in-flight branch (is_recalculating = true) sent another queue message
-- and returned, leaving `version` and `dirty` untouched. A worker pass that had read its inputs
-- before the change therefore still matched `expected_version` in update_gradebook_rows_batch,
-- committed scores computed from the old inputs, and cleared `dirty`. The extra message repaired
-- the row on a later pass, but until then the row reported itself up to date while showing a
-- stale calculated score (a gradebook average, a topic standing). Bumping the version makes that
-- pass lose its version check, so version-mismatch recovery recalculates the row again.
--
-- Callers of this function are the submission and review triggers; the gradebook UI's own writes
-- go through update_gradebook_column_student(s)_with_recalc, which use the batch enqueue.
--
-- No later migration redefines this function (last body: 20260327000000_fix_gradebook_noop_updates;
-- 20261015120000_lock_down_security_definer_functions only changes grants, which CREATE OR REPLACE
-- keeps).

CREATE OR REPLACE FUNCTION public.enqueue_gradebook_row_recalculation(
  p_class_id bigint,
  p_gradebook_id bigint,
  p_student_id uuid,
  p_is_private boolean,
  p_reason text DEFAULT NULL,
  p_trigger_id bigint DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  row_message jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      p_class_id::text || ':' || p_gradebook_id::text || ':' || p_student_id::text || ':' || p_is_private::text,
      42
    )::bigint
  );

  -- Already queued or mid-recalculation: queue another pass and invalidate the one in flight.
  IF EXISTS (
    SELECT 1 FROM public.gradebook_row_recalc_state s
    WHERE s.class_id = p_class_id
      AND s.gradebook_id = p_gradebook_id
      AND s.student_id = p_student_id
      AND s.is_private = p_is_private
      AND s.is_recalculating = true
  ) THEN
    PERFORM pgmq_public.send(
      queue_name := 'gradebook_row_recalculate',
      message := jsonb_build_object(
        'class_id', p_class_id,
        'gradebook_id', p_gradebook_id,
        'student_id', p_student_id,
        'is_private', p_is_private
      )
    );
    UPDATE public.gradebook_row_recalc_state s
    SET dirty = true, version = s.version + 1, updated_at = now()
    WHERE s.class_id = p_class_id
      AND s.gradebook_id = p_gradebook_id
      AND s.student_id = p_student_id
      AND s.is_private = p_is_private;
    IF p_is_private = true THEN
      PERFORM public.enqueue_gradebook_row_recalculation(
        p_class_id, p_gradebook_id, p_student_id, false, p_reason || ' (opposite privacy)', p_trigger_id
      );
    END IF;
    RETURN;
  END IF;

  -- Dirty and not claimed: a pass is already queued and has not started, so it will read this change.
  IF EXISTS (
    SELECT 1 FROM public.gradebook_row_recalc_state s
    WHERE s.class_id = p_class_id
      AND s.gradebook_id = p_gradebook_id
      AND s.student_id = p_student_id
      AND s.is_private = p_is_private
      AND s.dirty = true
      AND s.is_recalculating = false
  ) THEN
    IF p_is_private = true THEN
      PERFORM public.enqueue_gradebook_row_recalculation(
        p_class_id, p_gradebook_id, p_student_id, false, p_reason || ' (opposite privacy)', p_trigger_id
      );
    END IF;
    RETURN;
  END IF;

  row_message := jsonb_build_object(
    'class_id', p_class_id,
    'gradebook_id', p_gradebook_id,
    'student_id', p_student_id,
    'is_private', p_is_private
  );

  PERFORM pgmq_public.send(
    queue_name := 'gradebook_row_recalculate',
    message := row_message
  );

  INSERT INTO public.gradebook_row_recalc_state (class_id, gradebook_id, student_id, is_private, dirty, is_recalculating, version)
  VALUES (p_class_id, p_gradebook_id, p_student_id, p_is_private, true, true, 1)
  ON CONFLICT (class_id, gradebook_id, student_id, is_private)
  DO UPDATE SET dirty = true, is_recalculating = true, version = public.gradebook_row_recalc_state.version + 1, updated_at = now();

  IF p_is_private = true THEN
    PERFORM public.enqueue_gradebook_row_recalculation(
      p_class_id, p_gradebook_id, p_student_id, false, p_reason || ' (opposite privacy)', p_trigger_id
    );
  END IF;
END;
$$;
