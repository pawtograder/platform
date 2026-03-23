-- Individual / assign-to-student rubric modes: completion validation, mutual exclusivity, comment targets.
-- Complements 20260322000000_assign_to_student_grading_mode.sql (submissionreviewrecompute).

-- Mutual exclusivity: a rubric part cannot be both modes at once.
UPDATE public.rubric_parts
SET is_assign_to_student = false
WHERE is_individual_grading = true AND is_assign_to_student = true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_grading_mode_exclusive' AND conrelid = 'public.rubric_parts'::regclass
  ) THEN
    ALTER TABLE public.rubric_parts
      ADD CONSTRAINT chk_grading_mode_exclusive
      CHECK (NOT (is_individual_grading = true AND is_assign_to_student = true));
  END IF;
END $$;

-- Profile IDs to grade for this submission: group members or sole submitter.
CREATE OR REPLACE FUNCTION public._grade_targets_for_submission(p_submission_id bigint)
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group_id bigint;
  v_assignment_id bigint;
  v_profile_id uuid;
  v_targets uuid[];
BEGIN
  SELECT assignment_group_id, assignment_id, profile_id
  INTO v_group_id, v_assignment_id, v_profile_id
  FROM public.submissions
  WHERE id = p_submission_id;

  IF v_group_id IS NOT NULL THEN
    SELECT COALESCE(array_agg(agm.profile_id ORDER BY agm.profile_id), ARRAY[]::uuid[])
    INTO v_targets
    FROM public.assignment_groups_members agm
    WHERE agm.assignment_group_id = v_group_id
      AND agm.assignment_id = v_assignment_id;
    RETURN v_targets;
  ELSIF v_profile_id IS NOT NULL THEN
    RETURN ARRAY[v_profile_id];
  ELSE
    RETURN ARRAY[]::uuid[];
  END IF;
END;
$$;

COMMENT ON FUNCTION public._grade_targets_for_submission(bigint) IS
  'Returns profile_ids that receive per-student grading for a submission (group members or single submitter).';

REVOKE ALL ON FUNCTION public._grade_targets_for_submission(bigint) FROM PUBLIC;

-- Enforce target_student_profile_id for rubric-linked comments based on rubric part mode.
CREATE OR REPLACE FUNCTION public.enforce_rubric_comment_target_student()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_individual boolean;
  v_assign boolean;
BEGIN
  IF NEW.rubric_check_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT rp.is_individual_grading, rp.is_assign_to_student
  INTO v_individual, v_assign
  FROM public.rubric_checks rc
  INNER JOIN public.rubric_criteria c ON c.id = rc.rubric_criteria_id
  INNER JOIN public.rubric_parts rp ON rp.id = c.rubric_part_id
  WHERE rc.id = NEW.rubric_check_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF v_individual THEN
    IF NEW.target_student_profile_id IS NULL THEN
      RAISE EXCEPTION
        'Rubric comments for individual grading parts require target_student_profile_id (rubric_check_id=%)',
        NEW.rubric_check_id;
    END IF;
    -- Validate the target is an actual group member for the submission
    IF NOT EXISTS (
      SELECT 1 FROM public.submissions s
      JOIN public.assignment_groups_members agm ON agm.assignment_group_id = s.assignment_group_id
      WHERE s.id = NEW.submission_id AND agm.profile_id = NEW.target_student_profile_id
    ) THEN
      RAISE EXCEPTION
        'target_student_profile_id (%) is not a member of the submission group (submission_id=%)',
        NEW.target_student_profile_id, NEW.submission_id;
    END IF;
  ELSIF NOT v_assign THEN
    IF NEW.target_student_profile_id IS NOT NULL THEN
      RAISE EXCEPTION
        'target_student_profile_id must be null for rubric checks that are not individual or assign-to-student (rubric_check_id=%)',
        NEW.rubric_check_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Create triggers as initially DISABLED until all comment writers pass target_student_profile_id.
-- Enable with: ALTER TABLE ... ENABLE TRIGGER tr_enforce_rubric_comment_target_...;

DROP TRIGGER IF EXISTS tr_enforce_rubric_comment_target_submission_comments ON public.submission_comments;
CREATE TRIGGER tr_enforce_rubric_comment_target_submission_comments
  BEFORE INSERT OR UPDATE OF rubric_check_id, target_student_profile_id, deleted_at ON public.submission_comments
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_rubric_comment_target_student();
ALTER TABLE public.submission_comments DISABLE TRIGGER tr_enforce_rubric_comment_target_submission_comments;

DROP TRIGGER IF EXISTS tr_enforce_rubric_comment_target_submission_file_comments ON public.submission_file_comments;
CREATE TRIGGER tr_enforce_rubric_comment_target_submission_file_comments
  BEFORE INSERT OR UPDATE OF rubric_check_id, target_student_profile_id, deleted_at ON public.submission_file_comments
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_rubric_comment_target_student();
ALTER TABLE public.submission_file_comments DISABLE TRIGGER tr_enforce_rubric_comment_target_submission_file_comments;

DROP TRIGGER IF EXISTS tr_enforce_rubric_comment_target_submission_artifact_comments ON public.submission_artifact_comments;
CREATE TRIGGER tr_enforce_rubric_comment_target_submission_artifact_comments
  BEFORE INSERT OR UPDATE OF rubric_check_id, target_student_profile_id, deleted_at ON public.submission_artifact_comments
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_rubric_comment_target_student();
ALTER TABLE public.submission_artifact_comments DISABLE TRIGGER tr_enforce_rubric_comment_target_submission_artifact_comments;

COMMENT ON FUNCTION public.enforce_rubric_comment_target_student() IS
  'Requires target_student_profile_id for is_individual_grading parts; forbids it for standard parts; allows either for is_assign_to_student.';

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
     OR COALESCE(array_length(v_exceeding_max, 1), 0) > 0 THEN
    v_error_message := '';

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
  'Validates review assignment completion: required checks/criteria; per-student rules for is_individual_grading; skips is_assign_to_student parts when not assigned in rubric_part_student_assignments.';

-- Submission review bulk-completeness (full rubric).
CREATE OR REPLACE FUNCTION public._submission_review_is_completable(p_submission_review_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
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

-- Helpers for uncovered-part checks (must exist before check_and_complete_submission_review).
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
  IF NOT p_is_individual OR p_num_targets IS NULL OR p_num_targets = 0 THEN
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
  IF NOT p_is_individual OR p_num_targets IS NULL OR p_num_targets = 0 THEN
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

REVOKE ALL ON FUNCTION public.check_required_check_satisfied_for_uncovered(bigint, bigint, boolean, uuid[], int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.criteria_min_satisfied_for_uncovered(bigint, bigint, int, boolean, uuid[], int) FROM PUBLIC;

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
            AND rcrit.min_checks_per_submission IS NOT NULL
            AND rcrit.rubric_part_id IS NOT NULL
            AND NOT (rcrit.rubric_part_id = ANY (covered_part_ids))
            AND NOT (
              rp.is_assign_to_student
              AND (
                (v_assignments ->> rcrit.rubric_part_id::text) IS NULL
                OR (v_assignments ->> rcrit.rubric_part_id::text) = ''
              )
            )
            AND NOT criteria_min_satisfied_for_uncovered(
              target_submission_review_id,
              rcrit.id,
              rcrit.min_checks_per_submission,
              rp.is_individual_grading,
              v_targets,
              v_num_targets
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
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.check_and_complete_submission_review() IS
  'On review_assignment completion: sibling completion, then submission_review if all assignments done and uncovered parts are non-blocking (individual/assign-to-student aware).';
