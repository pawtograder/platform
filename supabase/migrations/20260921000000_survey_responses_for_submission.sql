-- Survey responses for a submission: one row per (linked survey x roster member).
--
-- Powers the survey tab on the submission view:
--   * graders/instructors see every member of the submitting group (or the solo submitter)
--   * students see only their own response
--
-- The roster is derived entirely from p_submission_id. The caller cannot name a
-- profile, so it cannot widen the result set by asking for someone else's row.
--
-- Roster members who have not started the survey still come back (LEFT JOIN, with
-- deleted_at in the JOIN condition rather than the WHERE), with is_submitted = false
-- and a null response -- that is the "who hasn't filled this out yet" signal.

CREATE OR REPLACE FUNCTION public.get_survey_responses_for_submission(
  p_submission_id bigint
)
RETURNS TABLE(
  survey_id uuid,
  survey_title text,
  survey_json jsonb,
  survey_status survey_status,
  due_date timestamptz,
  available_at timestamptz,
  profile_id uuid,
  profile_name text,
  is_submitter boolean,
  is_submitted boolean,
  submitted_at timestamptz,
  updated_at timestamptz,
  response jsonb
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH sub AS (
    SELECT
      sub_row.assignment_id,
      sub_row.class_id,
      sub_row.profile_id,
      sub_row.assignment_group_id
    FROM submissions sub_row
    WHERE sub_row.id = p_submission_id
  ),
  roster AS (
    -- Group submission: every member of the submitting group.
    SELECT agm.profile_id
    FROM sub
    JOIN assignment_groups_members agm
      ON agm.assignment_group_id = sub.assignment_group_id
    WHERE sub.assignment_group_id IS NOT NULL
    UNION
    -- Solo submission: just the submitter.
    SELECT sub.profile_id
    FROM sub
    WHERE sub.assignment_group_id IS NULL
      AND sub.profile_id IS NOT NULL
  )
  SELECT
    sv.id AS survey_id,
    sv.title AS survey_title,
    sv.json AS survey_json,
    sv.status AS survey_status,
    sv.due_date,
    sv.available_at,
    r.profile_id,
    p.name AS profile_name,
    (r.profile_id IS NOT DISTINCT FROM sub.profile_id) AS is_submitter,
    COALESCE(sr.is_submitted, false) AS is_submitted,
    sr.submitted_at,
    sr.updated_at,
    sr.response
  FROM sub
  CROSS JOIN roster r
  JOIN surveys sv
    ON sv.assignment_id = sub.assignment_id
   -- Redundant with the composite FK (assignment_id, class_id) on surveys, but keeps
   -- the class of the returned surveys pinned to the class we authorize against.
   AND sv.class_id = sub.class_id
   AND sv.deleted_at IS NULL
   AND sv.status IN ('published', 'closed')
  JOIN profiles p ON p.id = r.profile_id
  -- deleted_at belongs here, NOT in the WHERE: in the WHERE it would turn this
  -- LEFT JOIN back into an inner join and drop non-respondents.
  LEFT JOIN survey_responses sr
    ON sr.survey_id = sv.id
   AND sr.profile_id = r.profile_id
   AND sr.deleted_at IS NULL
  -- Same authorization idiom as get_survey_status_for_assignment: a caller who is
  -- neither staff in the class nor the owner of the profile gets zero rows, not an error.
  WHERE authorizeforclass(sub.class_id)
    AND (authorizeforprofile(r.profile_id) OR authorizeforclassgrader(sub.class_id))
  -- available_at is deliberately NOT filtered on -- it is returned so the UI can badge
  -- a survey that is not open yet.
  ORDER BY
    sv.title,
    (r.profile_id IS NOT DISTINCT FROM sub.profile_id) DESC,
    p.name
$$;

COMMENT ON FUNCTION public.get_survey_responses_for_submission(bigint) IS
'Survey responses for the surveys linked to a submission''s assignment, one row per
(survey, roster member). The roster is derived from the submission: every member of the
submitting group, or the solo submitter. Roster members with no response are returned with
is_submitted = false and a null response. Graders and instructors see the whole roster;
a student sees only their own profile. available_at is returned but not filtered on.

is_submitter is true only where submissions.profile_id names an individual owner, which in
practice means a solo submission. A group submission carries a NULL profile_id -- the ingest
path in autograder-create-submission copies it from repositories.profile_id, and a group
repository has none -- so no roster row of a group submission is ever flagged. That is
accurate rather than broken: a group submission has no one submitter. Callers wanting "which
row belongs to the viewer" must compare profile_id against the viewer''s own private profile
instead; do not reach for is_submitter.';

REVOKE ALL ON FUNCTION public.get_survey_responses_for_submission(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_survey_responses_for_submission(bigint) TO authenticated;
