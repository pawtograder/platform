CREATE OR REPLACE FUNCTION public.update_gradebook_rows_batch(p_batch_updates jsonb[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
set statement_timeout to '3min'
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



CREATE OR REPLACE FUNCTION public.import_gradebook_scores(
  p_class_id bigint,
  p_updates jsonb
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
set statement_timeout to '3min'
AS $$
DECLARE
  v_invalid_column_id bigint;
  rows_to_enqueue_jsonb jsonb;
BEGIN

  -- Authorization: only instructors for the class may import
  IF NOT public.authorizeforclassinstructor(p_class_id) THEN
    RAISE EXCEPTION 'Access denied: Only instructors can import grades for class %', p_class_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Basic shape validation
  IF p_updates IS NULL OR jsonb_typeof(p_updates) <> 'array' THEN
    RAISE EXCEPTION 'p_updates must be a JSON array of column update objects'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Validate that all referenced columns exist and belong to this class
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT DISTINCT (elem->>'gradebook_column_id')::bigint AS gradebook_column_id
      FROM jsonb_array_elements(p_updates) AS elem
    ) pc
    LEFT JOIN public.gradebook_columns gc ON gc.id = pc.gradebook_column_id
    WHERE gc.id IS NULL OR gc.class_id <> p_class_id
  ) THEN
    SELECT pc.gradebook_column_id INTO v_invalid_column_id
    FROM (
      SELECT DISTINCT (elem->>'gradebook_column_id')::bigint AS gradebook_column_id
      FROM jsonb_array_elements(p_updates) AS elem
    ) pc
    LEFT JOIN public.gradebook_columns gc ON gc.id = pc.gradebook_column_id
    WHERE gc.id IS NULL OR gc.class_id <> p_class_id
    LIMIT 1;

    RAISE EXCEPTION 'Invalid gradebook_column_id % for class %', v_invalid_column_id, p_class_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Single UPDATE with deterministic deduplication using DISTINCT ON
  WITH parsed_with_ordinality AS (
    SELECT
      (col_elem->>'gradebook_column_id')::bigint AS gradebook_column_id,
      (entry_elem->>'student_id')::uuid AS student_id,
      CASE
        WHEN entry_elem ? 'score' THEN NULLIF(entry_elem->>'score','')::numeric
        WHEN entry_elem ? 'value' THEN NULLIF(entry_elem->>'value','')::numeric
        ELSE NULL
      END AS new_score,
      col_ordinality * 1000 + entry_ordinality AS ordinality
    FROM jsonb_array_elements(p_updates) WITH ORDINALITY AS col_elem(col_elem, col_ordinality)
    CROSS JOIN LATERAL jsonb_array_elements(
      COALESCE(col_elem->'entries', col_elem->'student_scores', '[]'::jsonb)
    ) WITH ORDINALITY AS entry_elem(entry_elem, entry_ordinality)
  ), parsed AS (
    SELECT DISTINCT ON (gradebook_column_id, student_id)
      gradebook_column_id,
      student_id,
      new_score
    FROM parsed_with_ordinality
    ORDER BY gradebook_column_id, student_id, ordinality DESC
  ), target_rows AS (
    SELECT gcs.id, gcs.gradebook_column_id, gcs.student_id
    FROM parsed p
    JOIN public.gradebook_column_students gcs
      ON gcs.gradebook_column_id = p.gradebook_column_id
     AND gcs.student_id = p.student_id
     AND gcs.class_id = p_class_id
     AND gcs.is_private = true
  ), cols AS (
    SELECT id, score_expression
    FROM public.gradebook_columns
    WHERE class_id = p_class_id
      AND id IN (SELECT DISTINCT gradebook_column_id FROM parsed)
  ),
  updated_rows AS (
    UPDATE public.gradebook_column_students g
    SET 
      score = CASE 
        WHEN c.score_expression IS NULL THEN p.new_score 
        ELSE g.score 
      END,
      score_override = CASE 
        WHEN c.score_expression IS NOT NULL THEN p.new_score 
        ELSE g.score_override 
      END
    FROM target_rows tr
    JOIN cols c ON c.id = tr.gradebook_column_id
    JOIN parsed p ON p.gradebook_column_id = tr.gradebook_column_id AND p.student_id = tr.student_id
    WHERE g.id = tr.id
    RETURNING 
      g.class_id,
      g.gradebook_id,
      g.student_id,
      g.is_private
  ),
  -- Collect unique student rows that need recalculation
  rows_to_enqueue AS (
    SELECT DISTINCT
      ur.class_id,
      ur.gradebook_id,
      ur.student_id,
      ur.is_private
    FROM updated_rows ur
    WHERE NOT EXISTS (
      SELECT 1 FROM public.gradebook_row_recalc_state rs
      WHERE rs.class_id = ur.class_id
        AND rs.gradebook_id = ur.gradebook_id
        AND rs.student_id = ur.student_id
        AND rs.is_private = ur.is_private
        AND rs.is_recalculating = true
    )
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'class_id', class_id,
      'gradebook_id', gradebook_id,
      'student_id', student_id,
      'is_private', is_private
    )
  ) INTO rows_to_enqueue_jsonb
  FROM rows_to_enqueue;

  -- Batch enqueue recalculation for all affected student rows
  IF rows_to_enqueue_jsonb IS NOT NULL AND jsonb_array_length(rows_to_enqueue_jsonb) > 0 THEN
    PERFORM public.enqueue_gradebook_row_recalculation_batch(
      ARRAY(SELECT jsonb_array_elements(rows_to_enqueue_jsonb))
    );
  END IF;

  RETURN true;
END;
$$;


CREATE OR REPLACE FUNCTION "public"."bulk_assign_reviews"(
    "p_class_id" bigint,
    "p_assignment_id" bigint,
    "p_rubric_id" bigint,
    "p_draft_assignments" "jsonb",
    "p_due_date" timestamp with time zone
) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    set statement_timeout to '3min'
AS $$
DECLARE
    v_result jsonb := jsonb_build_object('success', true);
    v_assignment record;
    v_assignments_created integer := 0;
    v_assignments_updated integer := 0;
    v_assignments_retargeted integer := 0;
    v_parts_created integer := 0;
    v_submission_reviews_created integer := 0;
    v_review_assignment record;
    v_draft_assignment jsonb;
    v_submission_review_id bigint;
    v_sr_was_inserted boolean := false;
    v_assignee_profile_id uuid;
    v_submission_id bigint;
    v_rubric_part_id bigint;
    v_has_specific_parts boolean;
    v_review_assignment_ids bigint[] := '{}';
BEGIN
    set statement_timeout to '3min';

    -- Authorization check: only instructors can bulk assign reviews
    IF NOT authorizeforclassinstructor(p_class_id) THEN
        RAISE EXCEPTION 'Access denied: Only instructors can bulk assign reviews'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Validate that the assignment belongs to the class
    SELECT * INTO v_assignment 
    FROM public.assignments 
    WHERE id = p_assignment_id AND class_id = p_class_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Assignment % not found in class %', p_assignment_id, p_class_id;
    END IF;

    -- Validate that the rubric exists and belongs to the assignment
    IF NOT EXISTS (
        SELECT 1 FROM public.rubrics 
        WHERE id = p_rubric_id AND assignment_id = p_assignment_id
    ) THEN
        RAISE EXCEPTION 'Rubric % not found for assignment %', p_rubric_id, p_assignment_id;
    END IF;

    -- Process each draft assignment (optimistic, no locking)
    FOR v_draft_assignment IN SELECT * FROM jsonb_array_elements(p_draft_assignments)
    LOOP
        v_assignee_profile_id := (v_draft_assignment->>'assignee_profile_id')::uuid;
        v_submission_id := (v_draft_assignment->>'submission_id')::bigint;
        v_rubric_part_id := CASE 
            WHEN v_draft_assignment->>'rubric_part_id' = 'null' OR v_draft_assignment->>'rubric_part_id' IS NULL 
            THEN NULL 
            ELSE (v_draft_assignment->>'rubric_part_id')::bigint 
        END;
        v_has_specific_parts := v_rubric_part_id IS NOT NULL;

        -- If specific rubric part specified, validate it belongs to rubric
        IF v_has_specific_parts THEN
            PERFORM 1 FROM public.rubric_parts rp WHERE rp.id = v_rubric_part_id AND rp.rubric_id = p_rubric_id;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'Rubric part % does not belong to rubric %', v_rubric_part_id, p_rubric_id
                USING ERRCODE = 'foreign_key_violation';
            END IF;
        END IF;

        -- Validate the submission belongs to this class/assignment (do not require is_active)
        PERFORM 1
        FROM public.submissions s
        WHERE s.id = v_submission_id
          AND s.assignment_id = p_assignment_id
          AND s.class_id = p_class_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Invalid submission_id % for assignment % / class %', v_submission_id, p_assignment_id, p_class_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;

        -- Validate assignee is enrolled in class with grader/instructor role
        PERFORM 1
        FROM public.user_roles ur
        WHERE ur.private_profile_id = v_assignee_profile_id
          AND ur.class_id = p_class_id
          AND ur.role IN ('grader','instructor');
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Assignee % is not authorized for class %', v_assignee_profile_id, p_class_id
                USING ERRCODE = 'insufficient_privilege';
        END IF;

        -- Ensure submission_review exists (idempotent operation)
        INSERT INTO public.submission_reviews (
            submission_id,
            rubric_id,
            class_id,
            name,
            total_score,
            total_autograde_score,
            tweak
        ) VALUES (
            v_submission_id,
            p_rubric_id,
            p_class_id,
            (SELECT name FROM public.rubrics WHERE id = p_rubric_id),
            0,
            0,
            0
        ) 
        ON CONFLICT (submission_id, rubric_id) DO UPDATE SET 
            tweak = public.submission_reviews.tweak
        RETURNING id, (xmax = 0) AS was_inserted INTO v_submission_review_id, v_sr_was_inserted;

        -- Only increment counter when an actual insert occurred
        IF v_sr_was_inserted THEN
            v_submission_reviews_created := v_submission_reviews_created + 1;
        END IF;

        -- Ensure we have a valid submission_review_id before proceeding
        IF v_submission_review_id IS NULL THEN
            SELECT id INTO v_submission_review_id
            FROM public.submission_reviews
            WHERE submission_id = v_submission_id AND rubric_id = p_rubric_id;
        END IF;

        IF v_submission_review_id IS NULL THEN
            RAISE EXCEPTION 'Failed to create or retrieve submission_review for submission_id % and rubric_id %', 
                v_submission_id, p_rubric_id
                USING ERRCODE = 'internal_error';
        END IF;

        -- Use UPSERT with ON CONFLICT to handle duplicates elegantly
        INSERT INTO public.review_assignments (
            assignee_profile_id,
            submission_id,
            submission_review_id,
            assignment_id,
            rubric_id,
            class_id,
            due_date,
            completed_at
        ) VALUES (
            v_assignee_profile_id,
            v_submission_id,
            v_submission_review_id,
            p_assignment_id,
            p_rubric_id,
            p_class_id,
            p_due_date,
            NULL
        )
        ON CONFLICT (assignee_profile_id, submission_review_id)
        DO UPDATE SET
            due_date = EXCLUDED.due_date
        RETURNING id, (xmax = 0) AS was_inserted INTO v_review_assignment;
        
        -- Track whether this was an insert or update
        IF v_review_assignment.was_inserted THEN
            v_assignments_created := v_assignments_created + 1;
        ELSE
            v_assignments_updated := v_assignments_updated + 1;
        END IF;

        -- Track IDs we just touched for later retargeting
        v_review_assignment_ids := array_append(v_review_assignment_ids, v_review_assignment.id);

        -- Handle rubric parts if specified
        IF v_has_specific_parts THEN
            -- Check if this part assignment already exists
            IF NOT EXISTS (
                SELECT 1 FROM public.review_assignment_rubric_parts
                WHERE review_assignment_id = v_review_assignment.id
                  AND rubric_part_id = v_rubric_part_id
            ) THEN
                INSERT INTO public.review_assignment_rubric_parts (
                    review_assignment_id,
                    rubric_part_id,
                    class_id
                ) VALUES (
                    v_review_assignment.id,
                    v_rubric_part_id,
                    p_class_id
                );
                
                v_parts_created := v_parts_created + 1;
            END IF;
        END IF;
    END LOOP;

    -- Phase 2: Retarget any assignments that point at inactive submissions
    -- to the currently active submission for the same assignment and
    -- student/group. Also ensure corresponding submission_reviews exist.
    WITH candidate_ra AS (
        SELECT ra.id AS review_assignment_id,
               ra.rubric_id,
               ra.submission_id AS old_submission_id,
               s_old.assignment_id,
               s_old.class_id,
               s_old.profile_id,
               s_old.assignment_group_id
        FROM public.review_assignments ra
        JOIN public.submissions s_old ON s_old.id = ra.submission_id
        WHERE ra.id = ANY (v_review_assignment_ids)
          AND s_old.is_active = false
    ), new_active AS (
        SELECT cra.review_assignment_id,
               cra.rubric_id,
               cra.old_submission_id,
               s_new.id AS new_submission_id
        FROM candidate_ra cra
        JOIN LATERAL (
            SELECT s2.id
            FROM public.submissions s2
            WHERE s2.assignment_id = cra.assignment_id
              AND s2.class_id = cra.class_id
              AND s2.is_active = true
              AND (
                    (cra.assignment_group_id IS NOT NULL AND s2.assignment_group_id = cra.assignment_group_id)
                 OR (cra.assignment_group_id IS NULL AND s2.assignment_group_id IS NULL AND s2.profile_id = cra.profile_id)
              )
            ORDER BY s2.created_at DESC
            LIMIT 1
        ) s_new ON TRUE
    ), ensured_sr AS (
        INSERT INTO public.submission_reviews (
            submission_id,
            rubric_id,
            class_id,
            name,
            total_score,
            total_autograde_score,
            tweak
        )
        SELECT na.new_submission_id,
               na.rubric_id,
               p_class_id,
               (SELECT name FROM public.rubrics WHERE id = na.rubric_id),
               0,
               0,
               0
        FROM new_active na
        ON CONFLICT (submission_id, rubric_id) DO UPDATE SET tweak = public.submission_reviews.tweak
        RETURNING submission_id, rubric_id, id
    ), updated_ra AS (
        SELECT ra.id AS review_assignment_id,
               na.new_submission_id,
               sr.id AS new_submission_review_id
        FROM new_active na
        JOIN public.review_assignments ra ON ra.id = na.review_assignment_id
        JOIN public.submission_reviews sr ON sr.submission_id = na.new_submission_id AND sr.rubric_id = ra.rubric_id
    )
    UPDATE public.review_assignments ra
    SET submission_id = ura.new_submission_id,
        submission_review_id = ura.new_submission_review_id,
        completed_at = NULL
    FROM updated_ra ura
    WHERE ra.id = ura.review_assignment_id;

    GET DIAGNOSTICS v_assignments_retargeted = ROW_COUNT;

    -- Build result
    v_result := jsonb_build_object(
        'success', true,
        'assignments_created', v_assignments_created,
        'assignments_updated', v_assignments_updated,
        'assignments_retargeted', v_assignments_retargeted,
        'parts_created', v_parts_created,
        'submission_reviews_created', v_submission_reviews_created,
        'total_processed', jsonb_array_length(p_draft_assignments)
    );

    RETURN v_result;

EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', SQLERRM,
            'error_code', SQLSTATE
        );
END;
$$;

-- Function to release all grading reviews for an assignment
CREATE OR REPLACE FUNCTION "public"."release_all_grading_reviews_for_assignment"("assignment_id" bigint)
RETURNS integer
LANGUAGE "plpgsql" 
SECURITY INVOKER
set statement_timeout to '3min'
AS $$
DECLARE
    affected_rows integer;
BEGIN

    -- Validate that the assignment exists
    IF NOT EXISTS (SELECT 1 FROM public.assignments WHERE id = assignment_id) THEN
        RAISE EXCEPTION 'Assignment with id % does not exist', assignment_id
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Update submission_reviews to released=true for all submissions of this assignment
    UPDATE public.submission_reviews 
    SET released = true
    FROM public.submissions s
    WHERE submission_reviews.submission_id = s.id
    AND s.assignment_id = release_all_grading_reviews_for_assignment.assignment_id
    AND submission_reviews.released = false
    AND s.is_active = true;
    
    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    
    RETURN affected_rows;
END;
$$;

-- Function to unrelease all grading reviews for an assignment  
CREATE OR REPLACE FUNCTION "public"."unrelease_all_grading_reviews_for_assignment"("assignment_id" bigint)
RETURNS integer
LANGUAGE "plpgsql"
SECURITY INVOKER
set statement_timeout to '3min'
AS $$
DECLARE
    affected_rows integer;
BEGIN
    -- Validate that the assignment exists
    IF NOT EXISTS (SELECT 1 FROM public.assignments WHERE id = assignment_id) THEN
        RAISE EXCEPTION 'Assignment with id % does not exist', assignment_id
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Update submission_reviews to released=false for all submissions of this assignment
    UPDATE public.submission_reviews 
    SET released = false
    FROM public.submissions s
    WHERE submission_reviews.submission_id = s.id
    AND s.assignment_id = unrelease_all_grading_reviews_for_assignment.assignment_id
    AND submission_reviews.released = true
    AND s.is_active = true;
    
    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    
    RETURN affected_rows;
END;
$$;

REVOKE ALL ON FUNCTION "public"."update_gradebook_rows_batch"("p_batch_updates" "jsonb"[]) TO "anon";
REVOKE ALL ON FUNCTION "public"."update_gradebook_rows_batch"("p_batch_updates" "jsonb"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_gradebook_rows_batch"("p_batch_updates" "jsonb"[]) TO "service_role";

-- Fix: Update create_gradebook_column_for_assignment to properly set gradebook_column_id
-- The trigger is AFTER INSERT, so we need to use UPDATE instead of modifying NEW
CREATE OR REPLACE FUNCTION public.create_gradebook_column_for_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
    gradebook_id bigint;
    new_col_id bigint;
BEGIN
    -- Get the gradebook_id for this class
    SELECT g.id INTO gradebook_id
    FROM public.gradebooks g
    WHERE g.class_id = NEW.class_id;

    -- Create the gradebook column
    INSERT INTO public.gradebook_columns (
        name,
        max_score,
        slug,
        class_id,
        gradebook_id,
        score_expression,
        released,
        dependencies
    ) VALUES (
        NEW.title,
        NEW.total_points,
        'assignment-' || NEW.slug,
        NEW.class_id,
        gradebook_id,
        'assignments("' || NEW.slug || '")',
        false,
        jsonb_build_object('assignments', jsonb_build_array(NEW.id))
    ) RETURNING id into new_col_id;

    -- Since this is an AFTER INSERT trigger, we need to UPDATE the assignments table
    -- to set the gradebook_column_id
    UPDATE public.assignments 
    SET gradebook_column_id = new_col_id
    WHERE id = NEW.id;

    RETURN NEW;
END;
$$;

-- Update trigger function to also recalculate when max_score changes
-- max_score is used in render_expression and normalization, so changes should trigger recalculation
CREATE OR REPLACE FUNCTION public.recalculate_gradebook_column_for_all_students_statement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  rows_to_enqueue jsonb[];
  row_rec RECORD;
BEGIN
  RAISE NOTICE '[recalculate_gradebook_column_for_all_students_statement] Trigger fired: operation=%, table=gradebook_columns', TG_OP;
  
  -- Collect all affected students into a JSONB array
  rows_to_enqueue := ARRAY[]::jsonb[];
  
  FOR row_rec IN (
    SELECT DISTINCT gcs.class_id, gcs.gradebook_id, gcs.student_id, gcs.is_private
    FROM new_table n
    JOIN old_table o ON n.id = o.id
    JOIN public.gradebook_column_students gcs ON gcs.gradebook_column_id = n.id
    WHERE n.score_expression IS DISTINCT FROM o.score_expression
       OR n.max_score IS DISTINCT FROM o.max_score
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
  
  RAISE NOTICE '[recalculate_gradebook_column_for_all_students_statement] Collected % rows to enqueue', array_length(rows_to_enqueue, 1);
  
  -- Batch enqueue all rows in a single call
  -- This will result in a single INSERT statement, triggering the broadcast trigger once
  IF array_length(rows_to_enqueue, 1) > 0 THEN
    RAISE NOTICE '[recalculate_gradebook_column_for_all_students_statement] Calling batch enqueue function';
    PERFORM public.enqueue_gradebook_row_recalculation_batch(rows_to_enqueue);
    RAISE NOTICE '[recalculate_gradebook_column_for_all_students_statement] Batch enqueue completed';
  ELSE
    RAISE NOTICE '[recalculate_gradebook_column_for_all_students_statement] No rows to enqueue';
  END IF;
  
  RETURN NULL;
END;
$$;

-- Back-fill gradebook_column_id for existing assignments
-- Only updates when there is exactly one matching gradebook column with the correct score_expression
UPDATE public.assignments a
SET gradebook_column_id = matched_cols.gradebook_column_id
FROM (
    SELECT 
        a.id AS assignment_id,
        gc.id AS gradebook_column_id,
        COUNT(*) OVER (PARTITION BY a.id) AS match_count
    FROM public.assignments a
    JOIN public.gradebook_columns gc 
        ON gc.class_id = a.class_id
        AND gc.score_expression = 'assignments("' || a.slug || '")'
    WHERE a.gradebook_column_id IS NULL
        AND a.slug IS NOT NULL
) matched_cols
WHERE a.id = matched_cols.assignment_id
    AND matched_cols.match_count = 1;
