
CREATE OR REPLACE FUNCTION public.import_gradebook_scores(
  p_class_id bigint,
  p_updates jsonb
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invalid_column_id bigint;
  rows_to_enqueue_jsonb jsonb;
BEGIN
  set statement_timeout to '3min';

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