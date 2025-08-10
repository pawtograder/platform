-- Auto-layout RPC to reorganize gradebook columns with topological sorting
-- First sorts alphabetically by slug, then respects gradebook_column dependencies

CREATE OR REPLACE FUNCTION public.gradebook_auto_layout(p_gradebook_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
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

  -- Check if user is authorized as class instructor
  IF NOT public.authorizeforclassinstructor(v_class_id) THEN
    RAISE EXCEPTION 'insufficient permissions: instructor access required for class %', v_class_id;
  END IF;

  -- Serialize per-gradebook to avoid race conditions
  PERFORM pg_advisory_xact_lock(p_gradebook_id);

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

-- Allow API roles to call this RPC (RLS still applies due to SECURITY INVOKER)
grant execute on function public.gradebook_auto_layout(bigint) to "anon", "authenticated", "service_role";
