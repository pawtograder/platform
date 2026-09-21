-- Survey responses on a submission.
--
-- Two parts:
--   1. get_survey_responses_for_submission(bigint) -- the RPC behind the survey tab on the
--      submission view.
--   2. A trigger forbidding a submitted survey response from being returned to draft.
--
-- They ship together because the second is what makes the first worth reading: the panel
-- reports which roster members have completed a linked survey, and that report is only as
-- good as the is_submitted column it reads.


-- =============================================================================
-- 1. get_survey_responses_for_submission
-- =============================================================================
--
-- One row per (linked survey x roster member).
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
--
-- This function is SECURITY DEFINER, so it does not get the surveys RLS policies for
-- free: which surveys a non-staff caller may see has to be restated here. It mirrors
-- surveys_select_students (as amended in 20260222000000_survey_assignment_grading.sql):
-- not-yet-open surveys, and surveys assigned to someone else, are withheld from students.
-- Staff keep unrestricted visibility -- a grader has to be able to see a survey that is
-- scheduled ahead, and one that was assigned to only part of the group.

-- A no-op on a database that has never had this function. It is here for the ones that ran
-- an earlier build of this same (unmerged) migration: is_assigned is a new OUT column, which
-- is a change to the composite return type, and CREATE OR REPLACE refuses that outright.
DROP FUNCTION IF EXISTS public.get_survey_responses_for_submission(bigint);

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
  is_assigned boolean,
  is_submitted boolean,
  submitted_at timestamptz,
  updated_at timestamptz,
  response jsonb
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  -- MATERIALIZED, deliberately. The two class-level authorization checks below do not vary
  -- by roster row, but authorizeforclass and authorizeforclassgrader are SECURITY DEFINER
  -- with a SET search_path, so PostgreSQL will not inline them: left in the row predicate
  -- they are a real function call, and another user_roles lookup, for every row returned.
  -- Evaluating them once here cut a 12-row call (4 group members x 3 linked surveys) from
  -- ~2.0ms to ~1.2ms. Without MATERIALIZED a single-reference CTE is folded back into the
  -- outer query and the calls go per-row again.
  WITH sub AS MATERIALIZED (
    SELECT
      sub_row.assignment_id,
      sub_row.class_id,
      sub_row.profile_id,
      sub_row.assignment_group_id,
      authorizeforclass(sub_row.class_id) AS in_class,
      authorizeforclassgrader(sub_row.class_id) AS is_staff
    FROM submissions sub_row
    WHERE sub_row.id = p_submission_id
  ),
  roster_members AS (
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
  ),
  roster AS (
    -- Resolve each roster member's OTHER profile identity once, here, rather than per
    -- (survey x member) below. survey_assignments.profile_id is not reliably a private
    -- profile id: create_survey_assignments inserts unnest(p_profile_ids) verbatim, so
    -- whichever identity the caller happened to pass is what landed in the row.
    -- surveys_select_students copes by matching either side
    -- (up.private_profile_id = sa.profile_id OR up.public_profile_id = sa.profile_id);
    -- the roster ids here are private profile ids, so matching only those would
    -- under-report assignment and -- now that assignment gates student visibility --
    -- would hide a survey from a student who was genuinely assigned it.
    --
    -- user_roles rather than user_privileges: user_roles.private_profile_id carries a
    -- UNIQUE constraint (user_roles_private_profile_id_key), so this is a single-row
    -- lookup on a unique index and the class is implied by the id. user_privileges has
    -- only a non-unique index there; the policy reaches for it because it keys off
    -- auth.uid(), which this function -- which has to answer for OTHER people's roster
    -- rows, not just the caller's -- cannot do. LEFT JOIN so a roster member with no
    -- role row still gets their row, matched on the private id alone.
    SELECT
      rm.profile_id,
      ur.public_profile_id
    FROM roster_members rm
    LEFT JOIN user_roles ur ON ur.private_profile_id = rm.profile_id
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
    vis.is_assigned,
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
  -- LATERAL, so "is this roster member assigned this survey?" is written exactly once and
  -- serves both the returned column and the student visibility filter below. Repeating the
  -- EXISTS in the WHERE and in the select list would let the two drift, and a drift here is
  -- a disclosure bug: the row would be filtered by one rule and labelled by another. A
  -- LATERAL rather than a wrapping subselect keeps the rest of the query -- the join order,
  -- the short-circuited WHERE, the ORDER BY -- untouched, and unlike an output alias a
  -- LATERAL column CAN be referenced from the WHERE of this same query level.
  -- assigned_to_all is NOT NULL and EXISTS never yields NULL, so is_assigned is non-null.
  CROSS JOIN LATERAL (
    SELECT (
      sv.assigned_to_all
      OR EXISTS (
        SELECT 1
        FROM survey_assignments sa
        WHERE sa.survey_id = sv.id
          AND (sa.profile_id = r.profile_id OR sa.profile_id = r.public_profile_id)
      )
    ) AS is_assigned
  ) vis
  -- Same authorization rule as get_survey_status_for_assignment: a caller who is neither
  -- staff in the class nor the owner of the profile gets zero rows, not an error. The two
  -- class-level checks come from the CTE above so they are evaluated once rather than once
  -- per row; only authorizeforprofile is genuinely row-dependent and has to stay here.
  -- is_staff is tested first on purpose: OR short-circuits, so staff -- the common caller
  -- for this panel -- skip the per-row profile check entirely.
  WHERE sub.in_class
    AND (sub.is_staff OR authorizeforprofile(r.profile_id))
    -- Which surveys, as opposed to which roster rows. Staff see every linked survey,
    -- including one scheduled ahead (the UI badges it as not yet open) and one assigned to
    -- only part of the group. A non-staff caller -- who by the predicate above is looking
    -- only at their own row -- gets the surveys_select_students predicates restated, since
    -- SECURITY DEFINER skipped that policy: not open yet, or assigned to someone else, means
    -- the row is withheld entirely, survey_json -- the question text -- with it. is_staff
    -- comes first here too, so staff never pay for the assignment lookup.
    AND (
      sub.is_staff
      OR (
        (sv.available_at IS NULL OR sv.available_at <= now())
        AND vis.is_assigned
      )
    )
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
a student sees only their own profile.

Which surveys are visible depends on the caller, because SECURITY DEFINER bypasses the
surveys RLS policies. Staff see every published or closed survey linked to the assignment,
including one whose available_at is in the future (returned unfiltered so the UI can badge
it as not yet open) and one assigned to only part of the group. A non-staff caller gets the
same predicates surveys_select_students applies: available_at IS NULL OR available_at <=
now(), and the survey is assigned to them (assigned_to_all, or a survey_assignments row).
A survey failing either is withheld whole, survey_json -- the question text -- included.

is_assigned reports whether that roster member was asked to fill the survey out:
assigned_to_all, or a survey_assignments row naming either of their profile identities.
It is never null. A false here is why a blank row exists, and is the difference between
"has not started" and "was never asked" -- the UI must not let a grader mark someone down
for a survey nobody asked them to fill in. Matching both identities is required, not
defensive: create_survey_assignments stores whatever profile ids the caller passed, so an
assignment row may hold a public profile id while the roster is private ones, and the RLS
policy matches either side for the same reason.

is_submitter is true only where submissions.profile_id names an individual owner, which in
practice means a solo submission. A group submission carries a NULL profile_id -- the ingest
path in autograder-create-submission copies it from repositories.profile_id, and a group
repository has none -- so no roster row of a group submission is ever flagged. That is
accurate rather than broken: a group submission has no one submitter. Callers wanting "which
row belongs to the viewer" must compare profile_id against the viewer''s own private profile
instead; do not reach for is_submitter.

Cost scales with (roster members x linked surveys), which a group submission bounds to a
handful of rows. authorizeforprofile cannot be inlined by the planner, so it is a real
user_roles lookup per row: that is affordable here and would not be if this were ever reused
over a whole class rather than one submission''s roster.';

REVOKE ALL ON FUNCTION public.get_survey_responses_for_submission(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_survey_responses_for_submission(bigint) TO authenticated;


-- =============================================================================
-- 2. A submitted survey response may not be returned to draft
-- =============================================================================
--
-- The hole this closes is in `survey_responses_update_owner`
-- (20260817120000_tighten_survey_and_poll_rls.sql):
--
--   USING (can_respond_to_survey(...) AND (NOT is_submitted OR survey_allows_response_editing(survey_id)))
--
-- The second leg exists so that a student may keep editing a response on a survey with
-- `allow_response_editing`. It is evaluated against the OLD row and says nothing about what
-- the NEW row may contain, so for such a survey a student's own PATCH is free to set
-- `is_submitted = false` on a row that was submitted. Nothing else forbids the transition:
-- `set_survey_submitted_at` (20251213200333_surveys_polls.sql) stamps `submitted_at` only on
-- false -> true and never clears it, so the downgraded row keeps its submission timestamp and
-- ends up self-contradictory -- not submitted, yet submitted at a time. Instructor completion
-- tracking reads `is_submitted`, so the submission disappears silently.
--
-- The client-side guard in `app/course/[course_id]/surveys/[survey_id]/page.tsx` /
-- `lib/surveyResponseState.ts` stops the browser from doing this by accident (a debounced
-- autosave racing a reload of an already-submitted response). It is not a control: the
-- student's own token can PATCH the row directly through PostgREST. This trigger is the
-- server-side half.
--
-- Scope: UPDATE only. Inserting a draft is normal, and an INSERT cannot downgrade anything.
-- true -> true (re-submit, and the autosave that now rewrites an editable submitted response
-- while keeping it submitted) and false -> true (the ordinary submit) are both untouched.
-- Updates that leave `is_submitted` alone -- `soft_delete_survey` setting `deleted_at`, a
-- correction to `submitted_at` -- never reach the function body.

CREATE OR REPLACE FUNCTION public.survey_response_no_unsubmit()
RETURNS trigger
-- Deliberately SECURITY INVOKER (the default): the exemption below reads `current_user`, and
-- under SECURITY DEFINER that would always be the function owner, exempting every caller.
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- service_role and the database owner keep a remediation path: there is no staff UPDATE
  -- policy on survey_responses (only survey_responses_update_owner), so an instructor who
  -- needs a mistakenly submitted response reopened has no in-product route today and the fix
  -- has to be a script. A student cannot reach this branch: PostgREST runs their request as
  -- `authenticated`, which is not a member of service_role, and claiming `role: service_role`
  -- in a JWT requires the signing secret, i.e. the service key itself.
  --
  -- 'USAGE' rather than 'MEMBER' on purpose. `authenticator` is granted service_role but is
  -- NOLOGIN-inheriting-nothing (rolinherit = false), so it holds the membership without the
  -- privileges; 'MEMBER' would exempt a query that somehow ran before PostgREST switched role.
  IF pg_has_role(current_user, 'service_role', 'USAGE') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'survey_responses_no_unsubmit: a submitted survey response cannot be returned to draft (survey_id=%, profile_id=%)',
    OLD.survey_id, OLD.profile_id
    USING
      ERRCODE = 'check_violation',
      HINT = 'Editing an already-submitted response must keep is_submitted = true; a draft autosave must not be written over a submitted row.';
END;
$$;

COMMENT ON FUNCTION public.survey_response_no_unsubmit() IS
'Rejects an UPDATE that takes survey_responses.is_submitted from true to false. Enforces the
invariant that survey_responses_update_owner does not: a response on a survey with
allow_response_editing stays editable, but stays submitted. service_role and the database
owner are exempt so that an out-of-band correction remains possible; a test that means to
observe the rejection must therefore act as the student, not as the service key.';

-- No `UPDATE OF is_submitted` column list: that fires on the statement's SET list, and would
-- miss another BEFORE trigger assigning NEW.is_submitted on an update that did not name the
-- column. The WHEN clause is evaluated against NEW as earlier BEFORE triggers left it, which
-- is the state that will actually be stored.
DROP TRIGGER IF EXISTS survey_response_no_unsubmit_trigger ON public.survey_responses;

CREATE TRIGGER survey_response_no_unsubmit_trigger
BEFORE UPDATE ON public.survey_responses
FOR EACH ROW
WHEN (OLD.is_submitted AND NOT NEW.is_submitted)
EXECUTE FUNCTION public.survey_response_no_unsubmit();
