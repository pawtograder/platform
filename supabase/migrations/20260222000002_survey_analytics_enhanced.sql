-- Migration: Survey analytics enhancement - full context RPC, survey series, trend data
-- Enables multi-level analytics (course, section, group), survey series for trends,
-- and per-survey analytics configuration

-- =============================================================================
-- 1. New RPC: get_survey_responses_with_full_context (extends group context with sections)
-- NOTE: Authorization check is inlined (not a function call) for performance
-- =============================================================================
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

-- =============================================================================
-- 2. Survey series table for linking weekly surveys (trend analysis)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.survey_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id bigint NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  created_at timestamptz DEFAULT now() NOT NULL,
  created_by uuid REFERENCES public.profiles(id),
  CONSTRAINT survey_series_unique_name UNIQUE (class_id, name)
);

-- Link surveys to series with ordinal position
ALTER TABLE public.surveys ADD COLUMN IF NOT EXISTS series_id uuid
  REFERENCES public.survey_series(id) ON DELETE SET NULL;
ALTER TABLE public.surveys ADD COLUMN IF NOT EXISTS series_ordinal integer;

-- Index for efficient series queries
CREATE INDEX IF NOT EXISTS idx_surveys_series ON public.surveys(series_id, series_ordinal)
  WHERE series_id IS NOT NULL;

-- Analytics configuration stored per survey (not hardcoded)
ALTER TABLE public.surveys ADD COLUMN IF NOT EXISTS analytics_config jsonb DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.surveys.analytics_config IS 'Per-question analytics configuration: thresholds, alerts, display settings';

-- RLS policies with inlined authorization checks for performance
ALTER TABLE public.survey_series ENABLE ROW LEVEL SECURITY;

CREATE POLICY "survey_series_select_graders" ON public.survey_series
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_privileges up
      WHERE up.user_id = auth.uid()
        AND up.class_id = survey_series.class_id
        AND up.role IN ('instructor', 'grader')
    )
  );

CREATE POLICY "survey_series_manage_instructors" ON public.survey_series
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_privileges up
      WHERE up.user_id = auth.uid()
        AND up.class_id = survey_series.class_id
        AND up.role = 'instructor'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_privileges up
      WHERE up.user_id = auth.uid()
        AND up.class_id = survey_series.class_id
        AND up.role = 'instructor'
    )
  );

-- =============================================================================
-- 3. RPC: get_survey_series_trend_data for trend charts
-- NOTE: Authorization check is inlined (not a function call) for performance
-- =============================================================================
CREATE OR REPLACE FUNCTION public.get_survey_series_trend_data(
  p_series_id uuid,
  p_class_id bigint
)
RETURNS TABLE(
  survey_id uuid,
  survey_title text,
  series_ordinal integer,
  due_date timestamptz,
  group_id bigint,
  group_name text,
  question_name text,
  mean_value numeric,
  response_count integer
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    s.id as survey_id,
    s.title as survey_title,
    s.series_ordinal,
    s.due_date,
    ag.id as group_id,
    ag.name as group_name,
    q.key as question_name,
    AVG((sr.response->>q.key)::numeric) as mean_value,
    COUNT(*)::integer as response_count
  FROM surveys s
  JOIN survey_responses sr ON sr.survey_id = s.id AND sr.is_submitted = true AND sr.deleted_at IS NULL
  LEFT JOIN assignment_groups_members agm ON agm.profile_id = sr.profile_id AND agm.assignment_id = s.assignment_id
  LEFT JOIN assignment_groups ag ON ag.id = agm.assignment_group_id
  CROSS JOIN LATERAL jsonb_object_keys(sr.response) AS q(key)
  WHERE s.series_id = p_series_id
    AND s.class_id = p_class_id
    AND s.deleted_at IS NULL
    AND sr.response->>q.key IS NOT NULL
    AND (sr.response->>q.key) ~ '^-?[0-9]+\.?[0-9]*$'
    AND EXISTS (
      SELECT 1 FROM public.user_privileges up
      WHERE up.user_id = auth.uid()
        AND up.class_id = p_class_id
        AND up.role IN ('instructor', 'grader')
    )
  GROUP BY s.id, s.title, s.series_ordinal, s.due_date, ag.id, ag.name, q.key
  ORDER BY s.series_ordinal, ag.name, q.key
$$;
