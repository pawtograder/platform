-- Make promoting a what-if grader result actually change the grade.
--
-- promote_whatif_grader_result (20260118130000_rerun_autograder_whatif_results.sql) deletes the
-- old official grader result, repoints the new one, and returns {'promoted': true} -- without ever
-- recomputing the submission review. Nothing else covers it either:
--
--   * grader_results lost its recompute trigger in 20250425172859 (dropped, never recreated), so
--     repointing the result fires nothing.
--   * grader_result_tests has only AFTER INSERT / AFTER UPDATE triggers (20251026154250), both
--     using REFERENCING NEW TABLE, so deleting the old result's tests fires nothing either.
--
-- The result is that submission_reviews.total_autograde_score keeps the value derived from the
-- grader result that was just deleted. The promoted score only appears if some unrelated edit
-- later happens to fire a recompute. This is the feature whose entire purpose is correcting a
-- wrong grade.
--
-- Two fixes here: an explicit recompute inside the RPC, and an AFTER DELETE safety net on
-- grader_result_tests so that removing autograder tests lowers the stored score no matter which
-- code path removed them.

-- ---------------------------------------------------------------------------
-- 1. promote_whatif_grader_result: repoint the tests, then recompute.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.promote_whatif_grader_result(
  p_grader_result_id bigint,
  p_class_id bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_user_role TEXT;
  v_target_submission_id bigint;
  v_existing_official_id bigint;
  v_grading_review_id bigint;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'User not authenticated'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT role INTO v_user_role
  FROM public.user_roles
  WHERE user_id = v_user_id
    AND class_id = p_class_id
    AND role IN ('instructor', 'grader')
    AND disabled = false
  LIMIT 1;

  IF v_user_role IS NULL THEN
    RAISE EXCEPTION 'User does not have permission to promote grader results for this class'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT rerun_for_submission_id
    INTO v_target_submission_id
  FROM public.grader_results
  WHERE id = p_grader_result_id
    AND class_id = p_class_id
  FOR UPDATE;

  IF v_target_submission_id IS NULL THEN
    RAISE EXCEPTION 'Grader result is not promotable'
      USING ERRCODE = 'data_exception';
  END IF;

  -- Remove existing official grader result if present
  SELECT id INTO v_existing_official_id
  FROM public.grader_results
  WHERE submission_id = v_target_submission_id
    AND id <> p_grader_result_id
  LIMIT 1
  FOR UPDATE;

  IF v_existing_official_id IS NOT NULL THEN
    DELETE FROM public.grader_result_output
    WHERE grader_result_id = v_existing_official_id;

    DELETE FROM public.grader_result_test_output
    WHERE grader_result_test_id IN (
      SELECT id FROM public.grader_result_tests
      WHERE grader_result_id = v_existing_official_id
    );

    DELETE FROM public.grader_result_tests
    WHERE grader_result_id = v_existing_official_id;

    DELETE FROM public.grader_results
    WHERE id = v_existing_official_id;

    DELETE FROM public.submission_artifacts
    WHERE submission_id = v_target_submission_id
      AND autograder_regression_test_id IS NULL;
  END IF;

  UPDATE public.grader_results
  SET submission_id = v_target_submission_id,
      rerun_for_submission_id = NULL
  WHERE id = p_grader_result_id;

  -- Repoint the promoted result's tests too. A what-if run is written with submission_id NULL on
  -- both the grader_results row and every grader_result_tests row, and promotion previously moved
  -- only the parent -- leaving the tests orphaned from the submission and therefore invisible to
  -- everything that joins grader_result_tests on submission_id.
  UPDATE public.grader_result_tests
  SET submission_id = v_target_submission_id
  WHERE grader_result_id = p_grader_result_id
    AND submission_id IS DISTINCT FROM v_target_submission_id;

  -- Recompute LAST, after both repoints. _submission_review_recompute_scores aggregates autograde
  -- points through grader_results.submission_id and only counts them when the review it is given
  -- is the submission's grading review, so the order matters. Called explicitly rather than left
  -- to a trigger: correctness here should not depend on a trigger side effect that has already
  -- been dropped once.
  SELECT s.grading_review_id
    INTO v_grading_review_id
  FROM public.submissions s
  WHERE s.id = v_target_submission_id;

  IF v_grading_review_id IS NOT NULL THEN
    PERFORM public._submission_review_recompute_scores(v_grading_review_id);
  END IF;

  RETURN jsonb_build_object(
    'promoted', true,
    'submission_id', v_target_submission_id,
    'grader_result_id', p_grader_result_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.promote_whatif_grader_result(bigint, bigint) TO authenticated;

COMMENT ON FUNCTION public.promote_whatif_grader_result(bigint, bigint) IS
  'Promote a what-if rerun to the official grader result: delete the previous official result, repoint the rerun (and its tests) at the submission, and recompute the grading review so the promoted score is actually reflected in the grade.';

-- ---------------------------------------------------------------------------
-- 2. AFTER DELETE safety net on grader_result_tests.
-- ---------------------------------------------------------------------------
--
-- The existing statement-level triggers use REFERENCING NEW TABLE, which DELETE cannot declare,
-- so submissionreviewrecompute_bulk_grader_tests() cannot be reused here -- it reads new_table and
-- would fail at runtime on a DELETE trigger. Hence a sibling function reading old_table.
--
-- Statement-level rather than row-level on purpose: one grader result routinely carries hundreds
-- of tests, and the recompute is heavy (multi-CTE, takes an advisory lock). Statement level
-- collapses that to one recompute per distinct submission.
--
-- RESET FILTER: one shape must NOT recompute -- a grader_results row that is still there and whose
-- tests are now ALL gone. That is a wholesale reset in flight, not a deletion, and recomputing it
-- corrupts the ordinary resubmit path. autograder-submit-feedback's resetExistingGraderResult
-- reuses the existing grader_results row and issues `DELETE FROM grader_result_tests WHERE
-- grader_result_id = ...` as its own PostgREST statement -- i.e. its own transaction -- before
-- inserting the replacement tests from a later statement. Firing in between COMMITS
-- total_autograde_score = 0 and a reduced total_score, and enqueues a gradebook recalculation off
-- that zero: students and the gradebook see a 0 until the re-insert lands, and permanently if any
-- intervening step throws (each one raises UserVisibleError). The existing AFTER INSERT trigger
-- already covers the replacement, so nothing is lost by staying out of the way.
--
-- The two shapes that DO recompute:
--   * parent gone -- an FK cascade deletes child rows after the parent row is already gone, so the
--     points really did vanish and nothing else is watching.
--   * parent alive with tests remaining -- a partial delete, where the score genuinely dropped.
--
-- promote_whatif_grader_result lands in the skipped shape (it deletes all of the old result's tests
-- one statement before deleting the result itself), which is correct: it now recomputes explicitly.

CREATE OR REPLACE FUNCTION public.submissionreviewrecompute_bulk_grader_tests_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_submission_id int8;
  v_submission_ids int8[];
  existing_submission_review_id int8;
  c_max_submissions constant int := 10;
BEGIN
  -- Recompute when the parent result is GONE (orphaned tests: the points really did vanish) or when
  -- the parent is still there WITH tests left (a partial delete: the score genuinely dropped). Skip
  -- the remaining shape -- a live parent whose tests are now ALL gone -- because that is a wholesale
  -- reset mid-flight. See the RESET FILTER note above.
  SELECT array_agg(DISTINCT s.submission_id ORDER BY s.submission_id)
  INTO v_submission_ids
  FROM (
    SELECT DISTINCT ot.submission_id, ot.grader_result_id
    FROM old_table ot
    WHERE ot.submission_id IS NOT NULL
  ) s
  WHERE NOT EXISTS (SELECT 1 FROM public.grader_results gr WHERE gr.id = s.grader_result_id)
     OR EXISTS (SELECT 1 FROM public.grader_result_tests t WHERE t.grader_result_id = s.grader_result_id);

  IF v_submission_ids IS NULL OR cardinality(v_submission_ids) = 0 THEN
    RETURN NULL;
  END IF;

  -- Bulk-teardown guard. Every path that survives the filter above and legitimately needs a
  -- recompute touches ONE grader result at a time. The paths that delete tests across many
  -- submissions at once are teardowns -- delete_assignment_with_all_data and
  -- cleanup_individual_assignment_repositories -- and they DO reach here, because their cascade
  -- removes the parent results too. They delete the submission_reviews moments later anyway, so
  -- without this cap a teardown would run a full recompute for every review in an assignment inside
  -- an already-long delete transaction, only to drop those reviews a few statements afterwards.
  IF cardinality(v_submission_ids) > c_max_submissions THEN
    RETURN NULL;
  END IF;

  -- Ascending submission id, so two concurrent statements take the per-review advisory locks in the
  -- same order and cannot deadlock against each other.
  FOREACH v_submission_id IN ARRAY v_submission_ids
  LOOP
    SELECT grading_review_id
    INTO existing_submission_review_id
    FROM public.submissions
    WHERE id = v_submission_id;

    IF existing_submission_review_id IS NULL THEN
      CONTINUE;
    END IF;

    PERFORM public._submission_review_recompute_scores(existing_submission_review_id);
  END LOOP;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.submissionreviewrecompute_bulk_grader_tests_delete() IS
  'Statement-level AFTER DELETE trigger on grader_result_tests: recompute affected grading reviews so removing autograder tests lowers the stored score. Skips the one shape that is a reset rather than a deletion -- a surviving grader_results row whose tests are now all gone -- because the AFTER INSERT trigger already covers the replacement and recomputing there commits a transient zero on the resubmit path. Also skips statements touching more than 10 distinct submissions, which are bulk teardowns that delete the reviews themselves.';

-- Parity with the sibling trigger function (20260322130000): a SECURITY DEFINER function should not
-- be executable by PUBLIC.
REVOKE ALL ON FUNCTION public.submissionreviewrecompute_bulk_grader_tests_delete() FROM PUBLIC;

DROP TRIGGER IF EXISTS grader_result_tests_recalculate_submission_review_delete ON public.grader_result_tests;

CREATE TRIGGER grader_result_tests_recalculate_submission_review_delete
AFTER DELETE ON public.grader_result_tests
REFERENCING OLD TABLE AS old_table
FOR EACH STATEMENT
EXECUTE FUNCTION public.submissionreviewrecompute_bulk_grader_tests_delete();

COMMENT ON TRIGGER grader_result_tests_recalculate_submission_review_delete ON public.grader_result_tests IS
  'Completes the insert/update/delete set: without this, deleting autograder tests left total_autograde_score at its pre-delete value.';
