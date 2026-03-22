-- Keep per_student_grading_totals / individual_scores in sync with autograder + tweak.
-- submissionreviewrecompute_bulk_grader_tests previously only updated total_score and
-- total_autograde_score, so split-rubric per-student lines missed tweak/autograde until a
-- hand-grading comment fired the full trigger.

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
           ELSE greatest(c.total_pts - coalesce(mp.total_pts, 0), 0) END AS score
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
        per_student_totals := per_student_totals || jsonb_build_object(v_student::text, v_line);
      END LOOP;
    END IF;
  END IF;

  UPDATE public.submission_reviews
  SET total_score = calculated_score,
      total_autograde_score = calculated_autograde_score,
      individual_scores = individual_scores_result,
      per_student_grading_totals = per_student_totals
  WHERE id = p_submission_review_id;
END;
$function$;

COMMENT ON FUNCTION public._submission_review_recompute_scores(bigint) IS
  'Internal: recompute total_score, total_autograde_score, individual_scores, and per_student_grading_totals for a submission_review. Tweak and autograde are included in each per-student total when the rubric has split parts.';

CREATE OR REPLACE FUNCTION public.submissionreviewrecompute()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  existing_submission_review_id int8;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF 'rubric_check_id' = any(SELECT jsonb_object_keys(to_jsonb(new))) THEN
    IF NEW.rubric_check_id IS NULL AND (OLD IS NULL OR OLD.rubric_check_id IS NULL) THEN
      RETURN NEW;
    END IF;
  END IF;

  IF 'submission_review_id' = any(SELECT jsonb_object_keys(to_jsonb(new))) THEN
    IF NEW.submission_review_id IS NULL THEN
      RETURN NEW;
    END IF;
    existing_submission_review_id := NEW.submission_review_id;
  ELSE
    SELECT grading_review_id INTO existing_submission_review_id
    FROM public.submissions
    WHERE id = NEW.submission_id;
  END IF;

  IF existing_submission_review_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM public._submission_review_recompute_scores(existing_submission_review_id);

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.submissionreviewrecompute_bulk_grader_tests()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  submission_rec record;
  existing_submission_review_id int8;
BEGIN
  FOR submission_rec IN
    SELECT DISTINCT submission_id
    FROM new_table
    WHERE submission_id IS NOT NULL
  LOOP
    SELECT grading_review_id
    INTO existing_submission_review_id
    FROM public.submissions
    WHERE id = submission_rec.submission_id;

    IF existing_submission_review_id IS NULL THEN
      CONTINUE;
    END IF;

    PERFORM public._submission_review_recompute_scores(existing_submission_review_id);
  END LOOP;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.submissionreviewrecompute_bulk_grader_tests() IS
  'Statement-level trigger: full score recompute (including individual_scores and per_student_grading_totals) for affected grading reviews after grader_result_tests changes.';
