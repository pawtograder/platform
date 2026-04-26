-- Bug 7: Gradebook dependent recalc lost on quick user edits while row is recalculating.
--
-- Background: update_gradebook_column_student_with_recalc (defined in
-- 20251102112812_reduce-rt-spam.sql L1232-1294) writes the user's edit to
-- gradebook_column_students, then guards the dependent-recalc enqueue
-- with `IF NOT EXISTS (... is_recalculating=true)`. When a row is
-- mid-recalc from a previous burst, a brand-new user edit lands in the
-- DB but no new recalc fires; the in-flight worker, still computing
-- with the OLD value, finishes and clears is_recalculating=false /
-- dirty=false. Dependent calculated columns (Final Grade, totals) stay
-- stuck on the pre-edit derived values until something else perturbs
-- the row.
--
-- The worker (supabase/functions/gradebook-column-recalculate/index.ts
-- ~L241-309) already implements VERSION_MISMATCH_RECOVERY: if
-- gradebook_row_recalc_state.version moves while a worker is running,
-- the worker re-runs with the latest inputs. So as long as we enqueue a
-- new batch (which bumps the row-state version), the worker will pick
-- up the new value. We just need the wrapper RPC to actually enqueue
-- when the user's edit *changes* a recalc-relevant input.
--
-- A previous attempt (commit 7fec782c, migration
-- 20260424130000_update_gradebook_cell_recalc_when_in_flight.sql)
-- removed the in-flight gate entirely and was reverted: pass rate
-- dropped from 433/3 to 421/12. Per the audit, the cascade came from
-- redundant enqueues and version bumps under E2E load.
--
-- Smarter gating: re-enqueue on top of an in-flight recalc only when
-- the user edit actually changes a recalc-relevant field versus the
-- pre-edit row. The five recalc-relevant fields are score,
-- score_override, is_missing, is_droppable, is_excused -- exactly the
-- inputs the worker reads when computing dependent-column values. If
-- the new write does not change any of them (e.g. UI re-saving the
-- same value, an idempotent batch retry), nothing downstream cares,
-- so we skip the enqueue and don't bump the row-state version.
--
-- This keeps every signal-bearing edit propagating to dependents while
-- preventing the noise that triggered the prior cascade.

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
  recalc_input_changed boolean;
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

  -- Did this write actually change one of the five fields the dependent
  -- recalculator consumes? (Compare post-update row vs pre-update row.)
  recalc_input_changed := (
    updated_row.score IS DISTINCT FROM old_row.score OR
    updated_row.score_override IS DISTINCT FROM old_row.score_override OR
    updated_row.is_missing IS DISTINCT FROM old_row.is_missing OR
    updated_row.is_droppable IS DISTINCT FROM old_row.is_droppable OR
    updated_row.is_excused IS DISTINCT FROM old_row.is_excused
  );

  -- Smarter gating, replacing the old `IF NOT EXISTS (... is_recalculating=true)`
  -- short-circuit:
  --
  --   * No-op write (no recalc input changed): skip the enqueue. Avoids
  --     redundant version bumps and the prior cascade.
  --
  --   * Recalc input did change: always enqueue, even if the row is
  --     currently recalculating. enqueue_gradebook_row_recalculation_batch
  --     bumps gradebook_row_recalc_state.version, and the worker's
  --     VERSION_MISMATCH_RECOVERY path picks up the new value on its
  --     stale-version retry. This is the bug fix: previously this branch
  --     was unconditionally suppressed whenever is_recalculating=true,
  --     which dropped user edits' propagation to dependent columns.
  IF recalc_input_changed THEN
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
  IS 'Updates a single gradebook_column_students row and enqueues dependent recalculations when any of score/score_override/is_missing/is_droppable/is_excused actually changed. Re-enqueues even on top of an in-flight recalc so the worker''s VERSION_MISMATCH_RECOVERY picks up the new value; suppresses no-op writes to avoid version-bump cascades.';

-- Same fix for the batch wrapper RPC. The original (in
-- 20251102112812_reduce-rt-spam.sql L1300-1407) has the same flaw: it
-- collects rows for enqueue but excludes any row whose recalc is already
-- in flight, even when the user-supplied write actually changed a recalc
-- input. Drop that inner gate and rely on the outer
-- "any-recalc-relevant-field-changed" check (which the function already
-- has) to suppress no-op writes. The batch enqueue's per-row advisory
-- lock + version bump makes in-flight re-enqueue safe.
CREATE OR REPLACE FUNCTION public.update_gradebook_column_students_batch_with_recalc(
  p_updates jsonb[]
) RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
DECLARE
  update_obj jsonb;
  p_id bigint;
  p_update_data jsonb;
  updated_count integer := 0;
  all_rows_to_enqueue jsonb[] := ARRAY[]::jsonb[];
  changed_rows jsonb[];
BEGIN
  -- Process each update
  FOREACH update_obj IN ARRAY p_updates
  LOOP
    p_id := (update_obj->>'id')::bigint;
    p_update_data := update_obj->'updates';

    IF p_id IS NULL OR p_update_data IS NULL THEN
      CONTINUE;
    END IF;

    -- Get old row values
    DECLARE
      old_row public.gradebook_column_students%ROWTYPE;
      updated_row public.gradebook_column_students%ROWTYPE;
    BEGIN
      SELECT * INTO old_row FROM public.gradebook_column_students WHERE id = p_id;

      IF NOT FOUND THEN
        CONTINUE;
      END IF;

      -- Perform the UPDATE
      UPDATE public.gradebook_column_students
      SET
        score = CASE WHEN p_update_data ? 'score' THEN (p_update_data->>'score')::numeric ELSE score END,
        score_override = CASE WHEN p_update_data ? 'score_override' THEN (p_update_data->>'score_override')::numeric ELSE score_override END,
        is_missing = CASE WHEN p_update_data ? 'is_missing' THEN (p_update_data->>'is_missing')::boolean ELSE is_missing END,
        is_excused = CASE WHEN p_update_data ? 'is_excused' THEN (p_update_data->>'is_excused')::boolean ELSE is_excused END,
        is_droppable = CASE WHEN p_update_data ? 'is_droppable' THEN (p_update_data->>'is_droppable')::boolean ELSE is_droppable END,
        released = CASE WHEN p_update_data ? 'released' THEN (p_update_data->>'released')::boolean ELSE released END,
        score_override_note = CASE WHEN p_update_data ? 'score_override_note' THEN (p_update_data->>'score_override_note')::text ELSE score_override_note END,
        incomplete_values = CASE WHEN p_update_data ? 'incomplete_values' THEN p_update_data->'incomplete_values' ELSE incomplete_values END
      WHERE id = p_id
      RETURNING * INTO updated_row;

      -- Did this update actually change a recalc-relevant field?
      IF (
        updated_row.score IS DISTINCT FROM old_row.score OR
        updated_row.score_override IS DISTINCT FROM old_row.score_override OR
        updated_row.is_missing IS DISTINCT FROM old_row.is_missing OR
        updated_row.is_droppable IS DISTINCT FROM old_row.is_droppable OR
        updated_row.is_excused IS DISTINCT FROM old_row.is_excused
      ) THEN
        updated_count := updated_count + 1;
        changed_rows := array_append(changed_rows, to_jsonb(updated_row));

        -- Always enqueue when a recalc input changed (no longer skipped
        -- when is_recalculating=true; the batch enqueue's version bump
        -- + the worker's VERSION_MISMATCH_RECOVERY make the in-flight
        -- worker re-run with the new value). Still de-duplicate within
        -- this single batch call so the same student row isn't
        -- enqueued twice for the same privacy mode in one call.
        IF NOT EXISTS (
          SELECT 1 FROM unnest(all_rows_to_enqueue) AS existing
          WHERE (existing->>'class_id')::bigint = updated_row.class_id
            AND (existing->>'gradebook_id')::bigint = updated_row.gradebook_id
            AND (existing->>'student_id')::uuid = updated_row.student_id
            AND (existing->>'is_private')::boolean = updated_row.is_private
        ) THEN
          all_rows_to_enqueue := array_append(all_rows_to_enqueue,
            jsonb_build_object(
              'class_id', updated_row.class_id,
              'gradebook_id', updated_row.gradebook_id,
              'student_id', updated_row.student_id,
              'is_private', updated_row.is_private
            )
          );
        END IF;
      END IF;
    END;
  END LOOP;

  -- Batch enqueue all dependent rows in a single call
  IF array_length(all_rows_to_enqueue, 1) > 0 THEN
    PERFORM public.enqueue_gradebook_row_recalculation_batch(all_rows_to_enqueue);
  END IF;

  RETURN jsonb_build_object(
    'updated_count', updated_count,
    'enqueued_count', COALESCE(array_length(all_rows_to_enqueue, 1), 0)
  );
END;
$$;

COMMENT ON FUNCTION public.update_gradebook_column_students_batch_with_recalc(jsonb[])
  IS 'Batch updates multiple gradebook_column_students rows and enqueues dependent recalculations for any whose score/score_override/is_missing/is_droppable/is_excused actually changed. Re-enqueues across in-flight recalcs (batch enqueue handles version bumps so VERSION_MISMATCH_RECOVERY picks up the new values).';
