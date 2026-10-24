-- Per-student grading completion: fail closed when a submission has no students to grade.
--
-- 20260322100000_individual_grading_completion_validation.sql taught the completion validators to
-- require one comment per group member for a required check on an `is_individual_grading` rubric
-- part. `_grade_targets_for_submission` returns an empty array when the membership resolves empty
-- (an assignment group with no `assignment_groups_members` rows, or a submission with neither a
-- group nor a submitter), and every validator branched on that as:
--
--   IF is_individual_grading AND v_num_targets > 0 THEN  -- require a comment per student
--   ELSIF is_individual_grading THEN                    -- fall back to "any comment anywhere"
--
-- The fallback is fail-dangerous in exactly the case the per-student rule exists to cover: with
-- zero targets a single comment satisfied a required per-student check, so the review validated,
-- completed and released while no student had been graded individually. The helpers used for
-- uncovered rubric parts had the same shape (`p_num_targets IS NULL OR p_num_targets = 0` shared a
-- branch with `NOT p_is_individual`), so the trigger-driven auto-complete path accepted it too.
--
-- A recent commit fixed the client (`lib/rubricGradingCompletion.ts` /
-- `hooks/useSubmissionReview.tsx` / `components/ui/submission-review-toolbar.tsx` now refuse to
-- report an all-clear when the grade-target list is empty or not yet loaded), which left the server
-- silently wrong rather than visibly wrong: the RPC and trigger paths still accepted the completion.
--
-- This migration makes zero grade targets fail closed everywhere on the server. When a rubric part
-- is `is_individual_grading` and the submission resolves to no students, its per-student
-- requirements are treated as NOT satisfied:
--
--   * a required check on such a part is never satisfied;
--   * a criterion on such a part with `min_checks_per_submission` or `max_checks_per_submission`
--     set is never satisfied (per-student counts are unverifiable, and the submission-wide count
--     that used to stand in for them answers a different question);
--   * a criterion with neither bound has nothing per-student to verify and is still ignored.
--
-- `validate_review_assignment_completion` reports these in their own section of the exception so an
-- instructor sees the actual cause and can act on it, instead of a check name appearing in the
-- "missing required checks" list that they cannot make go away by grading. The auto-complete
-- trigger cannot raise (it would block a review assignment completion that is otherwise legal), so
-- it leaves the submission review open as it already does for blocking uncovered parts and emits a
-- warning naming the cause.
--
-- Behavior for submissions that do have students is unchanged.

-- Review assignment completion: respect individual grading and skipped assign-to-student parts.
CREATE OR REPLACE FUNCTION public.validate_review_assignment_completion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_submission_review_id bigint;
  v_rubric_id bigint;
  v_submission_id bigint;
  v_assigned_part_ids bigint[];
  v_assignments jsonb;
  v_targets uuid[];
  v_missing_checks text[] := ARRAY[]::text[];
  v_missing_criteria text[] := ARRAY[]::text[];
  v_exceeding_max text[] := ARRAY[]::text[];
  v_unverifiable text[] := ARRAY[]::text[];
  v_error_message text;
  v_check_record record;
  v_criteria_record record;
  v_val text;
  i int;
  v_target uuid;
  v_has_comment boolean;
  v_count int;
  v_num_targets int;
BEGIN
  v_submission_review_id := NEW.submission_review_id;
  v_rubric_id := NEW.rubric_id;

  IF v_submission_review_id IS NULL OR v_rubric_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT sr.submission_id, COALESCE(sr.rubric_part_student_assignments, '{}'::jsonb)
  INTO v_submission_id, v_assignments
  FROM public.submission_reviews sr
  WHERE sr.id = v_submission_review_id;

  IF v_submission_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_targets := public._grade_targets_for_submission(v_submission_id);
  v_num_targets := COALESCE(array_length(v_targets, 1), 0);

  SELECT ARRAY_AGG(rubric_part_id) INTO v_assigned_part_ids
  FROM public.review_assignment_rubric_parts
  WHERE review_assignment_id = NEW.id;

  FOR v_check_record IN
    SELECT rc.id AS check_id,
           rc.name AS check_name,
           rcrit.id AS criteria_id,
           rcrit.rubric_part_id AS part_id,
           rp.is_individual_grading,
           rp.is_assign_to_student
    FROM public.rubric_checks rc
    INNER JOIN public.rubric_criteria rcrit ON rc.rubric_criteria_id = rcrit.id
    INNER JOIN public.rubric_parts rp ON rcrit.rubric_part_id = rp.id
    WHERE rc.rubric_id = v_rubric_id
      AND rc.is_required = true
      AND (
        v_assigned_part_ids IS NULL
        OR array_length(v_assigned_part_ids, 1) IS NULL
        OR array_length(v_assigned_part_ids, 1) = 0
        OR rcrit.rubric_part_id = ANY (v_assigned_part_ids)
      )
  LOOP
    IF v_check_record.is_assign_to_student THEN
      v_val := v_assignments ->> v_check_record.part_id::text;
      IF v_val IS NULL OR v_val = '' THEN
        CONTINUE;
      END IF;
    END IF;

    IF v_check_record.is_individual_grading AND v_num_targets > 0 THEN
      FOR i IN 1..v_num_targets LOOP
        v_target := v_targets[i];
        SELECT EXISTS (
          SELECT 1 FROM public.submission_comments sc
          WHERE sc.submission_review_id = v_submission_review_id
            AND sc.rubric_check_id = v_check_record.check_id
            AND sc.deleted_at IS NULL
            AND sc.target_student_profile_id = v_target
          UNION ALL
          SELECT 1 FROM public.submission_file_comments sfc
          WHERE sfc.submission_review_id = v_submission_review_id
            AND sfc.rubric_check_id = v_check_record.check_id
            AND sfc.deleted_at IS NULL
            AND sfc.target_student_profile_id = v_target
          UNION ALL
          SELECT 1 FROM public.submission_artifact_comments sac
          WHERE sac.submission_review_id = v_submission_review_id
            AND sac.rubric_check_id = v_check_record.check_id
            AND sac.deleted_at IS NULL
            AND sac.target_student_profile_id = v_target
        ) INTO v_has_comment;
        IF NOT v_has_comment THEN
          v_missing_checks := array_append(v_missing_checks, v_check_record.check_name);
          EXIT;
        END IF;
      END LOOP;
    ELSIF v_check_record.is_individual_grading THEN
      -- FAIL CLOSED: per-student grading with no students to grade. This used to accept any single
      -- comment on the check, which let one comment stand in for a whole group.
      v_unverifiable := array_append(v_unverifiable, v_check_record.check_name);
    ELSE
      SELECT EXISTS (
        SELECT 1 FROM public.submission_comments sc
        WHERE sc.submission_review_id = v_submission_review_id
          AND sc.rubric_check_id = v_check_record.check_id
          AND sc.deleted_at IS NULL
        UNION ALL
        SELECT 1 FROM public.submission_file_comments sfc
        WHERE sfc.submission_review_id = v_submission_review_id
          AND sfc.rubric_check_id = v_check_record.check_id
          AND sfc.deleted_at IS NULL
        UNION ALL
        SELECT 1 FROM public.submission_artifact_comments sac
        WHERE sac.submission_review_id = v_submission_review_id
          AND sac.rubric_check_id = v_check_record.check_id
          AND sac.deleted_at IS NULL
      ) INTO v_has_comment;
      IF NOT v_has_comment THEN
        v_missing_checks := array_append(v_missing_checks, v_check_record.check_name);
      END IF;
    END IF;
  END LOOP;

  FOR v_criteria_record IN
    SELECT
      rcrit.id,
      rcrit.name,
      rcrit.min_checks_per_submission,
      rcrit.max_checks_per_submission,
      rcrit.rubric_part_id AS part_id,
      rp.is_individual_grading,
      rp.is_assign_to_student
    FROM public.rubric_criteria rcrit
    INNER JOIN public.rubric_parts rp ON rcrit.rubric_part_id = rp.id
    WHERE rcrit.rubric_id = v_rubric_id
      AND (
        v_assigned_part_ids IS NULL
        OR array_length(v_assigned_part_ids, 1) IS NULL
        OR array_length(v_assigned_part_ids, 1) = 0
        OR rcrit.rubric_part_id = ANY (v_assigned_part_ids)
      )
  LOOP
    IF v_criteria_record.is_assign_to_student THEN
      v_val := v_assignments ->> v_criteria_record.part_id::text;
      IF v_val IS NULL OR v_val = '' THEN
        CONTINUE;
      END IF;
    END IF;

    IF v_criteria_record.is_individual_grading AND v_num_targets > 0 THEN
      FOR i IN 1..v_num_targets LOOP
        v_target := v_targets[i];
        SELECT COALESCE(
          (
            SELECT COUNT(DISTINCT rc2.id)
            FROM public.rubric_checks rc2
            WHERE rc2.rubric_criteria_id = v_criteria_record.id
              AND EXISTS (
                SELECT 1 FROM public.submission_comments sc
                WHERE sc.submission_review_id = v_submission_review_id
                  AND sc.rubric_check_id = rc2.id
                  AND sc.deleted_at IS NULL
                  AND sc.target_student_profile_id = v_target
                UNION ALL
                SELECT 1 FROM public.submission_file_comments sfc
                WHERE sfc.submission_review_id = v_submission_review_id
                  AND sfc.rubric_check_id = rc2.id
                  AND sfc.deleted_at IS NULL
                  AND sfc.target_student_profile_id = v_target
                UNION ALL
                SELECT 1 FROM public.submission_artifact_comments sac
                WHERE sac.submission_review_id = v_submission_review_id
                  AND sac.rubric_check_id = rc2.id
                  AND sac.deleted_at IS NULL
                  AND sac.target_student_profile_id = v_target
              )
          ),
          0
        ) INTO v_count;

        IF v_criteria_record.min_checks_per_submission IS NOT NULL
           AND v_count < v_criteria_record.min_checks_per_submission THEN
          v_missing_criteria := array_append(
            v_missing_criteria,
            v_criteria_record.name || ' (need ' || v_criteria_record.min_checks_per_submission ||
            ', have ' || v_count || ' per student)'
          );
        END IF;

        IF v_criteria_record.max_checks_per_submission IS NOT NULL
           AND v_count > v_criteria_record.max_checks_per_submission THEN
          v_exceeding_max := array_append(
            v_exceeding_max,
            v_criteria_record.name || ' (max ' || v_criteria_record.max_checks_per_submission ||
            ', have ' || v_count || ' per student)'
          );
        END IF;
      END LOOP;
    ELSIF v_criteria_record.is_individual_grading THEN
      -- FAIL CLOSED: per-student grading with no students to grade. The submission-wide count that
      -- used to be applied here answers a different question than a per-student bound, so a
      -- per-student min or max cannot be verified at all. With neither bound set there is nothing
      -- per-student to verify and the criterion is ignored, as before.
      IF v_criteria_record.min_checks_per_submission IS NOT NULL
         OR v_criteria_record.max_checks_per_submission IS NOT NULL THEN
        v_unverifiable := array_append(
          v_unverifiable,
          v_criteria_record.name || ' (per-student check count)'
        );
      END IF;
    ELSE
      SELECT COALESCE(
        (
          SELECT COUNT(DISTINCT rc2.id)
          FROM public.rubric_checks rc2
          WHERE rc2.rubric_criteria_id = v_criteria_record.id
            AND EXISTS (
              SELECT 1 FROM public.submission_comments sc
              WHERE sc.submission_review_id = v_submission_review_id
                AND sc.rubric_check_id = rc2.id
                AND sc.deleted_at IS NULL
              UNION ALL
              SELECT 1 FROM public.submission_file_comments sfc
              WHERE sfc.submission_review_id = v_submission_review_id
                AND sfc.rubric_check_id = rc2.id
                AND sfc.deleted_at IS NULL
              UNION ALL
              SELECT 1 FROM public.submission_artifact_comments sac
              WHERE sac.submission_review_id = v_submission_review_id
                AND sac.rubric_check_id = rc2.id
                AND sac.deleted_at IS NULL
            )
        ),
        0
      ) INTO v_count;

      IF v_criteria_record.min_checks_per_submission IS NOT NULL
         AND v_count < v_criteria_record.min_checks_per_submission THEN
        v_missing_criteria := array_append(
          v_missing_criteria,
          v_criteria_record.name || ' (need ' || v_criteria_record.min_checks_per_submission ||
          ', have ' || v_count || ')'
        );
      END IF;

      IF v_criteria_record.max_checks_per_submission IS NOT NULL
         AND v_count > v_criteria_record.max_checks_per_submission THEN
        v_exceeding_max := array_append(
          v_exceeding_max,
          v_criteria_record.name || ' (max ' || v_criteria_record.max_checks_per_submission ||
          ', have ' || v_count || ')'
        );
      END IF;
    END IF;
  END LOOP;

  IF COALESCE(array_length(v_missing_checks, 1), 0) > 0
     OR COALESCE(array_length(v_missing_criteria, 1), 0) > 0
     OR COALESCE(array_length(v_exceeding_max, 1), 0) > 0
     OR COALESCE(array_length(v_unverifiable, 1), 0) > 0 THEN
    v_error_message := '';

    -- Named first, and with the cause spelled out: no amount of grading clears this one, so an
    -- instructor needs to be told that the submission has no students rather than being handed a
    -- list of checks to apply.
    IF COALESCE(array_length(v_unverifiable, 1), 0) > 0 THEN
      v_error_message := v_error_message ||
        'Cannot verify per-student grading for: ' || array_to_string(v_unverifiable, ', ') ||
        '. This submission has no students to grade (its assignment group is empty), so there is ' ||
        'no one to require a per-student check for. Add the group''s member(s) back to the ' ||
        'assignment group, or turn off per-student grading for the rubric part, then complete the ' ||
        'review.' || E'\n';
    END IF;

    IF COALESCE(array_length(v_missing_checks, 1), 0) > 0 THEN
      v_error_message := v_error_message || 'Missing required checks: ' ||
        array_to_string(v_missing_checks, ', ') || E'\n';
    END IF;

    IF COALESCE(array_length(v_missing_criteria, 1), 0) > 0 THEN
      v_error_message := v_error_message || 'Missing required criteria: ' ||
        array_to_string(v_missing_criteria, ', ') || E'\n';
    END IF;

    IF COALESCE(array_length(v_exceeding_max, 1), 0) > 0 THEN
      v_error_message := v_error_message || 'Too many checks applied: ' ||
        array_to_string(v_exceeding_max, ', ');
    END IF;

    v_error_message := rtrim(v_error_message, E'\n');
    RAISE EXCEPTION '%', v_error_message;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.validate_review_assignment_completion() IS
  'Validates review assignment completion: required checks/criteria; per-student rules for is_individual_grading; skips is_assign_to_student parts when not assigned in rubric_part_student_assignments. Fails closed when an is_individual_grading part has no students to grade (empty assignment group): per-student requirements are unsatisfiable and the exception names them and the empty group.';

-- Submission review bulk-completeness (full rubric).
CREATE OR REPLACE FUNCTION public._submission_review_is_completable(p_submission_review_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_rubric_id bigint;
  v_submission_id bigint;
  v_assignments jsonb;
  v_targets uuid[];
  v_check_record record;
  v_criteria_record record;
  v_val text;
  i int;
  v_target uuid;
  v_has_comment boolean;
  v_count int;
  v_num_targets int;
BEGIN
  SELECT sr.rubric_id, sr.submission_id, COALESCE(sr.rubric_part_student_assignments, '{}'::jsonb)
  INTO v_rubric_id, v_submission_id, v_assignments
  FROM public.submission_reviews sr
  WHERE sr.id = p_submission_review_id;

  IF v_rubric_id IS NULL OR v_submission_id IS NULL THEN
    RETURN false;
  END IF;

  v_targets := public._grade_targets_for_submission(v_submission_id);
  v_num_targets := COALESCE(array_length(v_targets, 1), 0);

  FOR v_check_record IN
    SELECT rc.id AS check_id,
           rcrit.rubric_part_id AS part_id,
           rp.is_individual_grading,
           rp.is_assign_to_student
    FROM public.rubric_checks rc
    INNER JOIN public.rubric_criteria rcrit ON rc.rubric_criteria_id = rcrit.id
    INNER JOIN public.rubric_parts rp ON rcrit.rubric_part_id = rp.id
    WHERE rc.rubric_id = v_rubric_id
      AND rc.is_required = true
  LOOP
    IF v_check_record.is_assign_to_student THEN
      v_val := v_assignments ->> v_check_record.part_id::text;
      IF v_val IS NULL OR v_val = '' THEN
        CONTINUE;
      END IF;
    END IF;

    IF v_check_record.is_individual_grading AND v_num_targets > 0 THEN
      FOR i IN 1..v_num_targets LOOP
        v_target := v_targets[i];
        SELECT EXISTS (
          SELECT 1 FROM public.submission_comments sc
          WHERE sc.submission_review_id = p_submission_review_id
            AND sc.rubric_check_id = v_check_record.check_id
            AND sc.deleted_at IS NULL
            AND sc.target_student_profile_id = v_target
          UNION ALL
          SELECT 1 FROM public.submission_file_comments sfc
          WHERE sfc.submission_review_id = p_submission_review_id
            AND sfc.rubric_check_id = v_check_record.check_id
            AND sfc.deleted_at IS NULL
            AND sfc.target_student_profile_id = v_target
          UNION ALL
          SELECT 1 FROM public.submission_artifact_comments sac
          WHERE sac.submission_review_id = p_submission_review_id
            AND sac.rubric_check_id = v_check_record.check_id
            AND sac.deleted_at IS NULL
            AND sac.target_student_profile_id = v_target
        ) INTO v_has_comment;
        IF NOT v_has_comment THEN
          RETURN false;
        END IF;
      END LOOP;
    ELSIF v_check_record.is_individual_grading THEN
      -- FAIL CLOSED: per-student grading with no students to grade cannot be verified, so the
      -- review is not completable. This branch used to accept any single comment on the check.
      RETURN false;
    ELSE
      SELECT EXISTS (
        SELECT 1 FROM public.submission_comments sc
        WHERE sc.submission_review_id = p_submission_review_id
          AND sc.rubric_check_id = v_check_record.check_id
          AND sc.deleted_at IS NULL
        UNION ALL
        SELECT 1 FROM public.submission_file_comments sfc
        WHERE sfc.submission_review_id = p_submission_review_id
          AND sfc.rubric_check_id = v_check_record.check_id
          AND sfc.deleted_at IS NULL
        UNION ALL
        SELECT 1 FROM public.submission_artifact_comments sac
        WHERE sac.submission_review_id = p_submission_review_id
          AND sac.rubric_check_id = v_check_record.check_id
          AND sac.deleted_at IS NULL
      ) INTO v_has_comment;
      IF NOT v_has_comment THEN
        RETURN false;
      END IF;
    END IF;
  END LOOP;

  FOR v_criteria_record IN
    SELECT
      rcrit.id,
      rcrit.min_checks_per_submission,
      rcrit.max_checks_per_submission,
      rcrit.rubric_part_id AS part_id,
      rp.is_individual_grading,
      rp.is_assign_to_student
    FROM public.rubric_criteria rcrit
    INNER JOIN public.rubric_parts rp ON rcrit.rubric_part_id = rp.id
    WHERE rcrit.rubric_id = v_rubric_id
  LOOP
    IF v_criteria_record.is_assign_to_student THEN
      v_val := v_assignments ->> v_criteria_record.part_id::text;
      IF v_val IS NULL OR v_val = '' THEN
        CONTINUE;
      END IF;
    END IF;

    IF v_criteria_record.is_individual_grading AND v_num_targets > 0 THEN
      FOR i IN 1..v_num_targets LOOP
        v_target := v_targets[i];
        SELECT COALESCE(
          (
            SELECT COUNT(DISTINCT rc2.id)
            FROM public.rubric_checks rc2
            WHERE rc2.rubric_criteria_id = v_criteria_record.id
              AND EXISTS (
                SELECT 1 FROM public.submission_comments sc
                WHERE sc.submission_review_id = p_submission_review_id
                  AND sc.rubric_check_id = rc2.id
                  AND sc.deleted_at IS NULL
                  AND sc.target_student_profile_id = v_target
                UNION ALL
                SELECT 1 FROM public.submission_file_comments sfc
                WHERE sfc.submission_review_id = p_submission_review_id
                  AND sfc.rubric_check_id = rc2.id
                  AND sfc.deleted_at IS NULL
                  AND sfc.target_student_profile_id = v_target
                UNION ALL
                SELECT 1 FROM public.submission_artifact_comments sac
                WHERE sac.submission_review_id = p_submission_review_id
                  AND sac.rubric_check_id = rc2.id
                  AND sac.deleted_at IS NULL
                  AND sac.target_student_profile_id = v_target
              )
          ),
          0
        ) INTO v_count;

        IF v_criteria_record.min_checks_per_submission IS NOT NULL
           AND v_count < v_criteria_record.min_checks_per_submission THEN
          RETURN false;
        END IF;
        IF v_criteria_record.max_checks_per_submission IS NOT NULL
           AND v_count > v_criteria_record.max_checks_per_submission THEN
          RETURN false;
        END IF;
      END LOOP;
    ELSIF v_criteria_record.is_individual_grading THEN
      -- FAIL CLOSED: a per-student min/max on a submission with no students cannot be verified.
      -- This used to fall through to the submission-wide count below, which answers a different
      -- question. With neither bound set there is nothing per-student to verify.
      IF v_criteria_record.min_checks_per_submission IS NOT NULL
         OR v_criteria_record.max_checks_per_submission IS NOT NULL THEN
        RETURN false;
      END IF;
    ELSE
      SELECT COALESCE(
        (
          SELECT COUNT(DISTINCT rc2.id)
          FROM public.rubric_checks rc2
          WHERE rc2.rubric_criteria_id = v_criteria_record.id
            AND EXISTS (
              SELECT 1 FROM public.submission_comments sc
              WHERE sc.submission_review_id = p_submission_review_id
                AND sc.rubric_check_id = rc2.id
                AND sc.deleted_at IS NULL
              UNION ALL
              SELECT 1 FROM public.submission_file_comments sfc
              WHERE sfc.submission_review_id = p_submission_review_id
                AND sfc.rubric_check_id = rc2.id
                AND sfc.deleted_at IS NULL
              UNION ALL
              SELECT 1 FROM public.submission_artifact_comments sac
              WHERE sac.submission_review_id = p_submission_review_id
                AND sac.rubric_check_id = rc2.id
                AND sac.deleted_at IS NULL
            )
        ),
        0
      ) INTO v_count;

      IF v_criteria_record.min_checks_per_submission IS NOT NULL
         AND v_count < v_criteria_record.min_checks_per_submission THEN
        RETURN false;
      END IF;
      IF v_criteria_record.max_checks_per_submission IS NOT NULL
         AND v_count > v_criteria_record.max_checks_per_submission THEN
        RETURN false;
      END IF;
    END IF;
  END LOOP;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public._submission_review_is_completable(bigint) FROM PUBLIC;

-- Helpers for uncovered-part checks (used by check_and_complete_submission_review).
CREATE OR REPLACE FUNCTION public.check_required_check_satisfied_for_uncovered(
  p_submission_review_id bigint,
  p_rubric_check_id bigint,
  p_is_individual boolean,
  p_targets uuid[],
  p_num_targets int
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  i int;
  v_target uuid;
  v_has boolean;
BEGIN
  -- FAIL CLOSED: a required check on a per-student rubric part cannot be satisfied when the
  -- submission has no students to grade. Zero targets used to share this branch with
  -- "not per-student", so any single comment on the check counted for the whole (empty) group.
  IF p_is_individual AND COALESCE(p_num_targets, 0) = 0 THEN
    RETURN false;
  END IF;

  IF NOT p_is_individual THEN
    RETURN EXISTS (
      SELECT 1 FROM submission_comments sc
      WHERE sc.submission_review_id = p_submission_review_id
        AND sc.rubric_check_id = p_rubric_check_id
        AND sc.deleted_at IS NULL
      UNION ALL
      SELECT 1 FROM submission_file_comments sfc
      WHERE sfc.submission_review_id = p_submission_review_id
        AND sfc.rubric_check_id = p_rubric_check_id
        AND sfc.deleted_at IS NULL
      UNION ALL
      SELECT 1 FROM submission_artifact_comments sac
      WHERE sac.submission_review_id = p_submission_review_id
        AND sac.rubric_check_id = p_rubric_check_id
        AND sac.deleted_at IS NULL
    );
  END IF;

  FOR i IN 1..p_num_targets LOOP
    v_target := p_targets[i];
    SELECT EXISTS (
      SELECT 1 FROM submission_comments sc
      WHERE sc.submission_review_id = p_submission_review_id
        AND sc.rubric_check_id = p_rubric_check_id
        AND sc.deleted_at IS NULL
        AND sc.target_student_profile_id = v_target
      UNION ALL
      SELECT 1 FROM submission_file_comments sfc
      WHERE sfc.submission_review_id = p_submission_review_id
        AND sfc.rubric_check_id = p_rubric_check_id
        AND sfc.deleted_at IS NULL
        AND sfc.target_student_profile_id = v_target
      UNION ALL
      SELECT 1 FROM submission_artifact_comments sac
      WHERE sac.submission_review_id = p_submission_review_id
        AND sac.rubric_check_id = p_rubric_check_id
        AND sac.deleted_at IS NULL
        AND sac.target_student_profile_id = v_target
    ) INTO v_has;
    IF NOT v_has THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.criteria_min_satisfied_for_uncovered(
  p_submission_review_id bigint,
  p_rubric_criteria_id bigint,
  p_min int,
  p_is_individual boolean,
  p_targets uuid[],
  p_num_targets int
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  i int;
  v_target uuid;
  v_count int;
BEGIN
  -- FAIL CLOSED: a per-student minimum cannot be verified with no students to grade. Zero targets
  -- used to fall back to the submission-wide count, which answers a different question.
  IF p_is_individual AND COALESCE(p_num_targets, 0) = 0 THEN
    RETURN false;
  END IF;

  IF NOT p_is_individual THEN
    SELECT COUNT(DISTINCT rc.id)
    INTO v_count
    FROM rubric_checks rc
    WHERE rc.rubric_criteria_id = p_rubric_criteria_id
      AND EXISTS (
        SELECT 1 FROM submission_comments sc
        WHERE sc.submission_review_id = p_submission_review_id
          AND sc.rubric_check_id = rc.id
          AND sc.deleted_at IS NULL
        UNION ALL
        SELECT 1 FROM submission_file_comments sfc
        WHERE sfc.submission_review_id = p_submission_review_id
          AND sfc.rubric_check_id = rc.id
          AND sfc.deleted_at IS NULL
        UNION ALL
        SELECT 1 FROM submission_artifact_comments sac
        WHERE sac.submission_review_id = p_submission_review_id
          AND sac.rubric_check_id = rc.id
          AND sac.deleted_at IS NULL
      );
    RETURN v_count >= p_min;
  END IF;

  FOR i IN 1..p_num_targets LOOP
    v_target := p_targets[i];
    SELECT COUNT(DISTINCT rc.id)
    INTO v_count
    FROM rubric_checks rc
    WHERE rc.rubric_criteria_id = p_rubric_criteria_id
      AND EXISTS (
        SELECT 1 FROM submission_comments sc
        WHERE sc.submission_review_id = p_submission_review_id
          AND sc.rubric_check_id = rc.id
          AND sc.deleted_at IS NULL
          AND sc.target_student_profile_id = v_target
        UNION ALL
        SELECT 1 FROM submission_file_comments sfc
        WHERE sfc.submission_review_id = p_submission_review_id
          AND sfc.rubric_check_id = rc.id
          AND sfc.deleted_at IS NULL
          AND sfc.target_student_profile_id = v_target
        UNION ALL
        SELECT 1 FROM submission_artifact_comments sac
        WHERE sac.submission_review_id = p_submission_review_id
          AND sac.rubric_check_id = rc.id
          AND sac.deleted_at IS NULL
          AND sac.target_student_profile_id = v_target
      );
    IF v_count < p_min THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.criteria_max_satisfied_for_uncovered(
  p_submission_review_id bigint,
  p_rubric_criteria_id bigint,
  p_max int,
  p_is_individual boolean,
  p_targets uuid[],
  p_num_targets int
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  i int;
  v_target uuid;
  v_count int;
BEGIN
  -- FAIL CLOSED: a per-student maximum cannot be verified with no students to grade. Zero targets
  -- used to fall back to the submission-wide count, which answers a different question.
  IF p_is_individual AND COALESCE(p_num_targets, 0) = 0 THEN
    RETURN false;
  END IF;

  IF NOT p_is_individual THEN
    SELECT COUNT(DISTINCT rc.id)
    INTO v_count
    FROM rubric_checks rc
    WHERE rc.rubric_criteria_id = p_rubric_criteria_id
      AND EXISTS (
        SELECT 1 FROM submission_comments sc
        WHERE sc.submission_review_id = p_submission_review_id
          AND sc.rubric_check_id = rc.id
          AND sc.deleted_at IS NULL
        UNION ALL
        SELECT 1 FROM submission_file_comments sfc
        WHERE sfc.submission_review_id = p_submission_review_id
          AND sfc.rubric_check_id = rc.id
          AND sfc.deleted_at IS NULL
        UNION ALL
        SELECT 1 FROM submission_artifact_comments sac
        WHERE sac.submission_review_id = p_submission_review_id
          AND sac.rubric_check_id = rc.id
          AND sac.deleted_at IS NULL
      );
    RETURN v_count <= p_max;
  END IF;

  FOR i IN 1..p_num_targets LOOP
    v_target := p_targets[i];
    SELECT COUNT(DISTINCT rc.id)
    INTO v_count
    FROM rubric_checks rc
    WHERE rc.rubric_criteria_id = p_rubric_criteria_id
      AND EXISTS (
        SELECT 1 FROM submission_comments sc
        WHERE sc.submission_review_id = p_submission_review_id
          AND sc.rubric_check_id = rc.id
          AND sc.deleted_at IS NULL
          AND sc.target_student_profile_id = v_target
        UNION ALL
        SELECT 1 FROM submission_file_comments sfc
        WHERE sfc.submission_review_id = p_submission_review_id
          AND sfc.rubric_check_id = rc.id
          AND sfc.deleted_at IS NULL
          AND sfc.target_student_profile_id = v_target
        UNION ALL
        SELECT 1 FROM submission_artifact_comments sac
        WHERE sac.submission_review_id = p_submission_review_id
          AND sac.rubric_check_id = rc.id
          AND sac.deleted_at IS NULL
          AND sac.target_student_profile_id = v_target
      );
    IF v_count > p_max THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.check_required_check_satisfied_for_uncovered(bigint, bigint, boolean, uuid[], int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.criteria_min_satisfied_for_uncovered(bigint, bigint, int, boolean, uuid[], int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.criteria_max_satisfied_for_uncovered(bigint, bigint, int, boolean, uuid[], int) FROM PUBLIC;

-- Uncovered rubric parts: same rules when deciding if submission_review can auto-complete.
CREATE OR REPLACE FUNCTION public.check_and_complete_submission_review()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  target_submission_review_id bigint;
  target_rubric_id bigint;
  completing_user_id uuid;
  completing_review_assignment_id bigint;
  current_assignment_part_ids bigint[];
  covered_part_ids bigint[];
  has_blocking_uncovered_parts boolean := false;
  v_submission_id bigint;
  v_assignments jsonb;
  v_targets uuid[];
  v_num_targets int;
BEGIN
  IF OLD.completed_at IS NOT NULL OR NEW.completed_at IS NULL THEN
    RETURN NEW;
  END IF;

  target_submission_review_id := NEW.submission_review_id;
  completing_user_id := NEW.completed_by;
  completing_review_assignment_id := NEW.id;

  PERFORM pg_advisory_xact_lock(target_submission_review_id);

  SELECT rubric_id INTO target_rubric_id
  FROM submission_reviews
  WHERE id = target_submission_review_id;

  IF NOT FOUND THEN
    RAISE WARNING 'submission_review with id % does not exist', target_submission_review_id;
    RETURN NEW;
  END IF;

  IF target_rubric_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT sr.submission_id, COALESCE(sr.rubric_part_student_assignments, '{}'::jsonb)
  INTO v_submission_id, v_assignments
  FROM submission_reviews sr
  WHERE sr.id = target_submission_review_id;

  v_targets := public._grade_targets_for_submission(v_submission_id);
  v_num_targets := COALESCE(array_length(v_targets, 1), 0);

  IF pg_trigger_depth() = 1 THEN
    SELECT array_agg(rubric_part_id ORDER BY rubric_part_id)
    INTO current_assignment_part_ids
    FROM review_assignment_rubric_parts
    WHERE review_assignment_id = completing_review_assignment_id;

    UPDATE review_assignments ra_target
    SET completed_at = NEW.completed_at,
        completed_by = completing_user_id
    WHERE ra_target.submission_review_id = target_submission_review_id
      AND ra_target.id != completing_review_assignment_id
      AND ra_target.completed_at IS NULL
      AND (
        (current_assignment_part_ids IS NULL)
        OR (
          current_assignment_part_ids IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM review_assignment_rubric_parts rarp
            WHERE rarp.review_assignment_id = ra_target.id
          )
          AND current_assignment_part_ids @> (
            SELECT array_agg(rarp.rubric_part_id)
            FROM review_assignment_rubric_parts rarp
            WHERE rarp.review_assignment_id = ra_target.id
          )
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM review_assignments ra
    WHERE ra.submission_review_id = target_submission_review_id
      AND ra.completed_at IS NULL
  ) THEN
    SELECT CASE
      WHEN EXISTS (
        SELECT 1
        FROM review_assignments ra
        WHERE ra.submission_review_id = target_submission_review_id
          AND NOT EXISTS (
            SELECT 1 FROM review_assignment_rubric_parts rarp
            WHERE rarp.review_assignment_id = ra.id
          )
      ) THEN NULL
      ELSE (
        SELECT array_agg(DISTINCT rarp.rubric_part_id)
        FROM review_assignments ra
        JOIN review_assignment_rubric_parts rarp ON rarp.review_assignment_id = ra.id
        WHERE ra.submission_review_id = target_submission_review_id
      )
    END INTO covered_part_ids;

    IF covered_part_ids IS NOT NULL THEN
      -- The helpers below now return false for an is_individual_grading part with zero grade
      -- targets, so an uncovered per-student requirement blocks completion instead of being
      -- satisfied by any one comment.
      SELECT EXISTS (
        SELECT 1
        FROM rubric_checks rc
        JOIN rubric_criteria rcrit ON rc.rubric_criteria_id = rcrit.id
        JOIN rubric_parts rp ON rcrit.rubric_part_id = rp.id
        WHERE rc.rubric_id = target_rubric_id
          AND rc.is_required = true
          AND rcrit.rubric_part_id IS NOT NULL
          AND NOT (rcrit.rubric_part_id = ANY (covered_part_ids))
          AND NOT (
            rp.is_assign_to_student
            AND (
              (v_assignments ->> rcrit.rubric_part_id::text) IS NULL
              OR (v_assignments ->> rcrit.rubric_part_id::text) = ''
            )
          )
          AND NOT check_required_check_satisfied_for_uncovered(
            target_submission_review_id,
            rc.id,
            rp.is_individual_grading,
            v_targets,
            v_num_targets
          )
      ) INTO has_blocking_uncovered_parts;

      IF NOT has_blocking_uncovered_parts THEN
        SELECT EXISTS (
          SELECT 1
          FROM rubric_criteria rcrit
          JOIN rubric_parts rp ON rcrit.rubric_part_id = rp.id
          WHERE rcrit.rubric_id = target_rubric_id
            AND rcrit.rubric_part_id IS NOT NULL
            AND NOT (rcrit.rubric_part_id = ANY (covered_part_ids))
            AND NOT (
              rp.is_assign_to_student
              AND (
                (v_assignments ->> rcrit.rubric_part_id::text) IS NULL
                OR (v_assignments ->> rcrit.rubric_part_id::text) = ''
              )
            )
            AND (
              (
                rcrit.min_checks_per_submission IS NOT NULL
                AND NOT criteria_min_satisfied_for_uncovered(
                  target_submission_review_id,
                  rcrit.id,
                  rcrit.min_checks_per_submission,
                  rp.is_individual_grading,
                  v_targets,
                  v_num_targets
                )
              )
              OR (
                rcrit.max_checks_per_submission IS NOT NULL
                AND NOT criteria_max_satisfied_for_uncovered(
                  target_submission_review_id,
                  rcrit.id,
                  rcrit.max_checks_per_submission,
                  rp.is_individual_grading,
                  v_targets,
                  v_num_targets
                )
              )
            )
        ) INTO has_blocking_uncovered_parts;
      END IF;
    END IF;

    IF NOT has_blocking_uncovered_parts THEN
      UPDATE submission_reviews
      SET
        completed_at = NEW.completed_at,
        completed_by = completing_user_id
      WHERE id = target_submission_review_id
        AND completed_at IS NULL;
    ELSIF v_num_targets = 0 AND EXISTS (
      SELECT 1
      FROM rubric_criteria rcrit
      JOIN rubric_parts rp ON rcrit.rubric_part_id = rp.id
      WHERE rcrit.rubric_id = target_rubric_id
        AND rp.is_individual_grading
    ) THEN
      -- This trigger cannot raise: the review assignment completion it fires on is legal, and the
      -- pre-existing contract for a blocking uncovered part is to leave the submission review open.
      -- But "no students to grade" is a data problem an instructor has to fix, so name it rather
      -- than leaving an unexplained incomplete review behind.
      RAISE WARNING 'submission_review % left incomplete: rubric % has per-student (is_individual_grading) parts but submission % has no students to grade (its assignment group is empty). Add the group member(s) back to the assignment group, or turn off per-student grading for the rubric part.',
        target_submission_review_id, target_rubric_id, v_submission_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.check_and_complete_submission_review() IS
  'On review_assignment completion: sibling completion, then submission_review if all assignments done and uncovered parts are non-blocking (individual/assign-to-student aware). Fails closed on an is_individual_grading part with no students to grade (empty assignment group): the submission_review is left incomplete and a warning names the cause.';
