-- Atomic single-key update for assign-to-student rubric UI (avoids read-modify-write races).
CREATE OR REPLACE FUNCTION public.patch_submission_review_rubric_part_assignment(
  p_submission_review_id bigint,
  p_rubric_part_id bigint,
  p_student_profile_id uuid
)
RETURNS public.submission_reviews
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_row public.submission_reviews;
BEGIN
  UPDATE public.submission_reviews sr
  SET rubric_part_student_assignments = jsonb_set(
    COALESCE(sr.rubric_part_student_assignments, '{}'::jsonb),
    ARRAY[p_rubric_part_id::text],
    CASE
      WHEN p_student_profile_id IS NULL THEN 'null'::jsonb
      ELSE to_jsonb(p_student_profile_id::text)
    END,
    true
  )
  WHERE sr.id = p_submission_review_id
  RETURNING * INTO STRICT v_row;

  RETURN v_row;
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    RAISE EXCEPTION 'submission_review % not found', p_submission_review_id;
END;
$$;

COMMENT ON FUNCTION public.patch_submission_review_rubric_part_assignment(bigint, bigint, uuid) IS
  'Sets one key in rubric_part_student_assignments via jsonb_set (atomic merge in the database).';

GRANT EXECUTE ON FUNCTION public.patch_submission_review_rubric_part_assignment(bigint, bigint, uuid) TO authenticated;
