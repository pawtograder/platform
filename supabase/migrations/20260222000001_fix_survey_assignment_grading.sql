-- Fix: Add authorization and available_at filtering to get_survey_status_for_assignment
-- Security: The original function used SECURITY DEFINER without authorization checks,
-- allowing any authenticated user to query arbitrary assignment/profile data.

CREATE OR REPLACE FUNCTION public.get_survey_status_for_assignment(
  p_assignment_id bigint,
  p_profile_id uuid
)
RETURNS TABLE(
  survey_id uuid,
  survey_title text,
  survey_status survey_status,
  is_submitted boolean,
  submitted_at timestamptz,
  due_date timestamptz,
  available_at timestamptz
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    s.id as survey_id,
    s.title as survey_title,
    s.status as survey_status,
    COALESCE(sr.is_submitted, false) as is_submitted,
    sr.submitted_at,
    s.due_date,
    s.available_at
  FROM surveys s
  LEFT JOIN survey_responses sr ON sr.survey_id = s.id AND sr.profile_id = p_profile_id AND sr.deleted_at IS NULL
  WHERE s.assignment_id = p_assignment_id
    AND s.deleted_at IS NULL
    AND s.status IN ('published', 'closed')
    AND (s.available_at IS NULL OR s.available_at <= now())
    AND authorizeforclass(s.class_id)
$$;

-- Fix: Add class_id check to surveys_assignment_id_fkey to prevent cross-class linkage
-- We add a CHECK constraint that validates assignment belongs to same class
CREATE OR REPLACE FUNCTION public.check_survey_assignment_same_class()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.assignment_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM assignments a
      WHERE a.id = NEW.assignment_id
        AND a.class_id = NEW.class_id
    ) THEN
      RAISE EXCEPTION 'Assignment must belong to the same class as the survey';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS check_survey_assignment_class ON public.surveys;

CREATE TRIGGER check_survey_assignment_class
  BEFORE INSERT OR UPDATE OF assignment_id ON public.surveys
  FOR EACH ROW
  EXECUTE FUNCTION public.check_survey_assignment_same_class();
