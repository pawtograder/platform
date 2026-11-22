-- #1010: arranging the gradebook follows the manage_gradebook capability.
--
-- Why: creating, editing, ordering, importing and releasing gradebook columns, and naming or
-- deleting column groups and topics, were decided by "is this user an instructor in the class"
-- (authorizeforclassinstructor). No role could express a Head TA who runs the gradebook. Now one
-- capability decides, in the database and on the screen.
--
-- What:
--   1. New capability manage_gradebook, on the default instructor role of every class. It isn't on
--      the default grader role or on custom roles, so a Head TA gets it only when an instructor
--      turns it on.
--   2. gradebook_columns: the "instructors CRUD" FOR ALL policy becomes separate INSERT, UPDATE and
--      DELETE policies on manage_gradebook. A new or edited column must also sit on a gradebook of
--      its own class, so a role in one class can't put columns into another class's gradebook.
--      (group_id and topic_id already have composite foreign keys with gradebook_id.)
--   3. Deleting gradebook_column_students and gradebook_row_recalc_state rows, and renaming or
--      deleting gradebook_column_groups and gradebook_topics, need manage_gradebook. The column
--      grants stay: only a group's or topic's name can be updated directly.
--   4. These SECURITY DEFINER functions check manage_gradebook instead of the instructor check:
--        gradebook_require_instructor (the shared check of the group and topic RPCs: auto_layout,
--          columns_set_group, column_group_create, columns_auto_group(_preview), topic_create,
--          columns_set_topic, topic_set_standing, topics_suggest, topics_apply_suggestion). It keeps
--          its name so those ten functions don't have to be copied; the service role still passes.
--        gradebook_columns_reorder_inner and gradebook_auto_layout_inner (behind
--          gradebook_columns_reorder and gradebook_auto_layout)
--        import_gradebook_scores
--        release_instructor_only_gradebook_column
--      Each body is the latest one, with only the check changed. A caller without the capability
--      now gets 42501. Earlier checks are unchanged: "not authenticated" and "not found" keep their old
--      errors.
--
-- The old FOR ALL policy also allowed reading. Everyone who can hold manage_gradebook is an
-- instructor or a grader, and "everyone in class can view" lets both read every column, so SELECT
-- stays as it is. The same holds for the SELECT policies of the other four tables.
--
-- Instructors hold every capability, so nothing changes for them. Default graders, students and
-- admins hold no manage_gradebook, so they lose nothing they had. Only a grader on a custom role
-- with manage_gradebook gains these actions.
--
-- Not changed: everything graders do today. The cell UPDATE policies on gradebook_column_students
-- and gradebook_row_recalc_state, update_gradebook_column_student_with_recalc (overrides and
-- "Convert Missing to 0"), every SELECT policy, get_gradebook_records_for_all_students*, and
-- gradebook_column_move_left/right (SECURITY INVOKER, so the new UPDATE policy decides them). Also
-- gradebook_enable_column_groups: it turns on a course feature through merge_class_feature, which
-- is instructor-only, and only the instructor-only Feature flags page calls it.
-- (The next migration, 20261122110100, moves the cell policies and functions named here to
-- manage_gradebook as well.)
--
-- Safe to run again: every policy is dropped first, functions are replaced, and the inserts skip
-- rows that exist.

-- ---------------------------------------------------------------------------
-- 1. The capability, on every default instructor role
-- ---------------------------------------------------------------------------

INSERT INTO public.capabilities (name, description)
VALUES ('manage_gradebook', 'Create, edit, arrange, import and release gradebook columns')
ON CONFLICT (name) DO NOTHING;

-- New classes get it from seed_default_class_roles(), which gives the instructor role every
-- capability. Existing classes need it added here.
INSERT INTO public.role_capabilities (role_id, capability)
SELECT cr.id, 'manage_gradebook'
FROM public.class_roles cr
WHERE cr.default_for = 'instructor'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Writing gradebook_columns needs manage_gradebook
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "instructors CRUD" ON public.gradebook_columns;
DROP POLICY IF EXISTS "Gradebook managers can add columns" ON public.gradebook_columns;
DROP POLICY IF EXISTS "Gradebook managers can edit columns" ON public.gradebook_columns;
DROP POLICY IF EXISTS "Gradebook managers can delete columns" ON public.gradebook_columns;

CREATE POLICY "Gradebook managers can add columns" ON public.gradebook_columns
  FOR INSERT TO authenticated
  WITH CHECK (
    class_id IN (SELECT public.user_class_ids_with_capability('manage_gradebook'))
    AND EXISTS (
      SELECT 1 FROM public.gradebooks g
      WHERE g.id = gradebook_columns.gradebook_id AND g.class_id = gradebook_columns.class_id
    )
  );

CREATE POLICY "Gradebook managers can edit columns" ON public.gradebook_columns
  FOR UPDATE TO authenticated
  USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_gradebook')))
  WITH CHECK (
    class_id IN (SELECT public.user_class_ids_with_capability('manage_gradebook'))
    AND EXISTS (
      SELECT 1 FROM public.gradebooks g
      WHERE g.id = gradebook_columns.gradebook_id AND g.class_id = gradebook_columns.class_id
    )
  );

CREATE POLICY "Gradebook managers can delete columns" ON public.gradebook_columns
  FOR DELETE TO authenticated
  USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_gradebook')));

-- ---------------------------------------------------------------------------
-- 3. Deleting cells and row state, renaming and deleting groups and topics
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "instructors delete" ON public.gradebook_column_students;
DROP POLICY IF EXISTS "Gradebook managers can delete cells" ON public.gradebook_column_students;
CREATE POLICY "Gradebook managers can delete cells" ON public.gradebook_column_students
  FOR DELETE TO authenticated
  USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_gradebook')));

DROP POLICY IF EXISTS "instructors delete (row state)" ON public.gradebook_row_recalc_state;
DROP POLICY IF EXISTS "Gradebook managers can delete row state" ON public.gradebook_row_recalc_state;
CREATE POLICY "Gradebook managers can delete row state" ON public.gradebook_row_recalc_state
  FOR DELETE TO authenticated
  USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_gradebook')));

-- Groups and topics are created through the RPCs (no INSERT grant), and only their name can be
-- updated directly (column grant from 20261110120000 and 20261110130000), so a rename can't move
-- one to another class.
DROP POLICY IF EXISTS "instructors rename" ON public.gradebook_column_groups;
DROP POLICY IF EXISTS "instructors delete" ON public.gradebook_column_groups;
DROP POLICY IF EXISTS "Gradebook managers can rename groups" ON public.gradebook_column_groups;
DROP POLICY IF EXISTS "Gradebook managers can delete groups" ON public.gradebook_column_groups;
CREATE POLICY "Gradebook managers can rename groups" ON public.gradebook_column_groups
  FOR UPDATE TO authenticated
  USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_gradebook')))
  WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('manage_gradebook')));
CREATE POLICY "Gradebook managers can delete groups" ON public.gradebook_column_groups
  FOR DELETE TO authenticated
  USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_gradebook')));

DROP POLICY IF EXISTS "instructors rename" ON public.gradebook_topics;
DROP POLICY IF EXISTS "instructors delete" ON public.gradebook_topics;
DROP POLICY IF EXISTS "Gradebook managers can rename topics" ON public.gradebook_topics;
DROP POLICY IF EXISTS "Gradebook managers can delete topics" ON public.gradebook_topics;
CREATE POLICY "Gradebook managers can rename topics" ON public.gradebook_topics
  FOR UPDATE TO authenticated
  USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_gradebook')))
  WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('manage_gradebook')));
CREATE POLICY "Gradebook managers can delete topics" ON public.gradebook_topics
  FOR DELETE TO authenticated
  USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_gradebook')));

-- ---------------------------------------------------------------------------
-- 4. The functions check manage_gradebook
-- ---------------------------------------------------------------------------
-- CREATE OR REPLACE keeps each function's grants, so who may call it doesn't change.

-- 4a. The shared check of the group and topic RPCs (body from 20261110120000_gradebook_column_groups.sql).
--     The service role still passes; everyone else needs manage_gradebook in the gradebook's class.
CREATE OR REPLACE FUNCTION public.gradebook_require_instructor(p_gradebook_id bigint)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_class_id bigint;
BEGIN
  SELECT class_id INTO v_class_id FROM public.gradebooks WHERE id = p_gradebook_id;
  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'gradebook % not found', p_gradebook_id USING ERRCODE = 'P0002';
  END IF;
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND v_class_id NOT IN (SELECT public.user_class_ids_with_capability('manage_gradebook')) THEN
    RAISE EXCEPTION 'insufficient permissions: manage_gradebook required for class %', v_class_id
      USING ERRCODE = '42501';
  END IF;
  RETURN v_class_id;
END;
$$;

COMMENT ON FUNCTION public.gradebook_require_instructor(bigint) IS
  'Returns the gradebook''s class_id. Raises 42501 unless the caller is the service role or holds manage_gradebook in that class (#1010; the name predates the capability).';

-- 4b. Reordering columns. The body from 20260406120000_gradebook_columns_reorder_rpc.sql, renamed to
--     _inner in 20261110120000. Signed-in users reach it only through gradebook_columns_reorder.
CREATE OR REPLACE FUNCTION public.gradebook_columns_reorder_inner(p_ordered_column_ids bigint[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_gradebook_id bigint;
  v_class_id bigint;
  v_expected_count integer;
  v_payload_count integer;
  v_distinct_payload integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_payload_count := COALESCE(array_length(p_ordered_column_ids, 1), 0);

  IF v_payload_count = 0 THEN
    RETURN;
  END IF;

  SELECT COUNT(DISTINCT x) INTO v_distinct_payload
  FROM unnest(p_ordered_column_ids) AS x;

  IF v_distinct_payload <> v_payload_count THEN
    RAISE EXCEPTION 'Duplicate column IDs in reorder payload';
  END IF;

  SELECT gc.gradebook_id INTO v_gradebook_id
  FROM public.gradebook_columns AS gc
  WHERE gc.id = p_ordered_column_ids[1];

  IF v_gradebook_id IS NULL THEN
    RAISE EXCEPTION 'gradebook column % not found', p_ordered_column_ids[1];
  END IF;

  SELECT class_id INTO v_class_id
  FROM public.gradebooks
  WHERE id = v_gradebook_id;

  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'gradebook % not found', v_gradebook_id;
  END IF;

  IF v_class_id NOT IN (SELECT public.user_class_ids_with_capability('manage_gradebook')) THEN
    RAISE EXCEPTION 'insufficient permissions: manage_gradebook required for class %', v_class_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT COUNT(*)::integer INTO v_expected_count
  FROM public.gradebook_columns
  WHERE gradebook_id = v_gradebook_id;

  IF v_expected_count <> v_payload_count THEN
    RAISE EXCEPTION 'Payload count (%) does not match gradebook column count (%)', v_payload_count, v_expected_count;
  END IF;

  IF (
    SELECT COUNT(*)::integer
    FROM public.gradebook_columns
    WHERE gradebook_id = v_gradebook_id
      AND id = ANY (p_ordered_column_ids)
  ) <> v_payload_count THEN
    RAISE EXCEPTION 'One or more column IDs do not belong to this gradebook';
  END IF;

  -- Single-key form (bigint); the two-key form requires (integer, integer), not (int, bigint).
  -- Same namespace as gradebook_column_move_left/right — serializes all column-order updates per gradebook.
  PERFORM pg_advisory_xact_lock(v_gradebook_id);
  PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_gradebook_id::text, 'true', true);

  BEGIN
    UPDATE public.gradebook_columns AS gc
    SET sort_order = ord.new_order
    FROM (
      SELECT id, (ordinality - 1)::integer AS new_order
      FROM unnest(p_ordered_column_ids) WITH ORDINALITY AS t(id, ordinality)
    ) AS ord
    WHERE gc.id = ord.id
      AND gc.gradebook_id = v_gradebook_id;
  EXCEPTION
    WHEN OTHERS THEN
      PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_gradebook_id::text, 'false', true);
      RAISE;
  END;

  PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_gradebook_id::text, 'false', true);
END;
$$;

-- 4c. Auto-layout. The body from 20250811000001_fix_advisory_lock_types.sql, renamed to _inner in
--     20261110120000. Signed-in users reach it only through gradebook_auto_layout.
CREATE OR REPLACE FUNCTION public.gradebook_auto_layout_inner(p_gradebook_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
-- function body continues here
DECLARE
  v_col record;
  v_dep_col_id bigint;
  v_max_dep_order integer;
  v_new_order integer;
  v_processed_ids bigint[] := '{}';
  v_remaining_count integer;
  v_prev_remaining_count integer := -1;
  v_class_id bigint;
BEGIN
  -- Get the class_id for this gradebook and check authorization
  SELECT class_id INTO v_class_id
  FROM public.gradebooks
  WHERE id = p_gradebook_id;

  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'gradebook % not found', p_gradebook_id;
  END IF;

  -- Check that the user holds manage_gradebook in the class
  IF v_class_id NOT IN (SELECT public.user_class_ids_with_capability('manage_gradebook')) THEN
    RAISE EXCEPTION 'insufficient permissions: manage_gradebook required for class %', v_class_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Serialize per-gradebook to avoid race conditions
  -- Namespace 17031 chosen arbitrarily for "gradebook_auto_layout"
  -- FIXED: Use two-integer version of pg_advisory_xact_lock
  PERFORM pg_advisory_xact_lock(17031, p_gradebook_id::int);
  -- Temporarily bypass the sort order trigger for this specific gradebook during bulk operations
  -- This avoids ACCESS EXCLUSIVE locks that would block concurrent operations on other gradebooks
  PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || p_gradebook_id::text, 'true', true);

  BEGIN
    -- Step 1: Initial alphanumeric sort by slug (lab-2 before lab-10)
    -- Start with a clean 0-based sequence
    WITH ordered_cols AS (
      SELECT id, (ROW_NUMBER() OVER (ORDER BY 
        -- Natural sort: extract text and numeric parts separately
        regexp_replace(slug, '\d+', '', 'g'), -- text part first
        COALESCE(
          (regexp_match(slug, '\d+'))[1]::integer, -- first number found
          0
        ),
        slug -- fallback to original slug for ties
      ) - 1) AS temp_sort_order
      FROM public.gradebook_columns
      WHERE gradebook_id = p_gradebook_id
    )
    UPDATE public.gradebook_columns gc
    SET sort_order = oc.temp_sort_order
    FROM ordered_cols oc
    WHERE gc.id = oc.id;

    -- Step 2: Topological sort to respect gradebook_column dependencies
    -- Process columns until all are handled or we detect a cycle
    LOOP
      SELECT COUNT(*) INTO v_remaining_count
      FROM public.gradebook_columns
      WHERE gradebook_id = p_gradebook_id
        AND id <> ALL(v_processed_ids);

      -- Exit if no more columns to process
      EXIT WHEN v_remaining_count = 0;

      -- Detect infinite loop (circular dependencies)
      IF v_remaining_count = v_prev_remaining_count THEN
        RAISE WARNING 'Circular dependency detected in gradebook %. Stopping topological sort.', p_gradebook_id;
        EXIT;
      END IF;
      v_prev_remaining_count := v_remaining_count;

      -- Process columns that either have no gradebook_column dependencies 
      -- or all their dependencies are already processed
      FOR v_col IN
        SELECT id, slug, dependencies, sort_order
        FROM public.gradebook_columns
        WHERE gradebook_id = p_gradebook_id
          AND id <> ALL(v_processed_ids)
        ORDER BY sort_order NULLS LAST, id
      LOOP
        -- Check if this column has gradebook_column dependencies
        IF v_col.dependencies ? 'gradebook_columns' AND 
           jsonb_array_length(v_col.dependencies->'gradebook_columns') > 0 THEN
          
          -- Find the maximum sort_order among its dependencies that are already processed
          v_max_dep_order := -1;
          
          -- Check each dependency
          FOR v_dep_col_id IN
            SELECT jsonb_array_elements_text(v_col.dependencies->'gradebook_columns')::bigint
          LOOP
            -- Only consider dependencies that are in the same gradebook and already processed
            IF v_dep_col_id = ANY(v_processed_ids) THEN
              SELECT sort_order INTO v_new_order
              FROM public.gradebook_columns
              WHERE id = v_dep_col_id AND gradebook_id = p_gradebook_id;
              
              IF v_new_order IS NOT NULL AND v_new_order > v_max_dep_order THEN
                v_max_dep_order := v_new_order;
              END IF;
            END IF;
          END LOOP;
          
          -- Check if all dependencies are processed
          IF EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(v_col.dependencies->'gradebook_columns') AS dep_id
            WHERE dep_id::bigint <> ALL(v_processed_ids)
              AND EXISTS (
                SELECT 1 FROM public.gradebook_columns 
                WHERE id = dep_id::bigint AND gradebook_id = p_gradebook_id
              )
          ) THEN
            -- Not all dependencies processed yet, skip this column for now
            CONTINUE;
          END IF;
          
          -- Place this column immediately after its highest dependency
          IF v_max_dep_order >= 0 THEN
            v_new_order := v_max_dep_order + 1;
            
            -- The AFTER trigger should handle conflicts by shifting other columns
            -- when multiple columns try to occupy the same position
            UPDATE public.gradebook_columns
            SET sort_order = v_new_order
            WHERE id = v_col.id;
          END IF;
        END IF;
        
        -- Mark this column as processed
        v_processed_ids := array_append(v_processed_ids, v_col.id);
      END LOOP;
    END LOOP;

    -- Final pass: compact to contiguous 0-based sequence (0,1,2,3...) without gaps
    -- Process in dependency order to maintain relationships
    WITH ordered_final AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY sort_order, id) - 1 AS final_sort_order
      FROM public.gradebook_columns
      WHERE gradebook_id = p_gradebook_id
    )
    UPDATE public.gradebook_columns gc
    SET sort_order = of.final_sort_order
    FROM ordered_final of
    WHERE gc.id = of.id;

  EXCEPTION
    WHEN OTHERS THEN
      -- Always reset the bypass setting for this gradebook, even if there was an error
      PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || p_gradebook_id::text, 'false', true);
      RAISE;
  END;

  -- Reset the bypass setting to re-enable normal trigger enforcement for this gradebook
  PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || p_gradebook_id::text, 'false', true);

END;
$$;

-- 4d. Importing scores. The body from 20251124233922_extend-more-rpc-timeouts.sql. A NULL class is
--     refused as before (NOT IN on NULL would not be).
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

  -- Authorization: only people with manage_gradebook in the class may import
  IF p_class_id IS NULL OR p_class_id NOT IN (SELECT public.user_class_ids_with_capability('manage_gradebook')) THEN
    RAISE EXCEPTION 'Access denied: manage_gradebook is required to import grades for class %', p_class_id
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

-- 4e. Releasing an instructor-only column. The body from
--     20261015120000_lock_down_security_definer_functions.sql (section 4d).
CREATE OR REPLACE FUNCTION public.release_instructor_only_gradebook_column(p_column_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_class_id bigint;
BEGIN
  SELECT class_id INTO v_class_id
  FROM public.gradebook_columns
  WHERE id = p_column_id;

  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'Column % does not exist', p_column_id;
  END IF;

  IF v_class_id NOT IN (SELECT public.user_class_ids_with_capability('manage_gradebook')) THEN
    RAISE EXCEPTION 'Access denied: insufficient permissions for class %', v_class_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Step 1: Release while still instructor_only — triggers snapshot sync
  UPDATE public.gradebook_columns
  SET released = true
  WHERE id = p_column_id AND instructor_only = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Column % is not an instructor-only column', p_column_id;
  END IF;

  -- Step 2: Clear instructor_only — column now behaves normally; triggers recalc
  UPDATE public.gradebook_columns
  SET instructor_only = false
  WHERE id = p_column_id;
END;
$function$;
