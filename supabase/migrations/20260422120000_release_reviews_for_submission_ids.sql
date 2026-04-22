-- Bulk release/unrelease grading reviews for a subset of submissions (by submission id),
-- scoped to an assignment. Used by the instructor assignment table with row selection.

CREATE OR REPLACE FUNCTION public.release_grading_reviews_for_submissions(
  p_assignment_id bigint,
  p_submission_ids bigint[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  affected_rows integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.assignments WHERE id = p_assignment_id) THEN
    RAISE EXCEPTION 'Assignment with id % does not exist', p_assignment_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_submission_ids IS NULL OR cardinality(p_submission_ids) = 0 THEN
    RETURN 0;
  END IF;

  UPDATE public.submission_reviews sr
  SET released = true
  FROM public.submissions s
  WHERE sr.submission_id = s.id
    AND s.assignment_id = p_assignment_id
    AND s.is_active = true
    AND s.id = ANY (p_submission_ids)
    AND sr.released = false;

  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  RETURN affected_rows;
END;
$$;

CREATE OR REPLACE FUNCTION public.unrelease_grading_reviews_for_submissions(
  p_assignment_id bigint,
  p_submission_ids bigint[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  affected_rows integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.assignments WHERE id = p_assignment_id) THEN
    RAISE EXCEPTION 'Assignment with id % does not exist', p_assignment_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_submission_ids IS NULL OR cardinality(p_submission_ids) = 0 THEN
    RETURN 0;
  END IF;

  UPDATE public.submission_reviews sr
  SET released = false
  FROM public.submissions s
  WHERE sr.submission_id = s.id
    AND s.assignment_id = p_assignment_id
    AND s.is_active = true
    AND s.id = ANY (p_submission_ids)
    AND sr.released = true;

  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  RETURN affected_rows;
END;
$$;

GRANT EXECUTE ON FUNCTION public.release_grading_reviews_for_submissions(bigint, bigint[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unrelease_grading_reviews_for_submissions(bigint, bigint[]) TO authenticated;
