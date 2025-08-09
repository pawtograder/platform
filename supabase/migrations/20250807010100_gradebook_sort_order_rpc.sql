-- RPC helpers to reorder gradebook columns by swapping with adjacent neighbors.
-- These functions are SECURITY INVOKER so that RLS applies and caller permissions are honored.

CREATE OR REPLACE FUNCTION public.gradebook_column_move_left(p_column_id bigint)
RETURNS public.gradebook_columns
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_gradebook_id bigint;
  v_col record;
  v_max integer;
  v_new_order integer;
BEGIN
  -- Resolve gradebook_id first so we can take an advisory lock
  SELECT gradebook_id INTO v_gradebook_id
    FROM public.gradebook_columns
   WHERE id = p_column_id;

  IF v_gradebook_id IS NULL THEN
    RAISE EXCEPTION 'gradebook column % not found', p_column_id;
  END IF;

  -- Serialize per-gradebook to avoid race conditions
  PERFORM pg_advisory_xact_lock(v_gradebook_id);

  -- Load current state inside the lock
  SELECT id, gradebook_id, sort_order
    INTO v_col
    FROM public.gradebook_columns
   WHERE id = p_column_id
   FOR UPDATE;

  SELECT COALESCE(MAX(sort_order), -1) INTO v_max
    FROM public.gradebook_columns
   WHERE gradebook_id = v_gradebook_id;

  IF v_col.sort_order IS NULL THEN
    -- If unset, consider it at end; moving left puts it just before end
    v_new_order := GREATEST(0, v_max - 1);
  ELSE
    v_new_order := GREATEST(0, v_col.sort_order - 1);
  END IF;

  -- Nothing to do if already at 0
  IF v_col.sort_order IS NOT NULL AND v_col.sort_order <= 0 THEN
    SELECT * INTO v_col FROM public.gradebook_columns WHERE id = p_column_id;
    RETURN v_col;
  END IF;

  UPDATE public.gradebook_columns
     SET sort_order = v_new_order
   WHERE id = p_column_id;

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
  v_col record;
  v_max integer;
  v_new_order integer;
BEGIN
  -- Resolve gradebook_id first so we can take an advisory lock
  SELECT gradebook_id INTO v_gradebook_id
    FROM public.gradebook_columns
   WHERE id = p_column_id;

  IF v_gradebook_id IS NULL THEN
    RAISE EXCEPTION 'gradebook column % not found', p_column_id;
  END IF;

  -- Serialize per-gradebook to avoid race conditions
  PERFORM pg_advisory_xact_lock(v_gradebook_id);

  -- Load current state inside the lock
  SELECT id, gradebook_id, sort_order
    INTO v_col
    FROM public.gradebook_columns
   WHERE id = p_column_id
   FOR UPDATE;

  SELECT COALESCE(MAX(sort_order), -1) INTO v_max
    FROM public.gradebook_columns
   WHERE gradebook_id = v_gradebook_id;

  IF v_col.sort_order IS NULL THEN
    -- If unset, treat it as at end already
    v_new_order := v_max;
  ELSE
    v_new_order := LEAST(v_max, v_col.sort_order + 1);
  END IF;

  -- Nothing to do if already at end
  IF v_col.sort_order IS NOT NULL AND v_col.sort_order >= v_max THEN
    SELECT * INTO v_col FROM public.gradebook_columns WHERE id = p_column_id;
    RETURN v_col;
  END IF;

  UPDATE public.gradebook_columns
     SET sort_order = v_new_order
   WHERE id = p_column_id;

  SELECT * INTO v_col FROM public.gradebook_columns WHERE id = p_column_id;
  RETURN v_col;
END;
$$;


-- Allow API roles to call these RPCs (RLS still applies due to SECURITY INVOKER)
grant execute on function public.gradebook_column_move_left(bigint) to "anon", "authenticated", "service_role";
grant execute on function public.gradebook_column_move_right(bigint) to "anon", "authenticated", "service_role";

