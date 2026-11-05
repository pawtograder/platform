-- Bulk release / unrelease of code-walk reviews for one assignment.
--
-- 20260811130000_release_grading_review_only.sql scoped every bulk release path to the grading
-- review (`sr.id = s.grading_review_id`) so that "Release all" stopped publishing self-review and
-- meta-grading rounds. That fix is correct, but it also means a code-walk review (a
-- submission_reviews row whose rubric has review_round = 'code-walk') can only be released one
-- submission at a time from the submission page. An instructor with ~300 code walks had students
-- seeing N/A in the code-walk gradebook column.
--
-- These two RPCs release or unrelease the code-walk reviews of every active submission for an
-- assignment and nothing else:
--   * The UPDATE joins rubrics and keeps only review_round = 'code-walk' rubrics that belong to
--     the assignment, so grading, self-review and meta-grading rows are never touched.
--   * Release only flips COMPLETED code walks (completed_at IS NOT NULL). An incomplete code walk
--     has no final score yet; publishing it would show students a partial grade.
--   * Unrelease flips every released code walk, complete or not, so it fully reverses any release,
--     including one made per submission before the review was finished.
--
-- Each function is one UPDATE statement, so the statement-level `submission_review_release`
-- trigger (submissionreviewreleasecascade) sees every changed row in one transition table and
-- cascades `released` to the review's submission_comments, submission_file_comments and
-- submission_artifact_comments. The trigger only sets `submissions.released` for the grading
-- review, so releasing a code walk does not mark the submission itself released. Before
-- 20261020120100 the trigger also released the submission's hidden grader_result_tests for any
-- review; that migration limits the test cascade to the grading review, so releasing code walks
-- no longer exposes hidden autograder tests.
--
-- Authorization matches release_all_grading_reviews_for_assignment: SECURITY INVOKER, so the
-- UPDATE policy on submission_reviews ("Instructors full; graders limited on released complete
-- reviews") decides which rows the caller may flip. Rows the caller may not update are skipped
-- silently and are not counted. In effect:
--   * instructors can release and unrelease every code walk in their class;
--   * graders can release completed code walks (the policy's WITH CHECK allows released = true
--     only when completed_at IS NOT NULL) and can unrelease only released code walks that are
--     still incomplete, exactly as they could with a direct UPDATE;
--   * students match no rows on release (authorize_for_submission_review_writable requires
--     completed_at IS NULL, and release requires completed_at IS NOT NULL).
-- The grading status panel shows the buttons to instructors only.
--
-- Grants: 20261015120000 removed the default EXECUTE grant on new functions, so EXECUTE is granted
-- to authenticated explicitly. anon has no use for either function and gets nothing.

CREATE OR REPLACE FUNCTION public.release_code_walk_reviews_for_assignment(p_assignment_id bigint)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '3min'
AS $$
DECLARE
  affected_rows integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.assignments WHERE id = p_assignment_id) THEN
    RAISE EXCEPTION 'Assignment with id % does not exist', p_assignment_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE public.submission_reviews sr
  SET released = true
  FROM public.submissions s, public.rubrics r
  WHERE sr.submission_id = s.id
    AND sr.rubric_id = r.id
    AND r.review_round = 'code-walk'
    AND r.assignment_id = p_assignment_id
    AND s.assignment_id = p_assignment_id
    AND s.is_active = true
    AND sr.completed_at IS NOT NULL
    AND sr.released = false;

  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  RETURN affected_rows;
END;
$$;

CREATE OR REPLACE FUNCTION public.unrelease_code_walk_reviews_for_assignment(p_assignment_id bigint)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '3min'
AS $$
DECLARE
  affected_rows integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.assignments WHERE id = p_assignment_id) THEN
    RAISE EXCEPTION 'Assignment with id % does not exist', p_assignment_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE public.submission_reviews sr
  SET released = false
  FROM public.submissions s, public.rubrics r
  WHERE sr.submission_id = s.id
    AND sr.rubric_id = r.id
    AND r.review_round = 'code-walk'
    AND r.assignment_id = p_assignment_id
    AND s.assignment_id = p_assignment_id
    AND s.is_active = true
    AND sr.released = true;

  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  RETURN affected_rows;
END;
$$;

COMMENT ON FUNCTION public.release_code_walk_reviews_for_assignment(bigint) IS
  'Release every completed code-walk review (rubrics.review_round = code-walk) of the active submissions for an assignment. Never touches grading, self-review or meta-grading reviews. SECURITY INVOKER: RLS on submission_reviews limits which rows the caller can change. Returns the number of reviews released.';
COMMENT ON FUNCTION public.unrelease_code_walk_reviews_for_assignment(bigint) IS
  'Unrelease every released code-walk review (rubrics.review_round = code-walk) of the active submissions for an assignment. Never touches grading, self-review or meta-grading reviews. SECURITY INVOKER: RLS on submission_reviews limits which rows the caller can change. Returns the number of reviews unreleased.';

REVOKE ALL ON FUNCTION public.release_code_walk_reviews_for_assignment(bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.unrelease_code_walk_reviews_for_assignment(bigint) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.release_code_walk_reviews_for_assignment(bigint) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.unrelease_code_walk_reviews_for_assignment(bigint) TO authenticated, service_role;
