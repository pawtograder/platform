-- Keep per_student_grading_totals / individual_scores in sync with autograder + tweak.
-- submissionreviewrecompute_bulk_grader_tests previously only updated total_score and
-- total_autograde_score, so split-rubric per-student lines missed tweak/autograde until a
-- hand-grading comment fired the full trigger.
-- Also: AFTER UPDATE OF rubric_part_student_assignments,tweak on submission_reviews so
-- assign-to-student / tweak edits recompute without a comment touch.

ALTER TABLE public.submission_reviews
  ADD COLUMN IF NOT EXISTS per_student_grading_shared_base numeric;

COMMENT ON COLUMN public.submission_reviews.per_student_grading_shared_base IS
  'When rubric has individual/assign-to-student parts: shared hand rubric + autograder + tweak (same for all group members). NULL when not in split-rubric grading mode.';

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
  'Internal: recompute total_score, autograde, individual_scores, per_student_grading_totals, and per_student_grading_shared_base.';

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

  -- submission_reviews updates (assign-to-student mapping, tweak) must recompute this row;
  -- submissions.grading_review_id alone would always target the grading review, not e.g. round-1 reviews.
  IF TG_TABLE_NAME = 'submission_reviews' THEN
    existing_submission_review_id := NEW.id;
  ELSIF 'submission_review_id' = any(SELECT jsonb_object_keys(to_jsonb(new))) THEN
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

-- Assign-to-student edits update submission_reviews only (no comment row). UPDATE OF avoids firing
-- when recompute writes total_score / individual_scores / per_student_grading_*.
DROP TRIGGER IF EXISTS submission_reviews_recompute_split_metadata ON public.submission_reviews;

CREATE TRIGGER submission_reviews_recompute_split_metadata
AFTER UPDATE OF rubric_part_student_assignments, tweak ON public.submission_reviews
FOR EACH ROW
EXECUTE FUNCTION public.submissionreviewrecompute();

COMMENT ON TRIGGER submission_reviews_recompute_split_metadata ON public.submission_reviews IS
  'Recompute scores when assign-to-student mapping or tweak changes; skipped for score-only updates from _submission_review_recompute_scores.';

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

-- Expose shared base on instructor grade table view
DROP VIEW IF EXISTS public.submissions_with_grades_for_assignment_nice;

CREATE VIEW public.submissions_with_grades_for_assignment_nice WITH (security_invoker = 'true') AS
 WITH assignment_students AS (
         SELECT DISTINCT ur.id AS user_role_id,
            ur.private_profile_id, a.class_id, a.id AS assignment_id,
            a.due_date, a.slug AS assignment_slug,
            ur.class_section_id, ur.lab_section_id
           FROM public.assignments a
             JOIN public.user_roles ur ON ((ur.class_id = a.class_id AND ur.role = 'student'::public.app_role AND ur.disabled = false))
        ), individual_submissions AS (
         SELECT ast.user_role_id, ast.private_profile_id, ast.class_id,
            ast.assignment_id, s_1.id AS submission_id,
            NULL::bigint AS assignment_group_id, ast.due_date,
            ast.assignment_slug, ast.class_section_id, ast.lab_section_id
           FROM assignment_students ast
             JOIN public.submissions s_1 ON ((s_1.assignment_id = ast.assignment_id AND s_1.profile_id = ast.private_profile_id AND s_1.is_active = true AND s_1.assignment_group_id IS NULL))
        ), group_submissions AS (
         SELECT ast.user_role_id, ast.private_profile_id, ast.class_id,
            ast.assignment_id, s_1.id AS submission_id,
            agm.assignment_group_id, ast.due_date,
            ast.assignment_slug, ast.class_section_id, ast.lab_section_id
           FROM assignment_students ast
             JOIN public.assignment_groups_members agm ON ((agm.assignment_id = ast.assignment_id AND agm.profile_id = ast.private_profile_id))
             JOIN public.submissions s_1 ON ((s_1.assignment_id = ast.assignment_id AND s_1.assignment_group_id = agm.assignment_group_id AND s_1.is_active = true))
        ), all_submissions AS (
         SELECT * FROM individual_submissions
        UNION ALL
         SELECT * FROM group_submissions
        ), due_date_extensions AS (
         SELECT COALESCE(ade.student_id, ag_1.profile_id) AS effective_student_id,
            COALESCE(ade.assignment_group_id, ag_1.assignment_group_id) AS effective_assignment_group_id,
            ade.assignment_id,
            sum(ade.tokens_consumed) AS tokens_consumed,
            sum(ade.hours) AS hours
           FROM public.assignment_due_date_exceptions ade
             LEFT JOIN public.assignment_groups_members ag_1 ON ((ade.assignment_group_id = ag_1.assignment_group_id))
          GROUP BY COALESCE(ade.student_id, ag_1.profile_id), COALESCE(ade.assignment_group_id, ag_1.assignment_group_id), ade.assignment_id
        ), submissions_with_extensions AS (
         SELECT asub.user_role_id, asub.private_profile_id, asub.class_id,
            asub.assignment_id, asub.submission_id, asub.assignment_group_id,
            asub.due_date, asub.assignment_slug,
            COALESCE(dde.tokens_consumed, (0)::bigint) AS tokens_consumed,
            COALESCE(dde.hours, (0)::bigint) AS hours,
            asub.class_section_id, asub.lab_section_id
           FROM all_submissions asub
             LEFT JOIN due_date_extensions dde ON (
               (dde.effective_student_id = asub.private_profile_id)
               AND (dde.assignment_id = asub.assignment_id)
               AND (
                 (asub.assignment_group_id IS NULL AND dde.effective_assignment_group_id IS NULL)
                 OR (asub.assignment_group_id = dde.effective_assignment_group_id)
               )
             )
        )
 SELECT swe.user_role_id AS id, swe.class_id, swe.assignment_id,
    p.id AS student_private_profile_id, p.name, p.sortable_name,
    s.id AS activesubmissionid, s.ordinal, s.created_at, s.released,
    s.repository, s.sha,
    rev.total_autograde_score AS autograder_score,
    rev.grader, rev.meta_grader, rev.total_score, rev.tweak,
    rev.completed_by, rev.completed_at, rev.checked_at, rev.checked_by,
    rev.individual_scores,
    rev.per_student_grading_totals,
    rev.per_student_grading_shared_base,
    graderprofile.name AS assignedgradername,
    metagraderprofile.name AS assignedmetagradername,
    completerprofile.name AS gradername,
    checkgraderprofile.name AS checkername,
    ag.name AS groupname,
    swe.tokens_consumed, swe.hours, swe.due_date,
    (swe.due_date + ('01:00:00'::interval * (swe.hours)::double precision)) AS late_due_date,
    ar.grader_sha, ar.grader_action_sha,
    swe.assignment_slug, swe.class_section_id,
    cs.name AS class_section_name,
    swe.lab_section_id, ls.name AS lab_section_name
   FROM submissions_with_extensions swe
     JOIN public.profiles p ON ((p.id = swe.private_profile_id))
     JOIN public.submissions s ON ((s.id = swe.submission_id))
     LEFT JOIN public.submission_reviews rev ON ((rev.id = s.grading_review_id))
     LEFT JOIN public.grader_results ar ON ((ar.submission_id = s.id))
     LEFT JOIN public.assignment_groups ag ON ((ag.id = swe.assignment_group_id))
     LEFT JOIN public.profiles completerprofile ON ((completerprofile.id = rev.completed_by))
     LEFT JOIN public.profiles graderprofile ON ((graderprofile.id = rev.grader))
     LEFT JOIN public.profiles metagraderprofile ON ((metagraderprofile.id = rev.meta_grader))
     LEFT JOIN public.profiles checkgraderprofile ON ((checkgraderprofile.id = rev.checked_by))
     LEFT JOIN public.class_sections cs ON ((cs.id = swe.class_section_id))
     LEFT JOIN public.lab_sections ls ON ((ls.id = swe.lab_section_id));

ALTER VIEW public.submissions_with_grades_for_assignment_nice OWNER TO postgres;
