-- Drop the unused `changed_rows` accumulator from the batch wrapper. The
-- variable was declared and array_appended inside the loop but never read or
-- returned (review feedback on PR #734). Pure cleanup; behaviour unchanged.
--
-- Function body is otherwise identical to the prior migration
-- (20260424150000_gradebook_cell_recalc_lock_old_row.sql).

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
BEGIN
  FOREACH update_obj IN ARRAY p_updates
  LOOP
    p_id := (update_obj->>'id')::bigint;
    p_update_data := update_obj->'updates';

    IF p_id IS NULL OR p_update_data IS NULL THEN
      CONTINUE;
    END IF;

    DECLARE
      old_row public.gradebook_column_students%ROWTYPE;
      updated_row public.gradebook_column_students%ROWTYPE;
    BEGIN
      -- Lock the pre-update row so the post-update vs pre-update comparison
      -- below is race-free under concurrent edits. See migration
      -- 20260424150000 header.
      SELECT * INTO old_row
      FROM public.gradebook_column_students
      WHERE id = p_id
      FOR UPDATE;

      IF NOT FOUND THEN
        CONTINUE;
      END IF;

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

      IF (
        updated_row.score IS DISTINCT FROM old_row.score OR
        updated_row.score_override IS DISTINCT FROM old_row.score_override OR
        updated_row.is_missing IS DISTINCT FROM old_row.is_missing OR
        updated_row.is_droppable IS DISTINCT FROM old_row.is_droppable OR
        updated_row.is_excused IS DISTINCT FROM old_row.is_excused
      ) THEN
        updated_count := updated_count + 1;

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
  IS 'Batch updates multiple gradebook_column_students rows and enqueues dependent recalculations for any whose score/score_override/is_missing/is_droppable/is_excused actually changed. Locks each pre-update row (FOR UPDATE) so the before/after comparison is race-free under concurrent edits. Re-enqueues across in-flight recalcs (batch enqueue handles version bumps so VERSION_MISMATCH_RECOVERY picks up the new values).';
