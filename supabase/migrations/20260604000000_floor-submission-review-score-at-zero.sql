-- Floor recomputed submission-review scores at 0.
--
-- _submission_review_recompute_scores capped the score at the TOP
-- (least(score, assignment_total_points)) but never floored it, so a negative tweak or
-- net-negative deductions could drive total_score (and per-student grading lines) below 0.
-- A negative total_score then crashed the grade ledger UI (Chakra Progress rejects values
-- below its min of 0) and is not a meaningful grade. Add greatest(..., 0) floors to both the
-- overall total and each per-student line, mirroring the existing cap.
--
-- Only the two greatest(...) lines differ from the prior definition
-- (20260322130000_submission_review_recompute_shared_and_bulk.sql); the rest is unchanged.

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

  SELECT coalesce(tweak, 0)
  INTO current_tweak
  FROM public.submission_reviews
  WHERE id = p_submission_review_id;

  SELECT r.cap_score_to_assignment_points INTO should_cap
  FROM public.rubrics r
  INNER JOIN public.submission_reviews sr ON sr.rubric_id = r.id
  WHERE sr.id = p_submission_review_id;

  calculated_score := calculated_score + calculated_autograde_score + current_tweak;

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
        v_line := shared_base + v_ind;
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
  'Internal: recompute total_score, autograde, individual_scores, per_student_grading_totals, and per_student_grading_shared_base. Scores are capped at assignment points and floored at 0.';

REVOKE ALL ON FUNCTION public._submission_review_recompute_scores(bigint) FROM PUBLIC;

-- Backfill: recompute every review that already holds a negative overall total or a negative
-- per-student line, so existing rows (e.g. the reported submission) are floored without waiting
-- for a future grading edit to fire the trigger.
DO $backfill$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT id FROM public.submission_reviews
    WHERE total_score < 0
       OR EXISTS (
         SELECT 1 FROM jsonb_each_text(coalesce(per_student_grading_totals, '{}'::jsonb)) e
         WHERE e.value::numeric < 0
       )
  LOOP
    PERFORM public._submission_review_recompute_scores(r.id);
  END LOOP;
END;
$backfill$;
