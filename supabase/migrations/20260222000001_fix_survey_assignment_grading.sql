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
    AND (authorizeforprofile(p_profile_id) OR authorizeforclassgrader(s.class_id))
$$;

-- Note: Cross-class linkage is enforced by composite FK surveys_assignment_id_fkey
-- (assignment_id, class_id) REFERENCES assignments(id, class_id) in 20260222000000
