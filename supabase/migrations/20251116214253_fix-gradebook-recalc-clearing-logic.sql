-- Fix gradebook recalculation clearing logic
-- Issue: Rows with version_matched=true but updated_count=0 are not being cleared
-- This causes messages to never be archived and get stuck in the queue
--
-- The problem is that the 'cleared' field checks if the row exists in cleared_rows
-- (the RETURNING from UPDATE), but it should be true whenever version_matched=true
-- regardless of whether updates were made.

CREATE OR REPLACE FUNCTION public.update_gradebook_rows_batch(p_batch_updates jsonb[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
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
  -- Step 1: Expand all updates into individual gradebook_column_students updates
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
  -- Step 2: Filter updates to only those where version matches (to avoid overwriting concurrent changes)
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
  -- Step 3: Perform the actual updates
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
    RETURNING gcs.class_id, gcs.gradebook_id, gcs.student_id, gcs.is_private, uwc.expected_version
  ),
  -- Step 4: Count updates per student
  update_counts AS (
    SELECT 
      class_id,
      gradebook_id,
      student_id,
      is_private,
      expected_version,
      COUNT(*) AS updated_count
    FROM updated_rows
    GROUP BY class_id, gradebook_id, student_id, is_private, expected_version
  ),
  -- Step 5: Identify students with no updates but matching versions (need to clear state)
  students_with_no_updates AS (
    SELECT DISTINCT
      (su->>'class_id')::bigint AS class_id,
      (su->>'gradebook_id')::bigint AS gradebook_id,
      (su->>'student_id')::uuid AS student_id,
      (su->>'is_private')::boolean AS is_private,
      (su->>'expected_version')::bigint AS expected_version
    FROM unnest(p_batch_updates) AS su
    WHERE (
      su->'updates' IS NULL 
      OR jsonb_typeof(su->'updates') != 'array'
      OR jsonb_array_length(su->'updates') = 0
    )
    AND EXISTS (
      SELECT 1 FROM public.gradebook_row_recalc_state rs
      WHERE rs.class_id = (su->>'class_id')::bigint
        AND rs.gradebook_id = (su->>'gradebook_id')::bigint
        AND rs.student_id = (su->>'student_id')::uuid
        AND rs.is_private = (su->>'is_private')::boolean
        AND rs.version = (su->>'expected_version')::bigint
    )
  ),
  -- Step 6: Include ALL students with version_matched=true for clearing state
  -- This includes students with updates, students with no updates, and students whose updates
  -- were filtered out due to version mismatches at update time but version matches now
  all_students_to_clear AS (
    SELECT 
      class_id,
      gradebook_id,
      student_id,
      is_private,
      expected_version
    FROM update_counts
    UNION
    SELECT 
      class_id,
      gradebook_id,
      student_id,
      is_private,
      expected_version
    FROM students_with_no_updates
    UNION
    -- Also include any students from the input where version matches (even if they had updates that were filtered)
    SELECT DISTINCT
      (su->>'class_id')::bigint AS class_id,
      (su->>'gradebook_id')::bigint AS gradebook_id,
      (su->>'student_id')::uuid AS student_id,
      (su->>'is_private')::boolean AS is_private,
      (su->>'expected_version')::bigint AS expected_version
    FROM unnest(p_batch_updates) AS su
    WHERE EXISTS (
      SELECT 1 FROM public.gradebook_row_recalc_state rs
      WHERE rs.class_id = (su->>'class_id')::bigint
        AND rs.gradebook_id = (su->>'gradebook_id')::bigint
        AND rs.student_id = (su->>'student_id')::uuid
        AND rs.is_private = (su->>'is_private')::boolean
        AND rs.version = (su->>'expected_version')::bigint
    )
  ),
  -- Step 7: Clear recalc state for all version-matched rows (both with updates and without)
  -- ORDER BY key columns to ensure deterministic lock acquisition order and prevent deadlocks
  cleared_rows AS (
    UPDATE public.gradebook_row_recalc_state
    SET 
      dirty = false,
      is_recalculating = false,
      updated_at = NOW()
    FROM (
      SELECT 
        astc.class_id,
        astc.gradebook_id,
        astc.student_id,
        astc.is_private,
        astc.expected_version
      FROM all_students_to_clear astc
      ORDER BY astc.class_id, astc.gradebook_id, astc.student_id, astc.is_private
    ) ordered_astc
    WHERE gradebook_row_recalc_state.class_id = ordered_astc.class_id
      AND gradebook_row_recalc_state.gradebook_id = ordered_astc.gradebook_id
      AND gradebook_row_recalc_state.student_id = ordered_astc.student_id
      AND gradebook_row_recalc_state.is_private = ordered_astc.is_private
      AND gradebook_row_recalc_state.version = ordered_astc.expected_version
    RETURNING 
      gradebook_row_recalc_state.class_id,
      gradebook_row_recalc_state.gradebook_id,
      gradebook_row_recalc_state.student_id,
      gradebook_row_recalc_state.is_private,
      gradebook_row_recalc_state.dirty,
      gradebook_row_recalc_state.is_recalculating,
      gradebook_row_recalc_state.version
  ),
  -- Step 8: Build results - FIX: cleared should be true if version matched, not just if row was in cleared_rows
  student_results AS (
    SELECT DISTINCT
      (su->>'class_id')::bigint AS class_id,
      (su->>'gradebook_id')::bigint AS gradebook_id,
      (su->>'student_id')::uuid AS student_id,
      (su->>'is_private')::boolean AS is_private,
      (su->>'expected_version')::bigint AS expected_version,
      -- Extract message_ids array and convert to JSONB array for inclusion in results
      COALESCE(
        (SELECT jsonb_agg(elem::text::bigint)
         FROM jsonb_array_elements_text(su->'message_ids') AS elem),
        '[]'::jsonb
      ) AS message_ids,
      COALESCE(uc.updated_count, 0) AS updated_count,
      -- Version matched if current version equals expected version
      CASE 
        WHEN EXISTS (
          SELECT 1 FROM public.gradebook_row_recalc_state rs
          WHERE rs.class_id = (su->>'class_id')::bigint
            AND rs.gradebook_id = (su->>'gradebook_id')::bigint
            AND rs.student_id = (su->>'student_id')::uuid
            AND rs.is_private = (su->>'is_private')::boolean
            AND rs.version = (su->>'expected_version')::bigint
        ) THEN true
        ELSE false
      END AS version_matched,
      -- FIX: cleared should be true whenever version_matched=true
      -- The UPDATE in cleared_rows will handle the actual clearing, but we mark it as cleared
      -- in results so messages get archived even if no updates were made
      CASE 
        WHEN EXISTS (
          SELECT 1 FROM public.gradebook_row_recalc_state rs
          WHERE rs.class_id = (su->>'class_id')::bigint
            AND rs.gradebook_id = (su->>'gradebook_id')::bigint
            AND rs.student_id = (su->>'student_id')::uuid
            AND rs.is_private = (su->>'is_private')::boolean
            AND rs.version = (su->>'expected_version')::bigint
        ) THEN true
        ELSE false
      END AS cleared
    FROM unnest(p_batch_updates) AS su
    LEFT JOIN update_counts uc ON
      uc.class_id = (su->>'class_id')::bigint
      AND uc.gradebook_id = (su->>'gradebook_id')::bigint
      AND uc.student_id = (su->>'student_id')::uuid
      AND uc.is_private = (su->>'is_private')::boolean
  ),
  debug_counts AS (
    SELECT 
      (SELECT COUNT(*) FROM student_updates_expanded) AS expanded_count_val,
      (SELECT COUNT(*) FROM updates_with_context) AS version_matched_count_val,
      (SELECT COUNT(*) FROM updated_rows) AS updated_gcs_count_val,
      (SELECT COUNT(DISTINCT (class_id, gradebook_id, student_id, is_private)) FROM update_counts) AS unique_students_count_val,
      (SELECT COUNT(*) FROM cleared_rows) AS cleared_state_count_val,
      '[]'::jsonb AS cleared_rows_details
  ),
  final_results AS (
    SELECT 
      jsonb_agg(
        jsonb_build_object(
          'class_id', class_id,
          'gradebook_id', gradebook_id,
          'student_id', student_id,
          'is_private', is_private,
          'message_ids', message_ids,
          'updated_count', updated_count,
          'version_matched', version_matched,
          'cleared', cleared
        ) ORDER BY student_id
      ) AS results_jsonb,
      (SELECT expanded_count_val FROM debug_counts LIMIT 1) AS expanded_count_val,
      (SELECT version_matched_count_val FROM debug_counts LIMIT 1) AS version_matched_count_val,
      (SELECT updated_gcs_count_val FROM debug_counts LIMIT 1) AS updated_gcs_count_val,
      (SELECT unique_students_count_val FROM debug_counts LIMIT 1) AS unique_students_count_val,
      (SELECT cleared_state_count_val FROM debug_counts LIMIT 1) AS cleared_state_count_val,
      (SELECT cleared_rows_details FROM debug_counts LIMIT 1) AS cleared_rows_details_val
    FROM student_results
  )
  SELECT 
    results_jsonb,
    expanded_count_val,
    version_matched_count_val,
    updated_gcs_count_val,
    unique_students_count_val,
    cleared_state_count_val,
    cleared_rows_details_val
  INTO 
    results,
    expanded_count,
    version_matched_count,
    updated_gcs_count,
    unique_students_count,
    cleared_state_count,
    cleared_details
  FROM final_results;
  
  RAISE NOTICE '[update_gradebook_rows_batch] Step 1: Expanded % update rows from input', expanded_count;
  RAISE NOTICE '[update_gradebook_rows_batch] Step 2: % rows matched version check (will be updated)', version_matched_count;
  RAISE NOTICE '[update_gradebook_rows_batch] Step 3: Updated % gradebook_column_students rows', updated_gcs_count;
  RAISE NOTICE '[update_gradebook_rows_batch] Step 4: Found % unique students with updates, preparing to clear recalc state', unique_students_count;
  RAISE NOTICE '[update_gradebook_rows_batch] Step 5: Cleared recalc state for % rows', cleared_state_count;
  
  -- Debug: Log details of cleared rows to verify they were actually cleared
  -- (removed cleared_rows_debug CTE to avoid column reference issues)
  
  RAISE NOTICE '[update_gradebook_rows_batch] Step 6: Built results for % students', jsonb_array_length(results);
  
  -- Step 9: Archive ALL message IDs from the batch (simple approach - archive if transaction succeeds)
  -- Extract all message IDs from the input batch updates
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
    RAISE NOTICE '[update_gradebook_rows_batch] Step 7: Archiving % messages (all messages from batch)', array_length(message_ids_to_archive, 1);
    FOREACH msg_id IN ARRAY message_ids_to_archive
    LOOP
      PERFORM pgmq_public.archive('gradebook_row_recalculate', msg_id);
    END LOOP;
    RAISE NOTICE '[update_gradebook_rows_batch] Step 7: Archived % messages', array_length(message_ids_to_archive, 1);
  ELSE
    RAISE NOTICE '[update_gradebook_rows_batch] Step 7: No messages to archive';
  END IF;
  
  -- Step 10: Re-enqueue rows with version mismatches
  -- Extract rows from results where version did not match
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'class_id', (sr->>'class_id')::bigint,
        'gradebook_id', (sr->>'gradebook_id')::bigint,
        'student_id', sr->>'student_id',
        'is_private', (sr->>'is_private')::boolean
      )
    ),
    '[]'::jsonb
  ) INTO rows_to_reenqueue
  FROM jsonb_array_elements(results) AS sr
  WHERE (sr->>'version_matched')::boolean = false;
  
  IF rows_to_reenqueue IS NOT NULL AND jsonb_array_length(rows_to_reenqueue) > 0 THEN
    RAISE NOTICE '[update_gradebook_rows_batch] Step 8: Re-enqueueing % rows with version mismatches', jsonb_array_length(rows_to_reenqueue);
    -- Build messages array and send directly to queue (no state update needed)
    -- The state is already set from the original enqueue, we just need to re-send the message
    SELECT ARRAY_AGG(
      jsonb_build_object(
        'class_id', (sr->>'class_id')::bigint,
        'gradebook_id', (sr->>'gradebook_id')::bigint,
        'student_id', sr->>'student_id',
        'is_private', (sr->>'is_private')::boolean
      )
    ) INTO messages_to_send
    FROM jsonb_array_elements(rows_to_reenqueue) AS sr;
    
    IF messages_to_send IS NOT NULL AND array_length(messages_to_send, 1) > 0 THEN
      PERFORM pgmq_public.send_batch(
        queue_name := 'gradebook_row_recalculate',
        messages := messages_to_send
      );
      RAISE NOTICE '[update_gradebook_rows_batch] Step 8: Re-enqueued % messages', array_length(messages_to_send, 1);
    END IF;
  END IF;
  
  RETURN jsonb_build_object(
    'results', results,
    'expanded_count', expanded_count,
    'version_matched_count', version_matched_count,
    'updated_gcs_count', updated_gcs_count,
    'unique_students_count', unique_students_count,
    'cleared_state_count', cleared_state_count
  );
END;
$$;

COMMENT ON FUNCTION public.update_gradebook_rows_batch(jsonb[]) IS 'Batch updates gradebook rows and clears recalculation state. Fixed to properly mark rows as cleared when version matches, even if no updates were made.';

