-- #1010, area 11: staff actions on surveys follow manage_surveys; staff actions on live
-- polls follow run_polls.
--
-- Why: instructors alone manage surveys today, and graders (and instructors) run live polls.
-- This moves those writes onto the capability tables so an instructor can turn each action
-- on or off for a role, while day-one access stays the same.
--
-- What:
--   * Inserts manage_surveys (instructor role only) and run_polls (instructor, default grader,
--     and every existing custom role). Updates seed_default_class_roles() so new classes put
--     run_polls on the default grader role too (and keep manage_flashcards there). Instructors
--     still get every capability via the CROSS JOIN.
--   * surveys INSERT / UPDATE: authorizeforclassinstructor -> manage_surveys.
--   * survey_assignments INSERT / UPDATE / DELETE: same.
--   * survey_templates INSERT / UPDATE: same. SELECT and creator-only DELETE are unchanged.
--   * survey_series: the instructor FOR ALL policy becomes INSERT / UPDATE / DELETE under
--     manage_surveys. SELECT stays on survey_series_select_graders (a view).
--   * create_survey_assignments, soft_delete_survey, reorder_surveys_in_series: the instructor
--     check inside each function becomes manage_surveys. Signatures, attributes and grants stay.
--   * live_polls INSERT / UPDATE / DELETE: authorizeforclassgrader -> run_polls. The
--     authorizeforprofile(created_by) check on INSERT stays. SELECT policies are unchanged.
--   * live_poll_responses: the staff FOR ALL policy is split so SELECT stays a grader view and
--     INSERT / UPDATE / DELETE follow run_polls. The student/anon insert policy is unchanged.
--
-- Not changed (views and student actions):
--   * surveys_select_staff / surveys_select_students
--   * survey_assignments_select_* / survey_assignments_manage_instructors (SELECT)
--   * survey_responses_* (student writes and staff SELECT)
--   * survey_templates_select / survey_templates_delete (creator-only delete)
--   * survey_series_select_graders
--   * live_polls_select_live / live_polls_select_staff
--   * live_polls_responses_insert (can_access_poll_response)
--   * can_respond_to_survey, analytics RPCs, broadcast triggers
--   * legacy polls / poll_questions / poll_responses tables (unused by the live-poll UI)

INSERT INTO public.capabilities (name, description) VALUES
  ('manage_surveys', 'Create, edit, publish, close, delete and assign surveys'),
  ('run_polls', 'Create, edit, open, close and delete live polls')
ON CONFLICT DO NOTHING;

-- Instructors in existing classes: both capabilities (new classes get them via CROSS JOIN).
INSERT INTO public.role_capabilities (role_id, capability)
SELECT cr.id, 'manage_surveys' FROM public.class_roles cr
WHERE cr.default_for = 'instructor'
ON CONFLICT DO NOTHING;

INSERT INTO public.role_capabilities (role_id, capability)
SELECT cr.id, 'run_polls' FROM public.class_roles cr
WHERE cr.default_for IN ('instructor', 'grader') OR cr.default_for IS NULL
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.seed_default_class_roles(p_class_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  INSERT INTO public.class_roles (class_id, name, default_for)
  VALUES
    (p_class_id, 'instructor', 'instructor'),
    (p_class_id, 'grader', 'grader'),
    (p_class_id, 'student', 'student'),
    (p_class_id, 'admin', 'admin')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.role_capabilities (role_id, capability)
  SELECT cr.id, c.name
  FROM public.class_roles cr
  CROSS JOIN public.capabilities c
  WHERE cr.class_id = p_class_id AND cr.default_for = 'instructor'
  ON CONFLICT DO NOTHING;

  -- Graders can manage flashcards and run live polls today (#1010 areas 13 and 11), so new
  -- classes put both on the default grader role. Instructors already get them from the CROSS JOIN.
  INSERT INTO public.role_capabilities (role_id, capability)
  SELECT cr.id, cap
  FROM public.class_roles cr
  CROSS JOIN (VALUES ('manage_flashcards'), ('run_polls')) AS caps(cap)
  WHERE cr.class_id = p_class_id AND cr.default_for = 'grader'
  ON CONFLICT DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_default_class_roles(bigint) FROM PUBLIC, anon, authenticated;

-- surveys -------------------------------------------------------------------

DROP POLICY IF EXISTS "surveys_insert_instructors" ON public.surveys;
DROP POLICY IF EXISTS "Survey managers can create surveys" ON public.surveys;

CREATE POLICY "Survey managers can create surveys"
ON public.surveys
FOR INSERT TO authenticated
WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('manage_surveys')));

DROP POLICY IF EXISTS "surveys_update_instructors" ON public.surveys;
DROP POLICY IF EXISTS "Survey managers can update surveys" ON public.surveys;

CREATE POLICY "Survey managers can update surveys"
ON public.surveys
FOR UPDATE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_surveys')))
WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('manage_surveys')));

-- survey_assignments --------------------------------------------------------

DROP POLICY IF EXISTS "survey_assignments_insert_instructors" ON public.survey_assignments;
DROP POLICY IF EXISTS "Survey managers can create assignments" ON public.survey_assignments;

CREATE POLICY "Survey managers can create assignments"
ON public.survey_assignments
FOR INSERT TO authenticated
WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('manage_surveys')));

DROP POLICY IF EXISTS "survey_assignments_update_instructors" ON public.survey_assignments;
DROP POLICY IF EXISTS "Survey managers can update assignments" ON public.survey_assignments;

CREATE POLICY "Survey managers can update assignments"
ON public.survey_assignments
FOR UPDATE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_surveys')))
WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('manage_surveys')));

DROP POLICY IF EXISTS "survey_assignments_delete_instructors" ON public.survey_assignments;
DROP POLICY IF EXISTS "Survey managers can delete assignments" ON public.survey_assignments;

CREATE POLICY "Survey managers can delete assignments"
ON public.survey_assignments
FOR DELETE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_surveys')));

-- survey_templates ----------------------------------------------------------

DROP POLICY IF EXISTS "survey_templates_insert" ON public.survey_templates;
DROP POLICY IF EXISTS "Survey managers can create templates" ON public.survey_templates;

CREATE POLICY "Survey managers can create templates"
ON public.survey_templates
FOR INSERT TO authenticated
WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('manage_surveys')));

DROP POLICY IF EXISTS "survey_templates_update" ON public.survey_templates;
DROP POLICY IF EXISTS "Survey managers can update templates" ON public.survey_templates;

CREATE POLICY "Survey managers can update templates"
ON public.survey_templates
FOR UPDATE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_surveys')))
WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('manage_surveys')));

-- survey_series: action policies only; SELECT stays on survey_series_select_graders

DROP POLICY IF EXISTS "survey_series_manage_instructors" ON public.survey_series;
DROP POLICY IF EXISTS "Survey managers can create series" ON public.survey_series;
DROP POLICY IF EXISTS "Survey managers can update series" ON public.survey_series;
DROP POLICY IF EXISTS "Survey managers can delete series" ON public.survey_series;

CREATE POLICY "Survey managers can create series"
ON public.survey_series
FOR INSERT TO authenticated
WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('manage_surveys')));

CREATE POLICY "Survey managers can update series"
ON public.survey_series
FOR UPDATE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_surveys')))
WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('manage_surveys')));

CREATE POLICY "Survey managers can delete series"
ON public.survey_series
FOR DELETE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_surveys')));

-- create_survey_assignments: same signature / attributes / grants as lock_down migration

CREATE OR REPLACE FUNCTION public.create_survey_assignments(p_survey_id uuid, p_profile_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_class_id BIGINT;
BEGIN
  SELECT class_id INTO v_class_id
  FROM public.surveys
  WHERE id = p_survey_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Survey not found';
  END IF;

  IF v_class_id NOT IN (SELECT public.user_class_ids_with_capability('manage_surveys')) THEN
    RAISE EXCEPTION 'Permission denied: manage_surveys required';
  END IF;

  DELETE FROM survey_assignments WHERE survey_id = p_survey_id;

  INSERT INTO survey_assignments (survey_id, profile_id, class_id)
  SELECT p_survey_id, unnest(p_profile_ids), v_class_id
  ON CONFLICT (survey_id, profile_id) DO NOTHING;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_survey_assignments(p_survey_id uuid, p_profile_ids uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_survey_assignments(p_survey_id uuid, p_profile_ids uuid[]) TO authenticated, service_role;

-- soft_delete_survey: same signature / attributes / grants as lock_down migration

CREATE OR REPLACE FUNCTION public.soft_delete_survey(p_survey_id uuid, p_survey_logical_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_class_id BIGINT;
BEGIN
  SET LOCAL search_path = pg_catalog, public;

  SELECT class_id
  INTO v_class_id
  FROM public.surveys
  WHERE id = p_survey_id
    AND survey_id = p_survey_logical_id
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Survey not found';
  END IF;

  IF v_class_id NOT IN (SELECT public.user_class_ids_with_capability('manage_surveys')) THEN
    RAISE EXCEPTION 'Permission denied: manage_surveys required';
  END IF;

  UPDATE public.survey_responses
  SET deleted_at = NOW()
  WHERE survey_id IN (
    SELECT id FROM public.surveys WHERE survey_id = p_survey_logical_id AND class_id = v_class_id
  )
    AND deleted_at IS NULL;

  UPDATE public.surveys
  SET deleted_at = NOW()
  WHERE survey_id = p_survey_logical_id
    AND class_id = v_class_id
    AND deleted_at IS NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.soft_delete_survey(p_survey_id uuid, p_survey_logical_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.soft_delete_survey(p_survey_id uuid, p_survey_logical_id uuid) TO authenticated, service_role;

-- reorder_surveys_in_series: same signature / attributes / grants

CREATE OR REPLACE FUNCTION public.reorder_surveys_in_series(
  p_series_id uuid,
  p_ordinal_updates jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_class_id bigint;
  v_updated_count integer;
  v_series_survey_count integer;
  v_payload_count integer;
  v_ordinal_min integer;
  v_ordinal_max integer;
  v_ordinal_distinct_count integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT class_id INTO v_class_id
  FROM public.survey_series
  WHERE id = p_series_id;

  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'Survey series not found';
  END IF;

  IF v_class_id NOT IN (SELECT public.user_class_ids_with_capability('manage_surveys')) THEN
    RAISE EXCEPTION 'Permission denied: manage_surveys required';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT (elem->>'id')::uuid AS id
      FROM jsonb_array_elements(p_ordinal_updates) AS elem
    ) t
    GROUP BY id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate survey IDs in ordinal updates';
  END IF;

  SELECT COUNT(*)::integer INTO v_series_survey_count
  FROM public.surveys
  WHERE series_id = p_series_id AND deleted_at IS NULL;

  v_payload_count := COALESCE(jsonb_array_length(p_ordinal_updates), 0);

  IF v_series_survey_count != v_payload_count THEN
    RAISE EXCEPTION 'Payload count (%) does not match series survey count (%)', v_payload_count, v_series_survey_count;
  END IF;

  IF v_payload_count > 0 THEN
    SELECT
      MIN((elem->>'series_ordinal')::integer),
      MAX((elem->>'series_ordinal')::integer),
      COUNT(DISTINCT (elem->>'series_ordinal')::integer)
    INTO v_ordinal_min, v_ordinal_max, v_ordinal_distinct_count
    FROM jsonb_array_elements(p_ordinal_updates) AS elem;

    IF v_ordinal_min IS NULL OR v_ordinal_max IS NULL OR
       v_ordinal_min != 1 OR v_ordinal_max != v_payload_count OR
       v_ordinal_distinct_count != v_payload_count THEN
      RAISE EXCEPTION 'Ordinals must form a strict permutation 1..% with no gaps or duplicates', v_payload_count;
    END IF;
  END IF;

  WITH updates AS (
    SELECT
      (elem->>'id')::uuid AS id,
      (elem->>'series_ordinal')::integer AS series_ordinal
    FROM jsonb_array_elements(p_ordinal_updates) AS elem
  )
  UPDATE public.surveys s
  SET series_ordinal = u.series_ordinal
  FROM updates u
  WHERE s.id = u.id
    AND s.series_id = p_series_id
    AND s.deleted_at IS NULL;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count != jsonb_array_length(p_ordinal_updates) THEN
    RAISE EXCEPTION 'Partial update: expected % rows updated, got %', jsonb_array_length(p_ordinal_updates), v_updated_count;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.reorder_surveys_in_series(uuid, jsonb) IS
'Atomically update series_ordinal for multiple surveys in a series. p_ordinal_updates
must be a JSON array of {id: uuid, series_ordinal: integer}. All surveys must belong
to p_series_id. Requires manage_surveys for the series class.';

GRANT EXECUTE ON FUNCTION public.reorder_surveys_in_series(uuid, jsonb) TO authenticated;

-- live_polls ----------------------------------------------------------------

DROP POLICY IF EXISTS "live_polls_all_staff_insert" ON public.live_polls;
DROP POLICY IF EXISTS "Poll runners can create polls" ON public.live_polls;

CREATE POLICY "Poll runners can create polls"
ON public.live_polls
FOR INSERT TO authenticated
WITH CHECK (
  class_id IN (SELECT public.user_class_ids_with_capability('run_polls'))
  AND authorizeforprofile(created_by)
);

DROP POLICY IF EXISTS "live_polls_all_staff_update" ON public.live_polls;
DROP POLICY IF EXISTS "Poll runners can update polls" ON public.live_polls;

CREATE POLICY "Poll runners can update polls"
ON public.live_polls
FOR UPDATE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('run_polls')))
WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('run_polls')));

DROP POLICY IF EXISTS "live_polls_all_staff_delete" ON public.live_polls;
DROP POLICY IF EXISTS "Poll runners can delete polls" ON public.live_polls;

CREATE POLICY "Poll runners can delete polls"
ON public.live_polls
FOR DELETE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('run_polls')));

-- live_poll_responses: split staff ALL into view SELECT + run_polls writes

DROP POLICY IF EXISTS "live_polls_responses_all_staff" ON public.live_poll_responses;
DROP POLICY IF EXISTS "live_poll_responses_select_staff" ON public.live_poll_responses;
DROP POLICY IF EXISTS "Poll runners can insert responses" ON public.live_poll_responses;
DROP POLICY IF EXISTS "Poll runners can update responses" ON public.live_poll_responses;
DROP POLICY IF EXISTS "Poll runners can delete responses" ON public.live_poll_responses;

CREATE POLICY "live_poll_responses_select_staff"
ON public.live_poll_responses
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.live_polls lp
    WHERE lp.id = live_poll_responses.live_poll_id
      AND authorizeforclassgrader(lp.class_id)
  )
);

CREATE POLICY "Poll runners can insert responses"
ON public.live_poll_responses
FOR INSERT TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.live_polls lp
    WHERE lp.id = live_poll_responses.live_poll_id
      AND lp.class_id IN (SELECT public.user_class_ids_with_capability('run_polls'))
  )
);

CREATE POLICY "Poll runners can update responses"
ON public.live_poll_responses
FOR UPDATE TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.live_polls lp
    WHERE lp.id = live_poll_responses.live_poll_id
      AND lp.class_id IN (SELECT public.user_class_ids_with_capability('run_polls'))
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.live_polls lp
    WHERE lp.id = live_poll_responses.live_poll_id
      AND lp.class_id IN (SELECT public.user_class_ids_with_capability('run_polls'))
  )
);

CREATE POLICY "Poll runners can delete responses"
ON public.live_poll_responses
FOR DELETE TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.live_polls lp
    WHERE lp.id = live_poll_responses.live_poll_id
      AND lp.class_id IN (SELECT public.user_class_ids_with_capability('run_polls'))
  )
);
