-- Migration: Enforce Review Assignment Completion Validation
-- Purpose: Prevent completing review assignments with missing required rubric checks or criteria,
--          or when criteria exceed max_checks_per_submission. Validation respects rubric parts
--          filtering when review assignments are assigned to specific parts.

-- Create function to validate review assignment completion
CREATE OR REPLACE FUNCTION validate_review_assignment_completion()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_submission_review_id bigint;
  v_rubric_id bigint;
  v_assigned_part_ids bigint[];
  v_missing_checks text[] := ARRAY[]::text[];
  v_missing_criteria text[] := ARRAY[]::text[];
  v_exceeding_max text[] := ARRAY[]::text[];
  v_error_message text;
  v_check_record record;
  v_criteria_record record;
BEGIN
  -- Get submission_review_id and rubric_id from the review assignment
  v_submission_review_id := NEW.submission_review_id;
  v_rubric_id := NEW.rubric_id;

  -- If no submission_review_id or rubric_id, skip validation
  IF v_submission_review_id IS NULL OR v_rubric_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Get assigned rubric part IDs for this review assignment
  SELECT ARRAY_AGG(rubric_part_id) INTO v_assigned_part_ids
  FROM review_assignment_rubric_parts
  WHERE review_assignment_id = NEW.id;

  -- Check for missing required checks
  -- Get all required checks for the relevant parts (or all parts if none assigned)
  FOR v_check_record IN
    SELECT DISTINCT rc.id, rc.name
    FROM rubric_checks rc
    INNER JOIN rubric_criteria rcrit ON rc.rubric_criteria_id = rcrit.id
    WHERE rc.rubric_id = v_rubric_id
      AND rc.is_required = true
      AND (
        v_assigned_part_ids IS NULL 
        OR array_length(v_assigned_part_ids, 1) = 0
        OR rcrit.rubric_part_id = ANY(v_assigned_part_ids)
      )
      AND NOT EXISTS (
        -- Check if this check has at least one comment in any of the comment tables
        SELECT 1
        FROM submission_comments
        WHERE submission_review_id = v_submission_review_id
          AND rubric_check_id = rc.id
          AND deleted_at IS NULL
        UNION
        SELECT 1
        FROM submission_file_comments
        WHERE submission_review_id = v_submission_review_id
          AND rubric_check_id = rc.id
          AND deleted_at IS NULL
        UNION
        SELECT 1
        FROM submission_artifact_comments
        WHERE submission_review_id = v_submission_review_id
          AND rubric_check_id = rc.id
          AND deleted_at IS NULL
      )
  LOOP
    v_missing_checks := array_append(v_missing_checks, v_check_record.name);
  END LOOP;

  -- Check for missing required criteria and criteria exceeding max_checks_per_submission
  FOR v_criteria_record IN
    SELECT 
      rcrit.id,
      rcrit.name,
      rcrit.min_checks_per_submission,
      rcrit.max_checks_per_submission,
      COALESCE(
        (
          SELECT COUNT(DISTINCT rc.id)
          FROM rubric_checks rc
          WHERE rc.rubric_criteria_id = rcrit.id
            AND EXISTS (
              -- Check if this check has at least one comment in any of the comment tables
              SELECT 1
              FROM (
                SELECT rubric_check_id
                FROM submission_comments
                WHERE submission_review_id = v_submission_review_id
                  AND rubric_check_id = rc.id
                  AND deleted_at IS NULL
                UNION
                SELECT rubric_check_id
                FROM submission_file_comments
                WHERE submission_review_id = v_submission_review_id
                  AND rubric_check_id = rc.id
                  AND deleted_at IS NULL
                UNION
                SELECT rubric_check_id
                FROM submission_artifact_comments
                WHERE submission_review_id = v_submission_review_id
                  AND rubric_check_id = rc.id
                  AND deleted_at IS NULL
              ) AS applied_checks
            )
        ),
        0
      ) AS check_count_applied
    FROM rubric_criteria rcrit
    WHERE rcrit.rubric_id = v_rubric_id
      AND (
        v_assigned_part_ids IS NULL 
        OR array_length(v_assigned_part_ids, 1) = 0
        OR rcrit.rubric_part_id = ANY(v_assigned_part_ids)
      )
  LOOP
    -- Check for missing required criteria
    IF v_criteria_record.min_checks_per_submission IS NOT NULL 
       AND v_criteria_record.check_count_applied < v_criteria_record.min_checks_per_submission THEN
      v_missing_criteria := array_append(
        v_missing_criteria,
        v_criteria_record.name || ' (need ' || v_criteria_record.min_checks_per_submission || 
        ', have ' || v_criteria_record.check_count_applied || ')'
      );
    END IF;

    -- Check for criteria exceeding max_checks_per_submission
    IF v_criteria_record.max_checks_per_submission IS NOT NULL 
       AND v_criteria_record.check_count_applied > v_criteria_record.max_checks_per_submission THEN
      v_exceeding_max := array_append(
        v_exceeding_max,
        v_criteria_record.name || ' (max ' || v_criteria_record.max_checks_per_submission || 
        ', have ' || v_criteria_record.check_count_applied || ')'
      );
    END IF;
  END LOOP;

  -- Build error message if validation fails
  IF array_length(v_missing_checks, 1) > 0 
     OR array_length(v_missing_criteria, 1) > 0 
     OR array_length(v_exceeding_max, 1) > 0 THEN
    v_error_message := '';
    
    IF array_length(v_missing_checks, 1) > 0 THEN
      v_error_message := v_error_message || 'Missing required checks: ' || 
        array_to_string(v_missing_checks, ', ') || E'\n';
    END IF;
    
    IF array_length(v_missing_criteria, 1) > 0 THEN
      v_error_message := v_error_message || 'Missing required criteria: ' || 
        array_to_string(v_missing_criteria, ', ') || E'\n';
    END IF;
    
    IF array_length(v_exceeding_max, 1) > 0 THEN
      v_error_message := v_error_message || 'Too many checks applied: ' || 
        array_to_string(v_exceeding_max, ', ');
    END IF;
    
    -- Remove trailing newline if present
    v_error_message := rtrim(v_error_message, E'\n');
    
    RAISE EXCEPTION '%', v_error_message;
  END IF;

  RETURN NEW;
END;
$$;

-- Create trigger on review_assignments table
CREATE TRIGGER enforce_review_assignment_completion_validation
  BEFORE UPDATE ON review_assignments
  FOR EACH ROW
  WHEN (OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL)
  EXECUTE FUNCTION validate_review_assignment_completion();

-- Add indexes to optimize validation queries
-- Index on comment tables for efficient lookup of applied checks
CREATE INDEX IF NOT EXISTS idx_submission_comments_review_check_deleted
  ON submission_comments(submission_review_id, rubric_check_id, deleted_at)
  WHERE rubric_check_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_submission_file_comments_review_check_deleted
  ON submission_file_comments(submission_review_id, rubric_check_id, deleted_at)
  WHERE rubric_check_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_submission_artifact_comments_review_check_deleted
  ON submission_artifact_comments(submission_review_id, rubric_check_id, deleted_at)
  WHERE rubric_check_id IS NOT NULL AND deleted_at IS NULL;

-- Index on rubric_checks for efficient filtering by rubric_id and is_required
CREATE INDEX IF NOT EXISTS idx_rubric_checks_rubric_id_is_required
  ON rubric_checks(rubric_id, is_required)
  WHERE is_required = true;

-- Index on rubric_criteria for efficient filtering by rubric_id and rubric_part_id
CREATE INDEX IF NOT EXISTS idx_rubric_criteria_rubric_part_rubric
  ON rubric_criteria(rubric_part_id, rubric_id);

-- Index on review_assignment_rubric_parts for efficient lookup of assigned parts
CREATE INDEX IF NOT EXISTS idx_review_assignment_rubric_parts_assignment_part
  ON review_assignment_rubric_parts(review_assignment_id, rubric_part_id);

COMMENT ON FUNCTION validate_review_assignment_completion() IS 
'Validates that a review assignment can be completed by checking:
1. All required rubric checks have been applied (have comments)
2. All criteria meet minimum checks per submission requirements
3. No criteria exceed maximum checks per submission limits
Validation respects rubric parts filtering when review assignments are assigned to specific parts.';

