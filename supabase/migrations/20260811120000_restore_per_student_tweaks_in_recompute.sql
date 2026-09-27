-- Restore per_student_tweaks to the score recompute.
--
-- _submission_review_recompute_scores is defined by three migrations. The most recent
-- (20260604000000_floor-submission-review-score-at-zero.sql) states in its own header that it
-- diffs against 20260322130000 -- which predates 20260329120001, the migration that added
-- per_student_tweaks. So the June 4 redefinition silently reverted the feature.
--
-- The failure was invisible: the column is still written by the UI, and the
-- submission_reviews_recompute_split_metadata trigger still fires an AFTER UPDATE OF
-- ... per_student_tweaks recompute. A recompute really does run. It just computes a total that
-- omits the tweak, so the UI looks responsive and the grade looks settled.
--
-- This re-merges the per_student_tweaks logic from 20260329120001 into the June 4 definition,
-- keeping both greatest(..., 0) floors, and backfills the affected rows.
--
-- FLOOR ORDER: the per-student floor stays the LAST arithmetic step, after v_extra is added.
-- The floor exists so that no negative value is ever stored -- a negative total crashed the grade
-- ledger UI, which is what 20260604000000 was written to fix. Flooring before the tweak would let
-- a negative per-student tweak store a negative line again and reintroduce that crash. This also
-- matches how the shared `tweak` is already handled (folded in before the cap and floor).
-- Consequence, intended: a per-student tweak cannot drive a line below 0.

CREATE OR REPLACE FUNCTION public._submission_review_recompute_scores(p_submission_review_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  calculated_score numeric;
  calculated_autograde_score numeric;
  v_submission_id bigint;
  is_grading_review boolean;
  should_cap boolean;
  assignment_total_points numeric;
  current_tweak numeric;
  individual_scores_result jsonb;
  shared_hand_score numeric;
  per_student_totals jsonb;
  v_has_split_rubric boolean;
  v_targets uuid[];
  v_student uuid;
  v_ind numeric;
  v_line numeric;
  shared_base numeric;
  v_shared_base_stored numeric;
  v_per_student_tweaks jsonb;
  v_extra numeric;
  v_sum_per_student_tweaks numeric;
  v_tweak_value numeric;
  r_tweak record;
BEGIN
  IF p_submission_review_id IS NULL THEN
    RETURN;
  END IF;

  SELECT submission_id INTO v_submission_id
  FROM public.submission_reviews
  WHERE id = p_submission_review_id;

  IF v_submission_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(p_submission_review_id);

  SELECT EXISTS (
    SELECT 1 FROM public.submissions
    WHERE grading_review_id = p_submission_review_id
  ) INTO is_grading_review;

  calculated_autograde_score := 0;
  IF is_grading_review THEN
    SELECT coalesce(sum(t.score), 0) INTO calculated_autograde_score
    FROM public.grader_results r
    INNER JOIN public.grader_result_tests t ON t.grader_result_id = r.id
    WHERE r.submission_id = v_submission_id
      AND r.rerun_for_submission_id IS NULL
      AND r.autograder_regression_test IS NULL;
  END IF;

  SELECT sum(score) INTO calculated_score FROM (
    SELECT c.id, c.name,
      CASE
        WHEN c.is_deduction_only THEN greatest(-coalesce(sum(comments.points), 0), -c.total_points)
        WHEN c.is_additive THEN least(coalesce(sum(comments.points), 0), c.total_points)
        ELSE greatest(c.total_points - coalesce(sum(comments.points), 0), 0)
      END AS score
    FROM public.submission_reviews sr
    INNER JOIN public.rubric_criteria c ON c.rubric_id = sr.rubric_id
    INNER JOIN public.rubric_checks ch ON ch.rubric_criteria_id = c.id
    LEFT JOIN (
      SELECT sum(sc.points) AS points, sc.rubric_check_id FROM public.submission_comments sc
      WHERE sc.submission_review_id = p_submission_review_id AND sc.deleted_at IS NULL AND sc.points IS NOT NULL
      GROUP BY sc.rubric_check_id
      UNION ALL
      SELECT sum(sfc.points) AS points, sfc.rubric_check_id FROM public.submission_file_comments sfc
      WHERE sfc.submission_review_id = p_submission_review_id AND sfc.deleted_at IS NULL AND sfc.points IS NOT NULL
      GROUP BY sfc.rubric_check_id
      UNION ALL
      SELECT sum(sac.points) AS points, sac.rubric_check_id FROM public.submission_artifact_comments sac
      WHERE sac.submission_review_id = p_submission_review_id AND sac.deleted_at IS NULL AND sac.points IS NOT NULL
      GROUP BY sac.rubric_check_id
    ) AS comments ON comments.rubric_check_id = ch.id
    WHERE sr.id = p_submission_review_id
    GROUP BY c.id
  ) AS combo;

  IF calculated_score IS NULL THEN
    calculated_score := 0;
  END IF;
  IF calculated_autograde_score IS NULL THEN
    calculated_autograde_score := 0;
  END IF;

  SELECT coalesce(tweak, 0), per_student_tweaks
  INTO current_tweak, v_per_student_tweaks
  FROM public.submission_reviews
  WHERE id = p_submission_review_id;

  -- total_score carries the whole group's tweaks, so sum every entry in the map.
  -- Values may be JSON numbers or strings (the UI writes numbers; hand-edited rows
  -- have shipped both), hence the #>> '{}' read. Un-castable junk is skipped rather
  -- than aborting the recompute for the whole review -- one bad map entry must not
  -- leave every score on the submission stale.
  --
  -- Deliberately sums EVERY key, including profile ids that are no longer grade
  -- targets, whereas per_student_grading_totals below only covers
  -- _grade_targets_for_submission. That asymmetry is the pre-existing behavior from
  -- 20260329120001; changing it is a grading change, not a restore.
  --
  -- NaN and out-of-range are handled explicitly, because neither is an
  -- invalid_text_representation. `'NaN'::numeric` is a VALID cast, and Postgres orders NaN above
  -- every other numeric -- so a single "NaN" entry made calculated_score NaN, and
  -- `least(NaN, assignment_total_points)` then returned the assignment total, silently awarding full
  -- marks under cap_score_to_assignment_points. `'1e999999'::numeric` raises 22003
  -- numeric_value_out_of_range, which an invalid_text_representation-only handler does not catch, so
  -- it escaped the trigger and aborted the caller's whole grading transaction -- the opposite of
  -- "skipped rather than aborting the recompute".
  v_sum_per_student_tweaks := 0;
  IF v_per_student_tweaks IS NOT NULL AND jsonb_typeof(v_per_student_tweaks) = 'object' THEN
    FOR r_tweak IN SELECT value FROM jsonb_each(v_per_student_tweaks) AS e(k, value)
    LOOP
      BEGIN
        v_tweak_value := coalesce((r_tweak.value #>> '{}')::numeric, 0);
        -- NaN AND the two infinities. Postgres accepts 'Infinity'/'-Infinity' as valid numeric
        -- input, so neither raises invalid_text_representation nor equals NaN -- they slipped
        -- through the handler below and reached the score. `least(Infinity, assignment_total_points)`
        -- then returns the assignment total, silently awarding full marks under
        -- cap_score_to_assignment_points, which is exactly the NaN failure this guard was written
        -- for. Uncapped, an infinite total_score is stored instead.
        IF v_tweak_value = 'NaN'::numeric
           OR v_tweak_value = 'Infinity'::numeric
           OR v_tweak_value = '-Infinity'::numeric THEN
          v_tweak_value := 0;
        END IF;
        v_sum_per_student_tweaks := v_sum_per_student_tweaks + v_tweak_value;
      EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        NULL;
      END;
    END LOOP;
  END IF;

  SELECT r.cap_score_to_assignment_points INTO should_cap
  FROM public.rubrics r
  INNER JOIN public.submission_reviews sr ON sr.rubric_id = r.id
  WHERE sr.id = p_submission_review_id;

  calculated_score := calculated_score + calculated_autograde_score + current_tweak + v_sum_per_student_tweaks;

  IF should_cap THEN
    SELECT a.total_points INTO assignment_total_points
    FROM public.assignments a
    INNER JOIN public.submissions s ON s.assignment_id = a.id
    WHERE s.id = v_submission_id;

    IF assignment_total_points IS NOT NULL THEN
      calculated_score := least(calculated_score, assignment_total_points);
    END IF;
  END IF;

  -- Floor the overall total at 0: a negative tweak / net deductions must not produce a negative grade.
  calculated_score := greatest(calculated_score, 0);

  WITH
  part_assignments AS (
    SELECT (jsonb_each_text(coalesce(sr.rubric_part_student_assignments, '{}'::jsonb))).*
    FROM public.submission_reviews sr WHERE sr.id = p_submission_review_id
  ),
  individual_raw AS (
    SELECT sfc.target_student_profile_id::text AS student_id, ch.rubric_criteria_id, sum(sfc.points) AS pts
    FROM public.submission_file_comments sfc
    INNER JOIN public.rubric_checks ch ON ch.id = sfc.rubric_check_id
    INNER JOIN public.rubric_criteria c ON c.id = ch.rubric_criteria_id
    INNER JOIN public.rubric_parts rp ON rp.id = c.rubric_part_id
    WHERE sfc.submission_review_id = p_submission_review_id
      AND sfc.deleted_at IS NULL AND sfc.target_student_profile_id IS NOT NULL
      AND rp.is_individual_grading = true
    GROUP BY sfc.target_student_profile_id, ch.rubric_criteria_id
    UNION ALL
    SELECT sc.target_student_profile_id::text, ch.rubric_criteria_id, sum(sc.points)
    FROM public.submission_comments sc
    INNER JOIN public.rubric_checks ch ON ch.id = sc.rubric_check_id
    INNER JOIN public.rubric_criteria c ON c.id = ch.rubric_criteria_id
    INNER JOIN public.rubric_parts rp ON rp.id = c.rubric_part_id
    WHERE sc.submission_review_id = p_submission_review_id
      AND sc.deleted_at IS NULL AND sc.target_student_profile_id IS NOT NULL
      AND rp.is_individual_grading = true
    GROUP BY sc.target_student_profile_id, ch.rubric_criteria_id
    UNION ALL
    SELECT sac.target_student_profile_id::text, ch.rubric_criteria_id, sum(sac.points)
    FROM public.submission_artifact_comments sac
    INNER JOIN public.rubric_checks ch ON ch.id = sac.rubric_check_id
    INNER JOIN public.rubric_criteria c ON c.id = ch.rubric_criteria_id
    INNER JOIN public.rubric_parts rp ON rp.id = c.rubric_part_id
    WHERE sac.submission_review_id = p_submission_review_id
      AND sac.deleted_at IS NULL AND sac.target_student_profile_id IS NOT NULL
      AND rp.is_individual_grading = true
    GROUP BY sac.target_student_profile_id, ch.rubric_criteria_id
  ),
  assigned_raw AS (
    SELECT pa.value AS student_id, ch.rubric_criteria_id, sum(comments.points) AS pts
    FROM part_assignments pa
    INNER JOIN public.rubric_parts rp ON rp.id = pa.key::bigint AND rp.is_assign_to_student = true
    INNER JOIN public.rubric_criteria c ON c.rubric_part_id = rp.id
    INNER JOIN public.rubric_checks ch ON ch.rubric_criteria_id = c.id
    LEFT JOIN (
      SELECT sc.rubric_check_id, sc.points FROM public.submission_comments sc
      WHERE sc.submission_review_id = p_submission_review_id AND sc.deleted_at IS NULL AND sc.points IS NOT NULL
      UNION ALL
      SELECT sfc.rubric_check_id, sfc.points FROM public.submission_file_comments sfc
      WHERE sfc.submission_review_id = p_submission_review_id AND sfc.deleted_at IS NULL AND sfc.points IS NOT NULL
      UNION ALL
      SELECT sac.rubric_check_id, sac.points FROM public.submission_artifact_comments sac
      WHERE sac.submission_review_id = p_submission_review_id AND sac.deleted_at IS NULL AND sac.points IS NOT NULL
    ) comments ON comments.rubric_check_id = ch.id
    WHERE pa.value IS NOT NULL AND pa.value != ''
    GROUP BY pa.value, ch.rubric_criteria_id
  ),
  all_raw AS (
    SELECT * FROM individual_raw
    UNION ALL
    SELECT * FROM assigned_raw
  ),
  merged_points AS (
    SELECT student_id, rubric_criteria_id, sum(pts) AS total_pts
    FROM all_raw GROUP BY student_id, rubric_criteria_id
  ),
  capped_scores AS (
    SELECT mp.student_id,
      CASE WHEN c.is_deduction_only THEN greatest(-coalesce(mp.total_pts, 0), -c.total_points)
           WHEN c.is_additive THEN least(coalesce(mp.total_pts, 0), c.total_points)
           ELSE greatest(c.total_points - coalesce(mp.total_pts, 0), 0) END AS score
    FROM merged_points mp
    INNER JOIN public.rubric_criteria c ON c.id = mp.rubric_criteria_id
  ),
  student_scores AS (
    SELECT student_id, sum(score) AS student_score
    FROM capped_scores GROUP BY student_id
  )
  SELECT jsonb_object_agg(student_id, student_score)
  INTO individual_scores_result
  FROM student_scores;

  per_student_totals := NULL;
  v_shared_base_stored := NULL;

  SELECT EXISTS (
    SELECT 1 FROM public.rubric_parts rp
    WHERE rp.rubric_id = (SELECT rubric_id FROM public.submission_reviews WHERE id = p_submission_review_id)
      AND (rp.is_individual_grading = true OR rp.is_assign_to_student = true)
  ) INTO v_has_split_rubric;

  IF v_has_split_rubric AND is_grading_review THEN
    SELECT sum(score) INTO shared_hand_score FROM (
      SELECT c.id,
        CASE
          WHEN c.is_deduction_only THEN greatest(-coalesce(sum(comments.points), 0), -c.total_points)
          WHEN c.is_additive THEN least(coalesce(sum(comments.points), 0), c.total_points)
          ELSE greatest(c.total_points - coalesce(sum(comments.points), 0), 0)
        END AS score
      FROM public.submission_reviews sr
      INNER JOIN public.rubric_criteria c ON c.rubric_id = sr.rubric_id
      INNER JOIN public.rubric_parts rp ON rp.id = c.rubric_part_id
      INNER JOIN public.rubric_checks ch ON ch.rubric_criteria_id = c.id
      LEFT JOIN (
        SELECT sum(sc.points) AS points, sc.rubric_check_id FROM public.submission_comments sc
        WHERE sc.submission_review_id = p_submission_review_id AND sc.deleted_at IS NULL AND sc.points IS NOT NULL
        GROUP BY sc.rubric_check_id
        UNION ALL
        SELECT sum(sfc.points) AS points, sfc.rubric_check_id FROM public.submission_file_comments sfc
        WHERE sfc.submission_review_id = p_submission_review_id AND sfc.deleted_at IS NULL AND sfc.points IS NOT NULL
        GROUP BY sfc.rubric_check_id
        UNION ALL
        SELECT sum(sac.points) AS points, sac.rubric_check_id FROM public.submission_artifact_comments sac
        WHERE sac.submission_review_id = p_submission_review_id AND sac.deleted_at IS NULL AND sac.points IS NOT NULL
        GROUP BY sac.rubric_check_id
      ) AS comments ON comments.rubric_check_id = ch.id
      WHERE sr.id = p_submission_review_id
        AND rp.is_individual_grading = false
        AND rp.is_assign_to_student = false
      GROUP BY c.id
    ) AS shared_combo;

    IF shared_hand_score IS NULL THEN
      shared_hand_score := 0;
    END IF;

    -- Same tweak + autograde applied to every group member's line (shared_base + individual slice).
    shared_base := shared_hand_score + calculated_autograde_score + current_tweak;
    v_shared_base_stored := shared_base;

    v_targets := public._grade_targets_for_submission(v_submission_id);

    IF v_targets IS NOT NULL AND cardinality(v_targets) > 0 THEN
      per_student_totals := '{}'::jsonb;
      FOREACH v_student IN ARRAY v_targets
      LOOP
        v_ind := coalesce((coalesce(individual_scores_result, '{}'::jsonb) ->> v_student::text)::numeric, 0);
        v_extra := 0;
        IF v_per_student_tweaks IS NOT NULL AND jsonb_typeof(v_per_student_tweaks) = 'object' THEN
          BEGIN
            v_extra := coalesce((nullif(trim(v_per_student_tweaks ->> v_student::text), ''))::numeric, 0);
            -- Same NaN / infinity / out-of-range reasoning as the sum above.
            IF v_extra = 'NaN'::numeric
               OR v_extra = 'Infinity'::numeric
               OR v_extra = '-Infinity'::numeric THEN
              v_extra := 0;
            END IF;
          EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
            v_extra := 0;
          END;
        END IF;
        v_line := shared_base + v_ind + v_extra;
        IF should_cap AND assignment_total_points IS NOT NULL THEN
          v_line := least(v_line, assignment_total_points);
        END IF;
        -- Floor each per-student line at 0, mirroring the overall total.
        v_line := greatest(v_line, 0);
        per_student_totals := per_student_totals || jsonb_build_object(v_student::text, v_line);
      END LOOP;
    END IF;
  END IF;

  UPDATE public.submission_reviews
  SET total_score = calculated_score,
      total_autograde_score = calculated_autograde_score,
      individual_scores = individual_scores_result,
      per_student_grading_totals = per_student_totals,
      per_student_grading_shared_base = v_shared_base_stored
  WHERE id = p_submission_review_id;
END;
$function$;

COMMENT ON FUNCTION public._submission_review_recompute_scores(bigint) IS
  'Internal: recompute total_score, autograde, individual_scores, per_student_grading_totals, and per_student_grading_shared_base; per_student_tweaks add to each student line and to total_score. Scores are capped at assignment points and floored at 0, with the floor applied last.';

REVOKE ALL ON FUNCTION public._submission_review_recompute_scores(bigint) FROM PUBLIC;

-- Backfill every review that carries a per-student tweak.
--
-- The only term the June 4 branch dropped is the per-student tweak, so a review is wrong iff
-- per_student_tweaks is a non-empty JSON object. Reviews whose map was later cleared already
-- recompute correctly, and recompute is idempotent, so this predicate is both complete and tight.
--
-- Calls the function directly rather than touching rows to fire
-- submission_reviews_recompute_split_metadata: a no-op UPDATE would also fire the audit,
-- realtime-broadcast, and release-cascade triggers for no benefit. The function's own trailing
-- UPDATE still fires trigger_recalculate_dependent_columns_on_review_update, whose IS DISTINCT
-- FROM predicate enqueues gradebook recalculation for exactly the rows that actually changed.
--
-- Bounded on purpose: _submission_review_recompute_scores takes pg_advisory_xact_lock(id), and
-- every lock is held until this migration commits. A five-figure backfill would risk
-- max_locks_per_transaction and would block concurrent grading of those reviews for the duration.
-- The narrow predicate is what keeps that safe, so the size is asserted rather than assumed: if
-- the set is unexpectedly large, refuse and make a human look, instead of silently taking a long
-- exclusive-ish hold on live grading. The shape to switch to in that case is the chunked drain in
-- 20260421130000 (separate top-level statements), not a bigger allowance here.
DO $backfill$
DECLARE
  r record;
  v_total int;
  v_count int := 0;
  c_max_rows constant int := 5000;
BEGIN
  SELECT count(*) INTO v_total
  FROM public.submission_reviews
  WHERE per_student_tweaks IS NOT NULL
    AND jsonb_typeof(per_student_tweaks) = 'object'
    AND per_student_tweaks <> '{}'::jsonb;

  IF v_total > c_max_rows THEN
    RAISE EXCEPTION
      'per_student_tweaks backfill covers % reviews, over the % row ceiling. Each recompute holds an advisory lock until commit, so a run this size risks max_locks_per_transaction and blocks live grading. Backfill in chunks (see 20260421130000) and re-run this migration with the loop removed.',
      v_total, c_max_rows;
  END IF;

  FOR r IN
    SELECT id FROM public.submission_reviews
    WHERE per_student_tweaks IS NOT NULL
      AND jsonb_typeof(per_student_tweaks) = 'object'
      AND per_student_tweaks <> '{}'::jsonb
    ORDER BY id
  LOOP
    PERFORM public._submission_review_recompute_scores(r.id);
    v_count := v_count + 1;
  END LOOP;

  RAISE NOTICE 'per_student_tweaks backfill: recomputed % submission_reviews', v_count;
END;
$backfill$;
