-- Survey analytics: full group roster (incl. non-respondents when survey has assignment_id),
-- plus profile & mentor emails for instructor UI (mailto links).

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
  profile_email text,
  mentor_email text,
  lab_section_id bigint,
  lab_section_name text,
  class_section_id bigint,
  class_section_name text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH priv AS (
    SELECT EXISTS (
      SELECT 1 FROM public.user_privileges up
      WHERE up.user_id = auth.uid()
        AND up.class_id = p_class_id
        AND up.role IN ('instructor', 'grader')
    ) AS allowed
  )
  SELECT
    sr.id AS response_id,
    agm.profile_id,
    p.name AS profile_name,
    COALESCE(sr.is_submitted, false) AS is_submitted,
    sr.submitted_at,
    COALESCE(sr.response, '{}'::jsonb) AS response,
    ag.id AS group_id,
    ag.name AS group_name,
    (
      SELECT COUNT(*)::integer
      FROM assignment_groups_members agm2
      WHERE agm2.assignment_group_id = ag.id
    ) AS group_member_count,
    ag.mentor_profile_id,
    mentor_p.name AS mentor_name,
    u.email AS profile_email,
    mentor_u.email AS mentor_email,
    ur.lab_section_id,
    ls.name AS lab_section_name,
    ur.class_section_id,
    cs.name AS class_section_name
  FROM surveys s
  JOIN assignment_groups ag ON ag.assignment_id = s.assignment_id
  JOIN assignment_groups_members agm ON agm.assignment_group_id = ag.id
  JOIN profiles p ON p.id = agm.profile_id
  LEFT JOIN survey_responses sr
    ON sr.survey_id = s.id AND sr.profile_id = agm.profile_id AND sr.deleted_at IS NULL
  LEFT JOIN user_roles ur
    ON ur.private_profile_id = agm.profile_id
    AND ur.class_id = s.class_id
    AND ur.disabled = false
  LEFT JOIN users u ON u.user_id = ur.user_id
  LEFT JOIN lab_sections ls ON ls.id = ur.lab_section_id
  LEFT JOIN class_sections cs ON cs.id = ur.class_section_id
  LEFT JOIN profiles mentor_p ON mentor_p.id = ag.mentor_profile_id
  LEFT JOIN user_roles mentor_ur
    ON mentor_ur.private_profile_id = ag.mentor_profile_id
    AND mentor_ur.class_id = s.class_id
    AND mentor_ur.disabled = false
  LEFT JOIN users mentor_u ON mentor_u.user_id = mentor_ur.user_id
  CROSS JOIN priv
  WHERE priv.allowed
    AND s.id = p_survey_id
    AND s.class_id = p_class_id
    AND s.assignment_id IS NOT NULL
    AND s.deleted_at IS NULL

  UNION ALL

  SELECT
    sr.id AS response_id,
    sr.profile_id,
    p.name AS profile_name,
    sr.is_submitted,
    sr.submitted_at,
    sr.response,
    NULL::bigint AS group_id,
    NULL::text AS group_name,
    NULL::integer AS group_member_count,
    NULL::uuid AS mentor_profile_id,
    NULL::text AS mentor_name,
    u.email AS profile_email,
    NULL::text AS mentor_email,
    ur.lab_section_id,
    ls.name AS lab_section_name,
    ur.class_section_id,
    cs.name AS class_section_name
  FROM survey_responses sr
  JOIN profiles p ON p.id = sr.profile_id
  JOIN surveys s ON s.id = sr.survey_id
  LEFT JOIN user_roles ur
    ON ur.private_profile_id = sr.profile_id
    AND ur.class_id = s.class_id
    AND ur.disabled = false
  LEFT JOIN users u ON u.user_id = ur.user_id
  LEFT JOIN lab_sections ls ON ls.id = ur.lab_section_id
  LEFT JOIN class_sections cs ON cs.id = ur.class_section_id
  CROSS JOIN priv
  WHERE priv.allowed
    AND sr.survey_id = p_survey_id
    AND sr.deleted_at IS NULL
    AND s.class_id = p_class_id
    AND s.assignment_id IS NOT NULL
    AND s.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM assignment_groups_members agm
      WHERE agm.profile_id = sr.profile_id
        AND agm.assignment_id = s.assignment_id
    )

  UNION ALL

  SELECT
    sr.id AS response_id,
    sr.profile_id,
    p.name AS profile_name,
    sr.is_submitted,
    sr.submitted_at,
    sr.response,
    ag.id AS group_id,
    ag.name AS group_name,
    CASE WHEN ag.id IS NOT NULL THEN (
      SELECT COUNT(*)::integer FROM assignment_groups_members agm2
      WHERE agm2.assignment_group_id = ag.id
    ) ELSE NULL END AS group_member_count,
    ag.mentor_profile_id,
    mentor_p.name AS mentor_name,
    u.email AS profile_email,
    mentor_u.email AS mentor_email,
    ur.lab_section_id,
    ls.name AS lab_section_name,
    ur.class_section_id,
    cs.name AS class_section_name
  FROM survey_responses sr
  JOIN profiles p ON p.id = sr.profile_id
  JOIN surveys s ON s.id = sr.survey_id
  LEFT JOIN user_roles ur
    ON ur.private_profile_id = sr.profile_id
    AND ur.class_id = s.class_id
    AND ur.disabled = false
  LEFT JOIN users u ON u.user_id = ur.user_id
  LEFT JOIN lab_sections ls ON ls.id = ur.lab_section_id
  LEFT JOIN class_sections cs ON cs.id = ur.class_section_id
  LEFT JOIN assignment_groups_members agm
    ON agm.profile_id = sr.profile_id
    AND agm.assignment_id = s.assignment_id
  LEFT JOIN assignment_groups ag ON ag.id = agm.assignment_group_id
  LEFT JOIN profiles mentor_p ON mentor_p.id = ag.mentor_profile_id
  LEFT JOIN user_roles mentor_ur
    ON mentor_ur.private_profile_id = ag.mentor_profile_id
    AND mentor_ur.class_id = s.class_id
    AND mentor_ur.disabled = false
  LEFT JOIN users mentor_u ON mentor_u.user_id = mentor_ur.user_id
  CROSS JOIN priv
  WHERE priv.allowed
    AND sr.survey_id = p_survey_id
    AND sr.deleted_at IS NULL
    AND s.class_id = p_class_id
    AND s.deleted_at IS NULL
    AND s.assignment_id IS NULL
$$;

GRANT EXECUTE ON FUNCTION public.get_survey_responses_with_full_context(uuid, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_survey_responses_with_full_context(uuid, bigint) TO service_role;
