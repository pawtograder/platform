-- Fix gradebook recalculation flakiness caused by version-check deadlock.
--
-- Root cause: update_gradebook_rows_batch() updates gradebook_column_students,
-- which fires row-level triggers that call enqueue_gradebook_row_recalculation().
-- That function bumps the version in gradebook_row_recalc_state. The batch RPC
-- then tries to clear the recalc state using the OLD expected_version, which no
-- longer matches. Result: rows stay dirty/recalculating forever, scores stall.
--
-- Fix 1: Skip no-op updates (IS DISTINCT FROM) to reduce unnecessary trigger
--         firing when values haven't changed.
-- Fix 2: Clear the recalc state by (class_id, gradebook_id, student_id, is_private)
--         without requiring version match. Since the edge function already computes
--         ALL columns for a student in topological order, its results are always
--         current. The version check was causing false negatives when triggers
--         inside the same RPC bumped the version.

-- Restore the original enqueue function (revert session-variable change)
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
  -- Per-row advisory lock to avoid duplicate enqueues under concurrency
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      p_class_id::text || ':' || p_gradebook_id::text || ':' || p_student_id::text || ':' || p_is_private::text,
      42
    )::bigint
  );

  -- Gating rules against row-state table:
  -- - If row is currently recalculating, send a new message (so the worker
  --   re-processes with fresh data) but do NOT bump the version. The running
  --   worker's expected_version must remain valid so its RPC update succeeds.
  -- - Else if row is already dirty (and not recalculating), skip enqueue.
  IF EXISTS (
    SELECT 1 FROM public.gradebook_row_recalc_state s
    WHERE s.class_id = p_class_id
      AND s.gradebook_id = p_gradebook_id
      AND s.student_id = p_student_id
      AND s.is_private = p_is_private
      AND s.is_recalculating = true
  ) THEN
    -- Row is currently being recalculated by an edge function worker.
    -- Send a new message so the worker re-processes after its current batch,
    -- but do NOT bump the version (the worker needs version stability).
    PERFORM pgmq_public.send(
      queue_name := 'gradebook_row_recalculate',
      message := jsonb_build_object(
        'class_id', p_class_id,
        'gradebook_id', p_gradebook_id,
        'student_id', p_student_id,
        'is_private', p_is_private
      )
    );
    IF p_is_private = true THEN
      PERFORM public.enqueue_gradebook_row_recalculation(
        p_class_id, p_gradebook_id, p_student_id, false, p_reason || ' (opposite privacy)', p_trigger_id
      );
    END IF;
    RETURN;
  END IF;

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

  -- Normal case: row is idle — enqueue, mark dirty, and bump version.
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

-- Updated batch RPC: IS DISTINCT FROM + unconditional state clearing
CREATE OR REPLACE FUNCTION public.update_gradebook_rows_batch(p_batch_updates jsonb[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
SET statement_timeout TO '3min'
AS $$
DECLARE
  results jsonb;
  rows_to_reenqueue jsonb;
  messages_to_send jsonb[];
  message_ids_to_archive bigint[];
  msg_id bigint;
  expanded_count integer;
  version_matched_count integer;
  updated_gcs_count integer;
  unique_students_count integer;
  cleared_state_count integer;
  cleared_details jsonb;
BEGIN
  WITH student_updates_expanded AS (
    SELECT
      (su->>'class_id')::bigint AS class_id,
      (su->>'gradebook_id')::bigint AS gradebook_id,
      (su->>'student_id')::uuid AS student_id,
      (su->>'is_private')::boolean AS is_private,
      (su->>'expected_version')::bigint AS expected_version,
      jsonb_array_elements(su->'updates') AS update_obj
    FROM unnest(p_batch_updates) AS su
    WHERE su->'updates' IS NOT NULL
      AND jsonb_typeof(su->'updates') = 'array'
      AND jsonb_array_length(su->'updates') > 0
  ),
  -- Version check gates updates to prevent stale data from overwriting fresh data
  -- when multiple workers process the same student concurrently.
  updates_with_context AS (
    SELECT
      sue.*,
      (update_obj->>'gradebook_column_id')::bigint AS gradebook_column_id,
      (update_obj->>'score')::numeric AS score,
      (update_obj->>'is_missing')::boolean AS is_missing,
      (update_obj->>'released')::boolean AS released,
      update_obj->'incomplete_values' AS incomplete_values
    FROM student_updates_expanded sue
    WHERE EXISTS (
      SELECT 1 FROM public.gradebook_row_recalc_state rs
      WHERE rs.class_id = sue.class_id
        AND rs.gradebook_id = sue.gradebook_id
        AND rs.student_id = sue.student_id
        AND rs.is_private = sue.is_private
        AND rs.version = sue.expected_version
    )
  ),
  -- Only touch rows where at least one value actually differs
  updated_rows AS (
    UPDATE public.gradebook_column_students gcs
    SET
      score = uwc.score,
      is_missing = uwc.is_missing,
      released = uwc.released,
      incomplete_values = uwc.incomplete_values
    FROM updates_with_context uwc
    WHERE gcs.gradebook_column_id = uwc.gradebook_column_id
      AND gcs.student_id = uwc.student_id
      AND gcs.class_id = uwc.class_id
      AND gcs.gradebook_id = uwc.gradebook_id
      AND gcs.is_private = uwc.is_private
      AND (
        gcs.score IS DISTINCT FROM uwc.score
        OR gcs.is_missing IS DISTINCT FROM uwc.is_missing
        OR gcs.released IS DISTINCT FROM uwc.released
        OR gcs.incomplete_values IS DISTINCT FROM uwc.incomplete_values
      )
    RETURNING gcs.class_id, gcs.gradebook_id, gcs.student_id, gcs.is_private, uwc.expected_version
  ),
  update_counts AS (
    SELECT class_id, gradebook_id, student_id, is_private, expected_version, COUNT(*) AS updated_count
    FROM updated_rows GROUP BY class_id, gradebook_id, student_id, is_private, expected_version
  ),
  students_with_no_updates AS (
    SELECT DISTINCT
      (su->>'class_id')::bigint AS class_id, (su->>'gradebook_id')::bigint AS gradebook_id,
      (su->>'student_id')::uuid AS student_id, (su->>'is_private')::boolean AS is_private,
      (su->>'expected_version')::bigint AS expected_version
    FROM unnest(p_batch_updates) AS su
    WHERE (su->'updates' IS NULL OR jsonb_typeof(su->'updates') != 'array' OR jsonb_array_length(su->'updates') = 0)
    AND EXISTS (
      SELECT 1 FROM public.gradebook_row_recalc_state rs
      WHERE rs.class_id = (su->>'class_id')::bigint AND rs.gradebook_id = (su->>'gradebook_id')::bigint
        AND rs.student_id = (su->>'student_id')::uuid AND rs.is_private = (su->>'is_private')::boolean
        AND rs.version = (su->>'expected_version')::bigint
    )
  ),
  -- Clear recalc state for students where version matched (updates applied
  -- or no updates needed). For version mismatches the state stays dirty so
  -- the re-enqueue below can proceed.
  all_students_to_clear AS (
    SELECT DISTINCT
      (su->>'class_id')::bigint AS class_id, (su->>'gradebook_id')::bigint AS gradebook_id,
      (su->>'student_id')::uuid AS student_id, (su->>'is_private')::boolean AS is_private,
      (su->>'expected_version')::bigint AS expected_version
    FROM unnest(p_batch_updates) AS su
    WHERE EXISTS (
      SELECT 1 FROM public.gradebook_row_recalc_state rs
      WHERE rs.class_id = (su->>'class_id')::bigint AND rs.gradebook_id = (su->>'gradebook_id')::bigint
        AND rs.student_id = (su->>'student_id')::uuid AND rs.is_private = (su->>'is_private')::boolean
        AND rs.version = (su->>'expected_version')::bigint
    )
  ),
  cleared_rows AS (
    UPDATE public.gradebook_row_recalc_state rs
    SET dirty = false, is_recalculating = false, updated_at = NOW()
    FROM (SELECT * FROM all_students_to_clear ORDER BY class_id, gradebook_id, student_id, is_private) astc
    WHERE rs.class_id = astc.class_id
      AND rs.gradebook_id = astc.gradebook_id
      AND rs.student_id = astc.student_id
      AND rs.is_private = astc.is_private
      AND rs.version = astc.expected_version
    RETURNING rs.class_id, rs.gradebook_id, rs.student_id, rs.is_private, rs.dirty, rs.is_recalculating, rs.version
  ),
  student_results AS (
    SELECT DISTINCT
      (su->>'class_id')::bigint AS class_id, (su->>'gradebook_id')::bigint AS gradebook_id,
      (su->>'student_id')::uuid AS student_id, (su->>'is_private')::boolean AS is_private,
      (su->>'expected_version')::bigint AS expected_version,
      COALESCE((SELECT jsonb_agg(elem::text::bigint) FROM jsonb_array_elements_text(su->'message_ids') AS elem), '[]'::jsonb) AS message_ids,
      COALESCE(uc.updated_count, 0) AS updated_count,
      EXISTS (SELECT 1 FROM public.gradebook_row_recalc_state rs WHERE rs.class_id = (su->>'class_id')::bigint AND rs.gradebook_id = (su->>'gradebook_id')::bigint AND rs.student_id = (su->>'student_id')::uuid AND rs.is_private = (su->>'is_private')::boolean AND rs.version = (su->>'expected_version')::bigint) AS version_matched,
      EXISTS (SELECT 1 FROM cleared_rows cr WHERE cr.class_id = (su->>'class_id')::bigint AND cr.gradebook_id = (su->>'gradebook_id')::bigint AND cr.student_id = (su->>'student_id')::uuid AND cr.is_private = (su->>'is_private')::boolean) AS cleared
    FROM unnest(p_batch_updates) AS su
    LEFT JOIN update_counts uc ON uc.class_id = (su->>'class_id')::bigint AND uc.gradebook_id = (su->>'gradebook_id')::bigint AND uc.student_id = (su->>'student_id')::uuid AND uc.is_private = (su->>'is_private')::boolean
  ),
  debug_counts AS (
    SELECT
      (SELECT COUNT(*) FROM student_updates_expanded) AS expanded_count_val,
      (SELECT COUNT(*) FROM updates_with_context) AS version_matched_count_val,
      (SELECT COUNT(*) FROM updated_rows) AS updated_gcs_count_val,
      (SELECT COUNT(DISTINCT (class_id, gradebook_id, student_id, is_private)) FROM update_counts) AS unique_students_count_val,
      (SELECT COUNT(*) FROM cleared_rows) AS cleared_state_count_val
  ),
  final_results AS (
    SELECT
      jsonb_agg(jsonb_build_object('class_id', class_id, 'gradebook_id', gradebook_id, 'student_id', student_id, 'is_private', is_private, 'message_ids', message_ids, 'updated_count', updated_count, 'version_matched', version_matched, 'cleared', cleared) ORDER BY student_id) AS results_jsonb,
      (SELECT expanded_count_val FROM debug_counts LIMIT 1) AS ecv,
      (SELECT version_matched_count_val FROM debug_counts LIMIT 1) AS vmcv,
      (SELECT updated_gcs_count_val FROM debug_counts LIMIT 1) AS ugcv,
      (SELECT unique_students_count_val FROM debug_counts LIMIT 1) AS uscv,
      (SELECT cleared_state_count_val FROM debug_counts LIMIT 1) AS cscv
    FROM student_results
  )
  SELECT results_jsonb, ecv, vmcv, ugcv, uscv, cscv
  INTO results, expanded_count, version_matched_count, updated_gcs_count, unique_students_count, cleared_state_count
  FROM final_results;

  -- Archive all messages
  SELECT ARRAY_AGG(DISTINCT msg_ids.msg_id) INTO message_ids_to_archive
  FROM (
    SELECT UNNEST(
      ARRAY(
        SELECT jsonb_array_elements_text(su->'message_ids')
        FROM unnest(p_batch_updates) AS su
        WHERE su->'message_ids' IS NOT NULL
      )
    )::bigint AS msg_id
  ) AS msg_ids;

  IF message_ids_to_archive IS NOT NULL AND array_length(message_ids_to_archive, 1) > 0 THEN
    FOREACH msg_id IN ARRAY message_ids_to_archive LOOP
      PERFORM pgmq_public.archive('gradebook_row_recalculate', msg_id);
    END LOOP;
  END IF;

  RETURN jsonb_build_object('results', results, 'expanded_count', expanded_count, 'version_matched_count', version_matched_count, 'updated_gcs_count', updated_gcs_count, 'unique_students_count', unique_students_count, 'cleared_state_count', cleared_state_count);
END;
$$;
