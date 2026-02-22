-- Migration: Survey-Assignment linking, mentor field on groups, survey availability
-- This enables:
-- 1. Linking surveys to assignments (optional assignment_id on surveys)
-- 2. Adding mentor_profile_id to assignment_groups
-- 3. Adding available_at to surveys for controlling when surveys become visible
-- 4. Grading by group mentors

-- =============================================================================
-- 1. Add assignment_id to surveys (optional FK to assignments)
-- =============================================================================
alter table "public"."surveys" add column "assignment_id" bigint;

alter table "public"."surveys" add constraint "surveys_assignment_id_fkey"
  FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE SET NULL not valid;

alter table "public"."surveys" validate constraint "surveys_assignment_id_fkey";

CREATE INDEX idx_surveys_assignment_id ON public.surveys USING btree (assignment_id) WHERE (assignment_id IS NOT NULL);

-- =============================================================================
-- 2. Add available_at to surveys (controls when survey becomes visible/available)
-- =============================================================================
alter table "public"."surveys" add column "available_at" timestamp with time zone;

-- =============================================================================
-- 3. Add mentor_profile_id to assignment_groups
-- =============================================================================
alter table "public"."assignment_groups" add column "mentor_profile_id" uuid;

alter table "public"."assignment_groups" add constraint "assignment_groups_mentor_profile_id_fkey"
  FOREIGN KEY (mentor_profile_id) REFERENCES profiles(id) ON DELETE SET NULL not valid;

alter table "public"."assignment_groups" validate constraint "assignment_groups_mentor_profile_id_fkey";

CREATE INDEX idx_assignment_groups_mentor ON public.assignment_groups USING btree (mentor_profile_id) WHERE (mentor_profile_id IS NOT NULL);

-- =============================================================================
-- 4. Update surveys_select_students RLS policy to respect available_at
-- Students can only see surveys that are published AND (available_at is null OR available_at <= now)
-- =============================================================================
drop policy if exists "surveys_select_students" on "public"."surveys";

create policy "surveys_select_students"
on "public"."surveys"
as permissive
for select
to public
using ((
  authorizeforclass(class_id)
  AND (deleted_at IS NULL)
  AND (status = ANY (ARRAY['published'::survey_status, 'closed'::survey_status]))
  AND (available_at IS NULL OR available_at <= now())
  AND (
    (assigned_to_all = true)
    OR (EXISTS (
      SELECT 1
      FROM (survey_assignments sa
        JOIN user_privileges up ON (((up.private_profile_id = sa.profile_id) OR (up.public_profile_id = sa.profile_id))))
      WHERE ((sa.survey_id = surveys.id) AND (up.user_id = auth.uid()) AND (up.class_id = surveys.class_id))
    ))
  )
));

-- =============================================================================
-- 5. RPC: Get survey status for a submission (student or group)
-- Returns survey completion status for surveys linked to an assignment
-- =============================================================================
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
$$;

-- =============================================================================
-- 6. RPC: Get survey responses with group context for analytics
-- Returns aggregated survey data for comparison across groups/assignments
-- =============================================================================
CREATE OR REPLACE FUNCTION public.get_survey_responses_with_group_context(
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
  mentor_name text
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
    mentor_p.name as mentor_name
  FROM survey_responses sr
  JOIN profiles p ON p.id = sr.profile_id
  JOIN surveys s ON s.id = sr.survey_id
  LEFT JOIN assignment_groups_members agm ON agm.profile_id = sr.profile_id
    AND agm.assignment_id = s.assignment_id
  LEFT JOIN assignment_groups ag ON ag.id = agm.assignment_group_id
  LEFT JOIN profiles mentor_p ON mentor_p.id = ag.mentor_profile_id
  WHERE sr.survey_id = p_survey_id
    AND sr.deleted_at IS NULL
    AND s.class_id = p_class_id
    AND authorizeforclassgrader(p_class_id)
$$;

-- =============================================================================
-- 7. Allow graders (staff) to update mentor_profile_id on assignment_groups
-- =============================================================================
drop policy if exists "instructors can update groups" on "public"."assignment_groups";

create policy "instructors can update groups"
on "public"."assignment_groups"
as permissive
for update
to authenticated
using (authorizeforclassinstructor(class_id))
with check (authorizeforclassinstructor(class_id));

-- =============================================================================
-- 8. Allow instructors to insert assignment_groups (needed for copy with mentor)
-- =============================================================================
drop policy if exists "instructors can insert groups" on "public"."assignment_groups";

create policy "instructors can insert groups"
on "public"."assignment_groups"
as permissive
for insert
to authenticated
with check (authorizeforclassinstructor(class_id));

-- =============================================================================
-- 9. Broadcast trigger update for surveys to include assignment_id
-- (Already handled by existing broadcast_survey_change trigger)
-- =============================================================================
