-- Migration: Add RPCs for checking grading completion eligibility and marking eligible reviews complete.
-- Mirrors validation logic from validate_review_assignment_completion (20251120201200).
-- For submission_reviews we check the full rubric (no rubric part filtering).

-- Internal function: returns true if submission_review has all required checks and criteria satisfied.
-- SECURITY DEFINER: runs as owner; must set search_path to prevent search-path injection.
CREATE OR REPLACE FUNCTION public._submission_review_is_completable(p_submission_review_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_rubric_id bigint;
  v_check_record record;
  v_criteria_record record;
BEGIN
  SELECT sr.rubric_id INTO v_rubric_id
  FROM public.submission_reviews sr
  WHERE sr.id = p_submission_review_id;

  IF v_rubric_id IS NULL THEN
    RETURN false;
  END IF;

  -- Check for missing required checks
  FOR v_check_record IN
    SELECT 1
    FROM public.rubric_checks rc
    INNER JOIN public.rubric_criteria rcrit ON rcrit.id = rc.rubric_criteria_id
    WHERE rc.rubric_id = v_rubric_id
      AND rc.is_required = true
      AND NOT EXISTS (
        SELECT 1 FROM public.submission_comments sc
        WHERE sc.submission_review_id = p_submission_review_id AND sc.rubric_check_id = rc.id AND sc.deleted_at IS NULL
        UNION
        SELECT 1 FROM public.submission_file_comments sfc
        WHERE sfc.submission_review_id = p_submission_review_id AND sfc.rubric_check_id = rc.id AND sfc.deleted_at IS NULL
        UNION
        SELECT 1 FROM public.submission_artifact_comments sac
        WHERE sac.submission_review_id = p_submission_review_id AND sac.rubric_check_id = rc.id AND sac.deleted_at IS NULL
      )
    LIMIT 1
  LOOP
    RETURN false;
  END LOOP;

  -- Check for missing required criteria and criteria exceeding max_checks_per_submission
  FOR v_criteria_record IN
    SELECT
      rcrit.min_checks_per_submission,
      rcrit.max_checks_per_submission,
      COALESCE(
        (
          SELECT COUNT(DISTINCT rc2.id)
          FROM public.rubric_checks rc2
          WHERE rc2.rubric_criteria_id = rcrit.id
            AND EXISTS (
              SELECT 1 FROM public.submission_comments sc
              WHERE sc.submission_review_id = p_submission_review_id AND sc.rubric_check_id = rc2.id AND sc.deleted_at IS NULL
              UNION
              SELECT 1 FROM public.submission_file_comments sfc
              WHERE sfc.submission_review_id = p_submission_review_id AND sfc.rubric_check_id = rc2.id AND sfc.deleted_at IS NULL
              UNION
              SELECT 1 FROM public.submission_artifact_comments sac
              WHERE sac.submission_review_id = p_submission_review_id AND sac.rubric_check_id = rc2.id AND sac.deleted_at IS NULL
            )
        ),
        0
      ) AS check_count_applied
    FROM public.rubric_criteria rcrit
    WHERE rcrit.rubric_id = v_rubric_id
  LOOP
    IF v_criteria_record.min_checks_per_submission IS NOT NULL
       AND v_criteria_record.check_count_applied < v_criteria_record.min_checks_per_submission THEN
      RETURN false;
    END IF;
    IF v_criteria_record.max_checks_per_submission IS NOT NULL
       AND v_criteria_record.check_count_applied > v_criteria_record.max_checks_per_submission THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN true;
END;
$$;

-- Revoke so only owner (and SECURITY DEFINER callers) can execute; prevents direct client calls.
REVOKE EXECUTE ON FUNCTION public._submission_review_is_completable(bigint) FROM PUBLIC;

-- RPC 1: Returns counts of incomplete reviews, completable, and those with missing required checks.
-- SECURITY DEFINER so it can call _submission_review_is_completable (which is not granted to authenticated).
CREATE OR REPLACE FUNCTION public.check_grading_completion_eligibility(p_assignment_id bigint)
RETURNS TABLE (
  total_incomplete bigint,
  completable bigint,
  missing_required_checks bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_class_id bigint;
  v_total bigint := 0;
  v_completable bigint := 0;
  v_missing bigint := 0;
  v_sr_id bigint;
BEGIN
  SELECT a.class_id INTO v_class_id FROM public.assignments a WHERE a.id = p_assignment_id;
  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'Assignment % does not exist', p_assignment_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT public.authorizeforclassgrader(v_class_id) THEN
    RAISE EXCEPTION 'Access denied: insufficient permissions for assignment %', p_assignment_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Only grading reviews (s.grading_review_id = sr.id), not self-review or other rubric types
  FOR v_sr_id IN
    SELECT sr.id
    FROM public.submission_reviews sr
    INNER JOIN public.submissions s ON s.id = sr.submission_id AND s.grading_review_id = sr.id
    WHERE s.assignment_id = p_assignment_id
      AND s.is_active = true
      AND sr.completed_at IS NULL
  LOOP
    v_total := v_total + 1;
    IF public._submission_review_is_completable(v_sr_id) THEN
      v_completable := v_completable + 1;
    ELSE
      v_missing := v_missing + 1;
    END IF;
  END LOOP;

  total_incomplete := v_total;
  completable := v_completable;
  missing_required_checks := v_missing;
  RETURN NEXT;
END;
$$;

-- RPC 2: Marks only eligible submission reviews as complete. Returns count of updated rows.
-- SECURITY DEFINER so it can call _submission_review_is_completable (which is not granted to authenticated).
CREATE OR REPLACE FUNCTION public.complete_eligible_grading_reviews(p_assignment_id bigint)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_class_id bigint;
  v_profile_id uuid;
  affected_rows integer;
BEGIN
  SELECT a.class_id INTO v_class_id FROM public.assignments a WHERE a.id = p_assignment_id;
  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'Assignment % does not exist', p_assignment_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT public.authorizeforclassgrader(v_class_id) THEN
    RAISE EXCEPTION 'Access denied: insufficient permissions for assignment %', p_assignment_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- completed_by must reference profiles(id); get current user's private_profile_id for this class
  SELECT ur.private_profile_id INTO v_profile_id
  FROM public.user_roles ur
  WHERE ur.user_id = auth.uid()
    AND ur.class_id = v_class_id
    AND ur.role IN ('instructor', 'grader')
  LIMIT 1;
  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION 'Could not resolve profile for current user in class %', v_class_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Only grading reviews (s.grading_review_id = sr.id), not self-review or other rubric types
  UPDATE public.submission_reviews sr
  SET completed_at = now(),
      completed_by = v_profile_id
  FROM public.submissions s
  WHERE s.id = sr.submission_id
    AND s.grading_review_id = sr.id
    AND s.assignment_id = p_assignment_id
    AND s.is_active = true
    AND sr.completed_at IS NULL
    AND public._submission_review_is_completable(sr.id);

  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  RETURN affected_rows;
END;
$$;

COMMENT ON FUNCTION public.check_grading_completion_eligibility(bigint) IS
'Returns counts of incomplete submission reviews: total_incomplete, completable (all required checks applied), and missing_required_checks. Used by Mark All Complete UI.';

COMMENT ON FUNCTION public.complete_eligible_grading_reviews(bigint) IS
'Marks only eligible submission reviews as complete (those with all required rubric checks applied). Skips reviews with missing required checks to avoid errors.';

GRANT EXECUTE ON FUNCTION public.check_grading_completion_eligibility(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_eligible_grading_reviews(bigint) TO authenticated;

-- Fix: complete_remaining_review_assignments trigger fails with
-- "relation 'review_assignments' does not exist" when search_path doesn't include public.
-- Add explicit schema qualification and search_path for reliable resolution.
CREATE OR REPLACE FUNCTION public.complete_remaining_review_assignments()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only proceed if completed_at was just set (not updated from one non-null value to another)
  IF OLD.completed_at IS NOT NULL OR NEW.completed_at IS NULL THEN
    RETURN NEW;
  END IF;

  -- Complete any remaining incomplete review assignments for this submission review
  UPDATE public.review_assignments
  SET
    completed_at = NEW.completed_at,
    completed_by = NEW.completed_by
  WHERE submission_review_id = NEW.id
    AND completed_at IS NULL;

  RETURN NEW;
END;
$$;
