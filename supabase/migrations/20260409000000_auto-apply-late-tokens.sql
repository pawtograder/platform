ALTER TABLE assignments
  ADD COLUMN require_tokens_before_due_date boolean NOT NULL DEFAULT true;

-- Idempotency key for auto-applied extensions (SHA of the push that triggered it)
-- Partial unique index so manual/gifted extensions (null key) are unaffected
ALTER TABLE public.assignment_due_date_exceptions
  ADD COLUMN auto_apply_idempotency_key text;

CREATE UNIQUE INDEX assignment_due_date_exceptions_idempotency_key_idx
  ON public.assignment_due_date_exceptions (auto_apply_idempotency_key)
  WHERE auto_apply_idempotency_key IS NOT NULL;

-- Atomically checks token balance and inserts a due date extension in one transaction.
-- Returns jsonb: { success: true } or
-- { success: false, tokens_needed: integer, tokens_remaining: integer }
CREATE OR REPLACE FUNCTION public.apply_late_token_extension(
  p_assignment_id bigint,
  p_student_id uuid,
  p_assignment_group_id bigint,
  p_class_id bigint,
  p_creator_id uuid,
  p_hours integer,
  p_tokens_needed integer,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_max_tokens_assignment integer;
  v_max_tokens_class integer;
  v_tokens_used_assignment integer;
  v_tokens_used_class integer;
  v_tokens_remaining_assignment integer;
  v_tokens_remaining_class integer;
  v_tokens_remaining integer;
  v_rows_inserted integer;
BEGIN
  -- If this exact push already has an extension, return success immediately (idempotent retry)
  IF EXISTS (
    SELECT 1 FROM public.assignment_due_date_exceptions
    WHERE auto_apply_idempotency_key = p_idempotency_key
  ) THEN
    RETURN jsonb_build_object('success', true);
  END IF;

  IF p_tokens_needed <= 0 OR p_hours <= 0 THEN
    RAISE EXCEPTION 'p_tokens_needed and p_hours must be positive, got % and %', p_tokens_needed, p_hours;
  END IF;

  -- Lock on (class, student/group) to prevent concurrent submissions from the same
  -- student across different assignments from racing on the class-wide balance
  PERFORM pg_advisory_xact_lock(
    ('x' || substr(md5(p_class_id::text || '-' || COALESCE(p_assignment_group_id::text, p_student_id::text)), 1, 16))::bit(64)::bigint
  );

  -- Load limits from the same assignment/class pair so the RPC cannot mix contexts
  SELECT
    COALESCE(a.max_late_tokens, 0),
    COALESCE(c.late_tokens_per_student, 0)
  INTO v_max_tokens_assignment, v_max_tokens_class
  FROM public.assignments a
  JOIN public.classes c
    ON c.id = a.class_id
  WHERE a.id = p_assignment_id
    AND a.class_id = p_class_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Assignment % does not belong to class %', p_assignment_id, p_class_id;
  END IF;

  -- Count tokens already used on this assignment
  SELECT COALESCE(SUM(tokens_consumed), 0) INTO v_tokens_used_assignment
  FROM public.assignment_due_date_exceptions
  WHERE assignment_id = p_assignment_id
    AND (
      (p_assignment_group_id IS NOT NULL AND assignment_group_id = p_assignment_group_id)
      OR
      (p_assignment_group_id IS NULL AND student_id = p_student_id)
    );

  -- Count tokens already used across all assignments in this class
  SELECT COALESCE(SUM(tokens_consumed), 0) INTO v_tokens_used_class
  FROM public.assignment_due_date_exceptions
  WHERE class_id = p_class_id
    AND (
      (p_assignment_group_id IS NOT NULL AND assignment_group_id = p_assignment_group_id)
      OR
      (p_assignment_group_id IS NULL AND student_id = p_student_id)
    );

  v_tokens_remaining_assignment := v_max_tokens_assignment - v_tokens_used_assignment;
  v_tokens_remaining_class := v_max_tokens_class - v_tokens_used_class;
  v_tokens_remaining := LEAST(v_tokens_remaining_assignment, v_tokens_remaining_class);

  IF p_tokens_needed > v_tokens_remaining THEN
    RETURN jsonb_build_object(
      'success', false,
      'tokens_needed', p_tokens_needed,
      'tokens_remaining', GREATEST(0, v_tokens_remaining)
    );
  END IF;

  -- Insert the extension with idempotency key so retries are safe
  INSERT INTO public.assignment_due_date_exceptions
    (assignment_id, student_id, assignment_group_id, class_id, creator_id, hours, minutes, tokens_consumed, note, auto_apply_idempotency_key)
  VALUES
    (p_assignment_id, p_student_id, p_assignment_group_id, p_class_id, p_creator_id, p_hours, 0, p_tokens_needed, 'Auto-applied on late submission', p_idempotency_key)
  ON CONFLICT (auto_apply_idempotency_key) WHERE auto_apply_idempotency_key IS NOT NULL
  DO NOTHING;

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_late_token_extension(bigint, uuid, bigint, bigint, uuid, integer, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_late_token_extension(bigint, uuid, bigint, bigint, uuid, integer, integer, text) TO service_role;
