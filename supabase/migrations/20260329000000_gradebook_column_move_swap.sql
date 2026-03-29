-- Fix gradebook column move left/right: swap with the visually adjacent column
-- (ORDER BY sort_order ASC NULLS LAST, id ASC) instead of decrementing sort_order,
-- which collides with the uniqueness trigger and fails for sort_order = 0 (issue #531).

CREATE OR REPLACE FUNCTION public.gradebook_column_move_left(p_column_id bigint)
RETURNS public.gradebook_columns
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_gradebook_id bigint;
  v_col public.gradebook_columns;
  v_neighbor_id bigint;
  v_self_order integer;
  v_neighbor_order integer;
  v_max integer;
  v_base integer;
BEGIN
  SELECT gradebook_id INTO v_gradebook_id
    FROM public.gradebook_columns
   WHERE id = p_column_id;

  IF v_gradebook_id IS NULL THEN
    RAISE EXCEPTION 'gradebook column % not found', p_column_id;
  END IF;

  PERFORM pg_advisory_xact_lock(v_gradebook_id);

  SELECT * INTO v_col
    FROM public.gradebook_columns
   WHERE id = p_column_id
   FOR UPDATE;

  WITH ordered AS (
    SELECT
      id,
      sort_order,
      ROW_NUMBER() OVER (ORDER BY sort_order ASC NULLS LAST, id ASC) AS rn
    FROM public.gradebook_columns
    WHERE gradebook_id = v_gradebook_id
  )
  SELECT o2.id
    INTO v_neighbor_id
    FROM ordered o1
    JOIN ordered o2 ON o2.rn = o1.rn - 1
   WHERE o1.id = p_column_id;

  IF v_neighbor_id IS NULL THEN
    RETURN v_col;
  END IF;

  SELECT sort_order INTO v_neighbor_order
    FROM public.gradebook_columns
   WHERE id = v_neighbor_id
   FOR UPDATE;

  v_self_order := v_col.sort_order;

  PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_gradebook_id::text, 'true', true);
  BEGIN
    IF v_self_order IS NULL AND v_neighbor_order IS NULL THEN
      -- Swapping NULL with NULL is a no-op unless we assign distinct orders
      SELECT COALESCE(MAX(sort_order), -1) INTO v_max
        FROM public.gradebook_columns
       WHERE gradebook_id = v_gradebook_id;
      v_base := v_max + 1;
      -- After move left: self comes before neighbor (lower sort_order)
      UPDATE public.gradebook_columns SET sort_order = v_base WHERE id = p_column_id;
      UPDATE public.gradebook_columns SET sort_order = v_base + 1 WHERE id = v_neighbor_id;
    ELSE
      UPDATE public.gradebook_columns
         SET sort_order = v_neighbor_order
       WHERE id = p_column_id;

      UPDATE public.gradebook_columns
         SET sort_order = v_self_order
       WHERE id = v_neighbor_id;
    END IF;
  EXCEPTION
    WHEN OTHERS THEN
      PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_gradebook_id::text, 'false', true);
      RAISE;
  END;
  PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_gradebook_id::text, 'false', true);

  SELECT * INTO v_col FROM public.gradebook_columns WHERE id = p_column_id;
  RETURN v_col;
END;
$$;


CREATE OR REPLACE FUNCTION public.gradebook_column_move_right(p_column_id bigint)
RETURNS public.gradebook_columns
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_gradebook_id bigint;
  v_col public.gradebook_columns;
  v_neighbor_id bigint;
  v_self_order integer;
  v_neighbor_order integer;
  v_max integer;
  v_base integer;
BEGIN
  SELECT gradebook_id INTO v_gradebook_id
    FROM public.gradebook_columns
   WHERE id = p_column_id;

  IF v_gradebook_id IS NULL THEN
    RAISE EXCEPTION 'gradebook column % not found', p_column_id;
  END IF;

  PERFORM pg_advisory_xact_lock(v_gradebook_id);

  SELECT * INTO v_col
    FROM public.gradebook_columns
   WHERE id = p_column_id
   FOR UPDATE;

  WITH ordered AS (
    SELECT
      id,
      sort_order,
      ROW_NUMBER() OVER (ORDER BY sort_order ASC NULLS LAST, id ASC) AS rn
    FROM public.gradebook_columns
    WHERE gradebook_id = v_gradebook_id
  )
  SELECT o2.id
    INTO v_neighbor_id
    FROM ordered o1
    JOIN ordered o2 ON o2.rn = o1.rn + 1
   WHERE o1.id = p_column_id;

  IF v_neighbor_id IS NULL THEN
    RETURN v_col;
  END IF;

  SELECT sort_order INTO v_neighbor_order
    FROM public.gradebook_columns
   WHERE id = v_neighbor_id
   FOR UPDATE;

  v_self_order := v_col.sort_order;

  PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_gradebook_id::text, 'true', true);
  BEGIN
    IF v_self_order IS NULL AND v_neighbor_order IS NULL THEN
      SELECT COALESCE(MAX(sort_order), -1) INTO v_max
        FROM public.gradebook_columns
       WHERE gradebook_id = v_gradebook_id;
      v_base := v_max + 1;
      -- After move right: neighbor comes before self
      UPDATE public.gradebook_columns SET sort_order = v_base WHERE id = v_neighbor_id;
      UPDATE public.gradebook_columns SET sort_order = v_base + 1 WHERE id = p_column_id;
    ELSE
      UPDATE public.gradebook_columns
         SET sort_order = v_neighbor_order
       WHERE id = p_column_id;

      UPDATE public.gradebook_columns
         SET sort_order = v_self_order
       WHERE id = v_neighbor_id;
    END IF;
  EXCEPTION
    WHEN OTHERS THEN
      PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_gradebook_id::text, 'false', true);
      RAISE;
  END;
  PERFORM set_config('pawtograder.bypass_sort_order_trigger_' || v_gradebook_id::text, 'false', true);

  SELECT * INTO v_col FROM public.gradebook_columns WHERE id = p_column_id;
  RETURN v_col;
END;
$$;
