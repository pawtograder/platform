ALTER TABLE assignments
  ADD COLUMN require_tokens_before_due_date boolean NOT NULL DEFAULT true;

-- Atomically checks token balance and inserts a due date extension in one transaction.
-- Returns jsonb: { success: true } or { success: false, error: "..." }
CREATE OR REPLACE FUNCTION apply_late_token_extension(
  p_assignment_id bigint,
  p_student_id uuid,
  p_assignment_group_id bigint,
  p_class_id bigint,
  p_creator_id uuid,
  p_hours integer,
  p_tokens_needed integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_max_tokens_assignment integer;
  v_max_tokens_class integer;
  v_tokens_used_assignment integer;
  v_tokens_used_class integer;
  v_tokens_remaining_assignment integer;
  v_tokens_remaining_class integer;
  v_tokens_remaining integer;
BEGIN
  -- Lock on (assignment, student/group) to prevent concurrent inserts from racing
  PERFORM pg_advisory_xact_lock(
    ('x' || substr(md5(p_assignment_id::text || '-' || COALESCE(p_assignment_group_id::text, p_student_id::text)), 1, 16))::bit(64)::bigint
  );

  -- Get per-assignment limit
  SELECT COALESCE(max_late_tokens, 0) INTO v_max_tokens_assignment
  FROM assignments WHERE id = p_assignment_id;

  -- Get per-class limit
  SELECT COALESCE(late_tokens_per_student, 0) INTO v_max_tokens_class
  FROM classes WHERE id = p_class_id;

  -- Count tokens already used on this assignment
  SELECT COALESCE(SUM(tokens_consumed), 0) INTO v_tokens_used_assignment
  FROM assignment_due_date_exceptions
  WHERE assignment_id = p_assignment_id
    AND (
      (p_assignment_group_id IS NOT NULL AND assignment_group_id = p_assignment_group_id)
      OR
      (p_assignment_group_id IS NULL AND student_id = p_student_id)
    );

  -- Count tokens already used across all assignments in this class
  SELECT COALESCE(SUM(tokens_consumed), 0) INTO v_tokens_used_class
  FROM assignment_due_date_exceptions
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

  -- Insert the extension
  INSERT INTO assignment_due_date_exceptions
    (assignment_id, student_id, assignment_group_id, class_id, creator_id, hours, minutes, tokens_consumed, note)
  VALUES
    (p_assignment_id, p_student_id, p_assignment_group_id, p_class_id, p_creator_id, p_hours, 0, p_tokens_needed, 'Auto-applied on late submission');

  RETURN jsonb_build_object('success', true);
END;
$$;
