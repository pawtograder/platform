-- Every bulk release/unrelease path flipped `released` on EVERY submission_reviews row that
-- shared the submission id, not just the grading review. submission_reviews is one row per
-- (submission_id, rubric_id), so a submission that also carries a self-review or a meta-grading
-- round had those rounds released too — exposing meta-grader comments and self-review rubric
-- checks to students. Scope the UPDATE to the grading review (`sr.id = s.grading_review_id`, the
-- same predicate the release cascade trigger uses to recognize the grading review) so only
-- grading is released. Release semantics are grading-review-only everywhere.
--
-- This covers both bulk paths:
--   * per-submission (instructor assignment table, row selection) —
--     release/unrelease_grading_reviews_for_submissions, superseding
--     20260422120000_release_reviews_for_submission_ids.sql
--   * assignment-wide ("Release all" / "Unrelease all" on the grading status panel) —
--     release/unrelease_all_grading_reviews_for_assignment, superseding
--     20251124233922_extend-more-rpc-timeouts.sql. Same exposure, bigger blast radius.
--
-- The narrower UPDATE still touches the grading review row, so the statement-level
-- `submission_review_release` trigger (submissionreviewreleasecascade) fires as before and keeps
-- cascading to submission comments, grader_result_tests, and `submissions.released`.

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
    AND sr.id = s.grading_review_id
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
    AND sr.id = s.grading_review_id
    AND s.assignment_id = p_assignment_id
    AND s.is_active = true
    AND s.id = ANY (p_submission_ids)
    AND sr.released = true;

  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  RETURN affected_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.release_grading_reviews_for_submissions(bigint, bigint[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.unrelease_grading_reviews_for_submissions(bigint, bigint[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.release_grading_reviews_for_submissions(bigint, bigint[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unrelease_grading_reviews_for_submissions(bigint, bigint[]) TO authenticated;

-- Assignment-wide "Release all" / "Unrelease all". Same grading-review scoping as above.
-- The parameter name and the `SET statement_timeout` clause are carried over verbatim: the name is
-- part of the RPC's public signature, and the 3min timeout is what 20251124233922 was added for
-- (these UPDATEs span a whole assignment). Scoping to the grading review only shrinks the row
-- count, so the timeout stays as-is.

CREATE OR REPLACE FUNCTION public.release_all_grading_reviews_for_assignment(assignment_id bigint)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET statement_timeout TO '3min'
AS $$
DECLARE
    affected_rows integer;
BEGIN

    -- Validate that the assignment exists
    IF NOT EXISTS (SELECT 1 FROM public.assignments WHERE id = assignment_id) THEN
        RAISE EXCEPTION 'Assignment with id % does not exist', assignment_id
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Release the GRADING review of every active submission for this assignment. Self-review and
    -- meta-grading rounds are left alone: releasing them exposes meta-grader comments to students.
    UPDATE public.submission_reviews
    SET released = true
    FROM public.submissions s
    WHERE submission_reviews.submission_id = s.id
    AND submission_reviews.id = s.grading_review_id
    AND s.assignment_id = release_all_grading_reviews_for_assignment.assignment_id
    AND submission_reviews.released = false
    AND s.is_active = true;

    GET DIAGNOSTICS affected_rows = ROW_COUNT;

    RETURN affected_rows;
END;
$$;

CREATE OR REPLACE FUNCTION public.unrelease_all_grading_reviews_for_assignment(assignment_id bigint)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET statement_timeout TO '3min'
AS $$
DECLARE
    affected_rows integer;
BEGIN
    -- Validate that the assignment exists
    IF NOT EXISTS (SELECT 1 FROM public.assignments WHERE id = assignment_id) THEN
        RAISE EXCEPTION 'Assignment with id % does not exist', assignment_id
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Unrelease the GRADING review only, mirroring the release direction above.
    UPDATE public.submission_reviews
    SET released = false
    FROM public.submissions s
    WHERE submission_reviews.submission_id = s.id
    AND submission_reviews.id = s.grading_review_id
    AND s.assignment_id = unrelease_all_grading_reviews_for_assignment.assignment_id
    AND submission_reviews.released = true
    AND s.is_active = true;

    GET DIAGNOSTICS affected_rows = ROW_COUNT;

    RETURN affected_rows;
END;
$$;

-- Grant posture carried over unchanged from 20250815164409/20251014154241: EXECUTE to
-- authenticated, and the pre-existing PUBLIC EXECUTE left as it is. Both are SECURITY INVOKER, so
-- RLS on submission_reviews still decides who may actually flip a row; narrowing PUBLIC here would
-- be a separate access-control change, not part of this fix.
GRANT EXECUTE ON FUNCTION public.release_all_grading_reviews_for_assignment(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unrelease_all_grading_reviews_for_assignment(bigint) TO authenticated;
