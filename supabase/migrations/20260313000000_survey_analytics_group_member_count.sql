-- Add group_member_count to get_survey_responses_with_full_context for correct response rate calculation
-- Previously memberCount was derived from respondents only, making responseRate always 1 when any response existed
-- Must DROP first because PostgreSQL does not allow changing return type with CREATE OR REPLACE

DROP FUNCTION IF EXISTS public.get_survey_responses_with_full_context(uuid, bigint);

CREATE OR REPLACE FUNCTION public.get_survey_responses_with_full_context(
  p_survey_id uuid,
  p_class_id bigint
)
RETURNS TABLE(
  response_id uuid,
  profile_id uuid,
  profile_name text,
  is_submitted boolean,
  submitted_at timestamptz,
  response jsonb,
  group_id bigint,
  group_name text,
  group_member_count integer,
  mentor_profile_id uuid,
  mentor_name text,
  lab_section_id bigint,
  lab_section_name text,
  class_section_id bigint,
  class_section_name text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    sr.id as response_id,
    sr.profile_id,
    p.name as profile_name,
    sr.is_submitted,
    sr.submitted_at,
    sr.response,
    ag.id as group_id,
    ag.name as group_name,
    CASE WHEN ag.id IS NOT NULL THEN (
      SELECT COUNT(*)::integer FROM assignment_groups_members agm2
      WHERE agm2.assignment_group_id = ag.id
    ) ELSE NULL END as group_member_count,
    ag.mentor_profile_id,
    mentor_p.name as mentor_name,
    ur.lab_section_id,
    ls.name as lab_section_name,
    ur.class_section_id,
    cs.name as class_section_name
  FROM survey_responses sr
  JOIN profiles p ON p.id = sr.profile_id
  JOIN surveys s ON s.id = sr.survey_id
  LEFT JOIN user_roles ur ON ur.private_profile_id = sr.profile_id
    AND ur.class_id = s.class_id
    AND ur.disabled = false
  LEFT JOIN lab_sections ls ON ls.id = ur.lab_section_id
  LEFT JOIN class_sections cs ON cs.id = ur.class_section_id
  LEFT JOIN assignment_groups_members agm ON agm.profile_id = sr.profile_id
    AND agm.assignment_id = s.assignment_id
  LEFT JOIN assignment_groups ag ON ag.id = agm.assignment_group_id
  LEFT JOIN profiles mentor_p ON mentor_p.id = ag.mentor_profile_id
  WHERE sr.survey_id = p_survey_id
    AND sr.deleted_at IS NULL
    AND s.class_id = p_class_id
    AND EXISTS (
      SELECT 1 FROM public.user_privileges up
      WHERE up.user_id = auth.uid()
        AND up.class_id = p_class_id
        AND up.role IN ('instructor', 'grader')
    )
$$;
