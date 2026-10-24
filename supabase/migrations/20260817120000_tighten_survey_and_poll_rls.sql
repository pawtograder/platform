-- Survey and poll RLS: scope response writes to the survey, assignment reads to the assignee,
-- and unauthenticated poll reads to polls that are actually live.
--
-- 20251213200333_surveys_polls.sql shipped three policies that authorize less than their names
-- suggest. All three are read/write boundaries reachable directly through PostgREST, so the
-- client-side guards that currently stand in for them are not a control.
--
-- 1. `survey_responses_insert_owner` / `_update_owner` test only that `profile_id` is one of the
--    caller's own profiles. Nothing joins `surveys`, so the row being written is never checked
--    against the survey it belongs to: a student could write a response to a `draft` survey, a
--    `closed` survey, a soft-deleted survey, a survey they were never assigned, or a survey in a
--    class they are not enrolled in — and could edit a response they had already submitted to a
--    survey with `allow_response_editing = false`. Only the last of those is guarded in the client
--    (`app/course/[course_id]/surveys/[survey_id]/page.tsx` derives `isReadOnly` from
--    `allow_response_editing`), and the guard lives entirely in the browser.
--
--    `can_respond_to_survey` now carries the whole check, mirroring the predicates that
--    `surveys_select_students` applies on the read side as of
--    20260222000000_survey_assignment_grading.sql (class membership, `deleted_at IS NULL`,
--    `available_at`, assignment) and tightening `status` from "published or closed" to "published"
--    — a closed survey is readable but must not accept new writes. Without the `available_at` leg
--    an assigned student could read their own `survey_assignments` row for the id and respond
--    before the survey was ever visible to them. `SECURITY DEFINER` so the decision
--    is made against the real `surveys` row rather than whatever `surveys` RLS happens to expose to
--    the caller.
--
--    `due_date` is deliberately NOT enforced here. It has never been enforced anywhere — not in
--    RLS, not in the client, which only renders it (`app/course/[course_id]/surveys/page.tsx`) —
--    so surveys have always accepted late responses and instructors have `submitted_at` to judge
--    them by. Enforcing it in this migration would silently start rejecting late submissions,
--    which is a course-policy decision, not a security fix. To adopt it later, add
--    `AND (s.due_date IS NULL OR s.due_date > now())` to `can_respond_to_survey`.
--
--    The student write path is an upsert (`onConflict: survey_id,profile_id`), which needs both the
--    INSERT and the UPDATE policy to pass: the draft autosave inserts, and submit updates the draft
--    row in place. Both legs are allowed below. Staff have no UPDATE policy on `survey_responses`
--    today and gain none here.
--
-- 2. `survey_assignments_select_class_member` grants SELECT on the whole table to any member of the
--    class. Responses are protected; the roster of who was assigned what is not — including
--    `survey_id` values for `draft` surveys that `surveys_select_students` deliberately withholds,
--    which is how a student would learn the identifiers to aim (1) at. The policy is also pure
--    surplus: `survey_assignments_select_assignee` already covers a student reading their own
--    assignments, and `_select_graders` / `_select_instructors` cover staff. Dropping it changes
--    nothing a client can see today except other people's rows.
--
--    `surveys_select_students` subqueries `survey_assignments`, and RLS applies inside a policy
--    expression, but that subquery only ever matches the caller's own profiles — exactly the rows
--    `_select_assignee` still returns. Survey visibility is unaffected.
--
-- 3. `live_polls_select` is `TO anon, authenticated USING (true)`: every column of every poll in
--    every course, readable without authenticating. The anonymous `/poll/[course_id]` page is the
--    reason the `anon` grant exists, but that page asks for exactly one thing —
--    `class_id = ? AND is_live = true` (`app/poll/[course_id]/page.tsx`) — so `USING (true)` also
--    hands out the question JSON of drafts and closed polls, i.e. the questions for a poll that has
--    not been run yet. `USING (true)` was additionally serving every authenticated read, since the
--    other `live_polls` policies are INSERT/UPDATE/DELETE only and there is no staff SELECT policy;
--    the manage-side readers are restored by the staff policy below. That policy is scoped to
--    graders rather than to class members on purpose: permissive policies are ORed, so a
--    class-member predicate would hand every enrolled student the draft and closed rows this
--    change exists to withhold. Students need nothing more than the live policy — `useLivePolls`
--    and `useLivePoll` are both manage-only, and the one student-facing hook
--    (`useActiveLivePolls`) already filters to `is_live === true`.
--
--    The SELECT policy is only half of it; see (4) below for the realtime broadcast that was
--    handing students the same rows regardless of what the policy said.
--
--    A live poll's question stays readable by an unauthenticated visitor who knows the course id.
--    That is inherent to joining a poll by QR code with no token in the URL, and narrowing it
--    further is a product change rather than a policy fix.

-- 1. survey_responses: writes must be legal for the survey, not just owned by the caller.

CREATE OR REPLACE FUNCTION public.can_respond_to_survey(p_survey_id uuid, p_profile_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.surveys s
    JOIN public.user_privileges up
      ON up.class_id = s.class_id
     AND up.user_id = auth.uid()
     AND (up.private_profile_id = p_profile_id OR up.public_profile_id = p_profile_id)
    WHERE s.id = p_survey_id
      AND s.deleted_at IS NULL
      AND s.status = 'published'::survey_status
      AND (s.available_at IS NULL OR s.available_at <= now())
      AND (
        s.assigned_to_all
        OR EXISTS (
          SELECT 1
          FROM public.survey_assignments sa
          WHERE sa.survey_id = s.id
            AND (sa.profile_id = up.private_profile_id OR sa.profile_id = up.public_profile_id)
        )
      )
  );
$$;

COMMENT ON FUNCTION public.can_respond_to_survey(uuid, uuid) IS
  'True when auth.uid() owns p_profile_id and the survey is one that profile may still write a response to: same class, not soft-deleted, published, past its available_at, and assigned. Used by the survey_responses write policies.';

CREATE OR REPLACE FUNCTION public.survey_allows_response_editing(p_survey_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.surveys s
    WHERE s.id = p_survey_id AND s.allow_response_editing
  );
$$;

COMMENT ON FUNCTION public.survey_allows_response_editing(uuid) IS
  'True when the survey permits a student to edit a response they have already submitted. Server-side counterpart to the isReadOnly guard in the student survey page.';

DROP POLICY IF EXISTS "survey_responses_insert_owner" ON public.survey_responses;

CREATE POLICY "survey_responses_insert_owner"
ON public.survey_responses
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK (public.can_respond_to_survey(survey_id, profile_id));

DROP POLICY IF EXISTS "survey_responses_update_owner" ON public.survey_responses;

CREATE POLICY "survey_responses_update_owner"
ON public.survey_responses
AS PERMISSIVE
FOR UPDATE
TO public
USING (
  public.can_respond_to_survey(survey_id, profile_id)
  -- A submitted response is final unless the survey opted into re-editing. The draft leg of the
  -- upsert (is_submitted still false) is what lets submit itself through.
  AND (NOT is_submitted OR public.survey_allows_response_editing(survey_id))
)
WITH CHECK (public.can_respond_to_survey(survey_id, profile_id));

-- 2. survey_assignments: drop the class-wide roster read. Assignees and staff keep theirs.

DROP POLICY IF EXISTS "survey_assignments_select_class_member" ON public.survey_assignments;

-- 3. live_polls: separate the anonymous reader from the enrolled one.

DROP POLICY IF EXISTS "live_polls_select" ON public.live_polls;

CREATE POLICY "live_polls_select_live"
ON public.live_polls
AS PERMISSIVE
FOR SELECT
TO anon, authenticated
USING (is_live = true);

CREATE POLICY "live_polls_select_staff"
ON public.live_polls
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (authorizeforclassgrader(class_id));

-- 4. live_polls broadcasts: the students' channel must not carry what RLS withholds.
--
-- Narrowing the SELECT policy above is not sufficient on its own. Every write to live_polls also
-- fires broadcast_live_poll_change(), which is SECURITY DEFINER and sends the same payload to
-- `class:<id>:staff` and `class:<id>:students`, with `data` set to to_jsonb(NEW) — the whole row,
-- question JSON included — regardless of is_live. Channel membership is the only authorization on
-- that path; row policies are never consulted. On the client, TableController takes a payload that
-- carries `data` straight into its cache (see _handleInsertBatch / _handleUpdate) and only refetches
-- through RLS when `data` is absent. So any student holding an open session while staff drafted or
-- edited a poll received the question anyway, and the policy change would have looked effective
-- while changing nothing for exactly the students most likely to be connected: the ones in class.
--
-- Students now get the full row only while the poll is live. Every other transition — a draft being
-- written, a poll closing, a row being deleted — is announced to them as a bare DELETE carrying
-- row_id and no data, which _handleDelete applies by dropping the row. A client that already had
-- the poll loses it the moment it stops being live; a client that never had it learns nothing but
-- an id it cannot resolve, since the SELECT policy will not return the row on refetch either.
--
-- The staff channel is unchanged: authorizeforclassgrader already governs who joins it, and the
-- manage views need the full row.
--
-- The live transition still works in both directions. A poll going live sends a full-data UPDATE,
-- and _handleUpdate adds the row when it is not already cached, so the student's list picks it up.

CREATE OR REPLACE FUNCTION public.broadcast_live_poll_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    target_class_id bigint;
    staff_payload jsonb;
    student_payload jsonb;
    changed_row_id uuid;
    row_is_live boolean;
BEGIN
    IF TG_OP = 'INSERT' THEN
        target_class_id := NEW.class_id;
    ELSIF TG_OP = 'UPDATE' THEN
        target_class_id := COALESCE(NEW.class_id, OLD.class_id);
    ELSIF TG_OP = 'DELETE' THEN
        target_class_id := OLD.class_id;
    END IF;

    IF target_class_id IS NOT NULL THEN
        changed_row_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
        row_is_live := (TG_OP <> 'DELETE' AND NEW.is_live);

        staff_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', changed_row_id,
            'data', CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,
            'class_id', target_class_id,
            'timestamp', NOW()
        );

        PERFORM realtime.send(
            staff_payload,
            'broadcast',
            'class:' || target_class_id || ':staff',
            true
        );

        IF row_is_live THEN
            student_payload := staff_payload;
        ELSE
            -- No `data` key: the client drops the row by id and cannot learn its contents.
            student_payload := jsonb_build_object(
                'type', 'table_change',
                'operation', 'DELETE',
                'table', TG_TABLE_NAME,
                'row_id', changed_row_id,
                'class_id', target_class_id,
                'timestamp', NOW()
            );
        END IF;

        PERFORM realtime.send(
            student_payload,
            'broadcast',
            'class:' || target_class_id || ':students',
            true
        );
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$function$;
