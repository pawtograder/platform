-- A submitted survey response may not be returned to draft.
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
