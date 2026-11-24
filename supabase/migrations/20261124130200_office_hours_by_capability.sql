-- #1010, area 10: staff help-request actions follow help_students; instructor-only
-- office-hours configuration follows manage_office_hours.
--
-- Why: graders already take requests, chat as staff, moderate, join queues, and write
-- karma notes; instructors alone manage templates and a few admin-only rows. This moves
-- those writes onto the capability tables so an instructor can turn each action on or
-- off for a role, while day-one access stays the same.
--
-- What:
--   * Inserts help_students (instructor, default grader, and every existing custom role)
--     and manage_office_hours (instructor role only). Updates seed_default_class_roles()
--     so new classes put help_students on the default grader role too (and keep
--     manage_flashcards and run_polls there). Instructors still get every capability
--     via the CROSS JOIN.
--   * Escalate and finish use help_students or class admin, preserving the escalation guards.
--   * Queue health uses help_students. Class health thresholds need manage_office_hours.
--   * help_requests staff UPDATE / DELETE: role IN (instructor, grader) -> help_students.
--     The student half of "Students can update their own help requests" stays.
--   * help_request_students staff UPDATE: authorizeforhelprequeststaff -> help_students.
--   * help_request_moderation grader INSERT -> help_students; instructor FOR ALL and
--     DELETE -> manage_office_hours (split FOR ALL into INSERT / UPDATE / DELETE).
--   * student_karma_notes: split FOR ALL so SELECT stays a grader view and writes follow
--     help_students.
--   * help_request_work_sessions: staff INSERT -> help_students; instructor DELETE ->
--     manage_office_hours; UPDATE keeps the own-record path and swaps the instructor
--     half for manage_office_hours, and its WITH CHECK now also requires the parent
--     request to be in the session's class (as INSERT does).
--   * help_queues and help_queue_assignments: graders can CRUD these today, so action
--     policies follow help_students (SELECT policies unchanged). A separate UPDATE policy
--     lets a TA end their own open shift without help_students, so revoking it can't leave
--     a shift they can't stop.
--   * help_request_templates and student_help_activity instructor FOR ALL -> split into
--     INSERT / UPDATE / DELETE under manage_office_hours (SELECT / system INSERT stay).
--   * SECURITY DEFINER helpers that gate a staff write (can_add_profile_to_help_request,
--     check_can_remove_from_help_request, can_follow_up_help_request,
--     authorizeforhelprequestparticipant, enforce_help_request_update_columns,
--     forbid_help_request_privacy_downgrade) swap the staff role check for
--     help_students OR the admin branch of authorizeforhelprequeststaff (class admin via
--     user_privileges.role = 'admin' in that class). The admin role holds no capabilities
--     by design, so this is the one place a role test is OR'd with a capability test.
--     Signatures, attributes and grants stay. authorizeforhelprequeststaff itself is
--     unchanged so private-request views keep working for any staff member.
--   * Child-row action policies that name a parent id require that parent to share
--     class_id on INSERT and UPDATE WITH CHECK (moderation, work sessions, queue
--     assignments, student_help_activity). UPDATE USING and DELETE USING check only the
--     capability in the row's class so a holder can repair or delete a legacy mismatch.
--
-- Not changed (views and student actions):
--   * help_requests / messages / students / file refs / watchers / receipts SELECT
--   * help_queues "Visible to everyone in class"
--   * help_queue_assignments SELECT
--   * help_request_templates / student_help_activity / work_sessions SELECT
--   * student create / update-own / feedback / watcher / receipt writes
--   * authorizeforhelprequeststaff and can_access_help_request (staff read of private
--     requests)
--   * video_meeting_sessions SELECT; session_users service-role writes
--   * create_help_request_with_participants (class membership, not staff-only)
--   * CLI help-requests close (still instructor-only; see open questions in the PR)

INSERT INTO public.capabilities (name, description) VALUES
  ('help_students', 'Take, assign, resolve and moderate help requests; chat as staff; join queues; record karma notes'),
  ('manage_office_hours', 'Create and edit help request templates and other instructor-only office hours settings')
ON CONFLICT DO NOTHING;

INSERT INTO public.role_capabilities (role_id, capability)
SELECT cr.id, 'help_students' FROM public.class_roles cr
WHERE cr.default_for IN ('instructor', 'grader') OR cr.default_for IS NULL
ON CONFLICT DO NOTHING;

INSERT INTO public.role_capabilities (role_id, capability)
SELECT cr.id, 'manage_office_hours' FROM public.class_roles cr
WHERE cr.default_for = 'instructor'
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

  -- What the default grader role can do today, for new classes (#1010). One list for every #1010
  -- migration that redefines this function, so whichever runs last keeps the others' grants. A
  -- name joins only once its capability exists, so the list can name capabilities other open PRs
  -- add (grade_submissions, handle_regrades and grant_extensions are #1408-#1410's).
  INSERT INTO public.role_capabilities (role_id, capability)
  SELECT cr.id, c.name
  FROM public.class_roles cr
  JOIN public.capabilities c ON c.name IN (
    'help_students', 'manage_flashcards', 'run_polls',
    'grade_submissions', 'handle_regrades', 'grant_extensions'
  )
  WHERE cr.class_id = p_class_id AND cr.default_for = 'grader'
  ON CONFLICT DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_default_class_roles(bigint) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers: swap the staff role check for help_students, keep class admins
-- ---------------------------------------------------------------------------
-- Admin holds no capabilities by design. authorizeforhelprequeststaff admitted
-- user_privileges.role = 'admin' in the request's class; OR that same test here
-- so class admins keep those staff writes without putting help_students on admin.

CREATE OR REPLACE FUNCTION public.authorizeforhelprequestparticipant(p_help_request_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT (hr.class_id IN (SELECT public.user_class_ids_with_capability('help_students'))
          OR EXISTS (
               SELECT 1 FROM public.user_privileges up
                WHERE up.user_id = auth.uid()
                  AND up.class_id = hr.class_id
                  AND up.role = 'admin')
          OR public.user_is_in_help_request(hr.id))
    FROM public.help_requests hr
   WHERE hr.id = p_help_request_id;
$$;

REVOKE ALL ON FUNCTION public.authorizeforhelprequestparticipant(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.authorizeforhelprequestparticipant(bigint) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.can_add_profile_to_help_request(p_help_request_id bigint, p_profile_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT EXISTS (
           SELECT 1 FROM public.user_roles ur
            WHERE ur.class_id = hr.class_id
              AND ur.disabled = false
              AND (ur.private_profile_id = p_profile_id OR ur.public_profile_id = p_profile_id))
     AND (hr.class_id IN (SELECT public.user_class_ids_with_capability('help_students'))
          OR EXISTS (
               SELECT 1 FROM public.user_privileges up
                WHERE up.user_id = auth.uid()
                  AND up.class_id = hr.class_id
                  AND up.role = 'admin')
          OR (public.authorizeforclass(hr.class_id)
              AND (hr.is_private = false OR public.user_is_in_help_request(hr.id))))
    FROM public.help_requests hr
   WHERE hr.id = p_help_request_id;
$$;

REVOKE ALL ON FUNCTION public.can_add_profile_to_help_request(bigint, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_add_profile_to_help_request(bigint, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.check_can_remove_from_help_request(
  p_help_request_id bigint, p_profile_id_to_remove uuid, p_user_id uuid, p_class_id bigint)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_class_id bigint;
  v_private_profile_id uuid;
  v_public_profile_id uuid;
BEGIN
  SELECT class_id INTO v_class_id FROM public.help_requests WHERE id = p_help_request_id;
  IF v_class_id IS NULL OR v_class_id IS DISTINCT FROM p_class_id THEN
    RETURN false;
  END IF;

  SELECT up.private_profile_id, up.public_profile_id
    INTO v_private_profile_id, v_public_profile_id
    FROM public.user_privileges up
   WHERE up.user_id = p_user_id AND up.class_id = v_class_id
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- help_students, or class admin (admin holds no capabilities by design; same
  -- admin branch as authorizeforhelprequeststaff, keyed on p_user_id).
  IF v_class_id IN (SELECT public.user_class_ids_with_capability('help_students'))
     OR EXISTS (
          SELECT 1 FROM public.user_privileges up
           WHERE up.user_id = p_user_id
             AND up.class_id = v_class_id
             AND up.role = 'admin') THEN
    RETURN true;
  END IF;

  IF p_profile_id_to_remove IN (v_private_profile_id, v_public_profile_id) THEN
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.help_request_students hrs
     WHERE hrs.help_request_id = p_help_request_id
       AND hrs.profile_id IN (v_private_profile_id, v_public_profile_id)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.check_can_remove_from_help_request(bigint, uuid, uuid, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_can_remove_from_help_request(bigint, uuid, uuid, bigint) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.can_follow_up_help_request(p_followup_to bigint, p_class_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.help_requests prev
     WHERE prev.id = p_followup_to
       AND prev.class_id = p_class_id
       AND (p_class_id IN (SELECT public.user_class_ids_with_capability('help_students'))
            OR EXISTS (
                 SELECT 1 FROM public.user_privileges up
                  WHERE up.user_id = auth.uid()
                    AND up.class_id = p_class_id
                    AND up.role = 'admin')
            OR public.user_is_in_help_request(prev.id))
  );
$$;

REVOKE ALL ON FUNCTION public.can_follow_up_help_request(bigint, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_follow_up_help_request(bigint, bigint) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.enforce_help_request_update_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF NEW.help_queue IS DISTINCT FROM OLD.help_queue
     AND NOT EXISTS (SELECT 1 FROM public.help_queues hq WHERE hq.id = NEW.help_queue AND hq.class_id = OLD.class_id) THEN
    RAISE EXCEPTION 'help request % cannot be moved to a queue in another class', OLD.id
      USING ERRCODE = '42501';
  END IF;

  -- Callers without a user JWT (service role, cron, admin edge functions) are trusted.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'closed' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'help request % was ended and cannot be reopened', OLD.id
      USING ERRCODE = '42501';
  END IF;

  -- The escalation RPCs validate the caller themselves and then update on their behalf.
  IF current_setting('pawtograder.help_request_escalation_rpc', true) = 'on' THEN
    RETURN NEW;
  END IF;

  -- Checked before the staff return: otherwise any instructor or grader could PATCH a ticket to
  -- the top of the queue, or open a check-in on a ticket nobody helped.
  IF NEW.escalation_count IS DISTINCT FROM OLD.escalation_count
     OR NEW.last_escalated_at IS DISTINCT FROM OLD.last_escalated_at
     OR NEW.check_in_expires_at IS DISTINCT FROM OLD.check_in_expires_at THEN
    RAISE EXCEPTION 'escalation fields of a help request change only through the escalation functions'
      USING ERRCODE = '42501';
  END IF;

  IF (OLD.class_id IN (SELECT public.user_class_ids_with_capability('help_students'))
     OR EXISTS (
          SELECT 1 FROM public.user_privileges up
           WHERE up.user_id = auth.uid()
             AND up.class_id = OLD.class_id
             AND up.role = 'admin')) THEN
    RETURN NEW;
  END IF;

  IF (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL)
     OR NEW.help_queue IS DISTINCT FROM OLD.help_queue
     OR NEW.assignee IS DISTINCT FROM OLD.assignee
     OR (NEW.followup_to IS DISTINCT FROM OLD.followup_to AND NEW.followup_to IS NOT NULL)
     OR (NEW.template_id IS DISTINCT FROM OLD.template_id AND NEW.template_id IS NOT NULL) THEN
    RAISE EXCEPTION 'only course staff may change the creator, queue, assignee, follow-up or template of a help request'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (NEW.status = 'resolved' AND OLD.status IN ('open', 'in_progress')) THEN
    RAISE EXCEPTION 'students may only resolve an open or in-progress help request'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.resolved_by IS DISTINCT FROM OLD.resolved_by
     AND NEW.resolved_by IS NOT NULL
     AND NOT public.authorizeforprofile_in_class(NEW.resolved_by, OLD.class_id) THEN
    RAISE EXCEPTION 'resolved_by must be your own profile' USING ERRCODE = '42501';
  END IF;

  IF NEW.referenced_submission_id IS DISTINCT FROM OLD.referenced_submission_id
     AND NEW.referenced_submission_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.submissions s
                      WHERE s.id = NEW.referenced_submission_id AND s.class_id = OLD.class_id) THEN
    RAISE EXCEPTION 'referenced submission % is not in this class', NEW.referenced_submission_id
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.forbid_help_request_privacy_downgrade()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
    -- Attached to `BEFORE UPDATE OF is_private, class_id`, which fires on the statement's
    -- column list rather than on an actual value change, so the OLD/NEW comparisons here
    -- are what do the work: a no-op write of the same value is allowed through.

    -- A help request never changes class. Nothing in the product moves one -- the class
    -- is derived from the queue at creation and no code path writes this column -- and
    -- allowing it defeats the privacy check below. The UPDATE policy admits a participant
    -- through user_is_in_help_request(id), which is class-independent and passes for both
    -- the old and the new row, so a participant who happens to be staff in some OTHER
    -- class could re-home the request into that class and authorize their own downgrade:
    -- in a single statement if we authorized against NEW, or in two statements (move,
    -- then downgrade) even if we authorize against OLD. Blocking the move is what closes
    -- both. It is also the only thing keeping the row consistent with its help_queue,
    -- which belongs to the original class.
    IF NEW.class_id IS DISTINCT FROM OLD.class_id THEN
        RAISE EXCEPTION 'help request % cannot be moved between classes', OLD.id
            USING ERRCODE = '42501';
    END IF;

    -- Authorize against OLD.class_id. NEW.class_id is caller-controlled in the same
    -- statement, so authorizing against it would let the caller pick the class that
    -- grants them staff privileges.
    IF OLD.is_private = true AND NEW.is_private = false
       AND OLD.class_id NOT IN (SELECT public.user_class_ids_with_capability('help_students')) THEN
        RAISE EXCEPTION 'only course staff may make a private help request public'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.forbid_help_request_privacy_downgrade() IS
'Guards the help-request privacy boundary. Rejects true -> false transitions of help_requests.is_private unless the caller holds help_students in the request''s OWN class (OLD.class_id), and rejects any change to class_id.';

-- ---------------------------------------------------------------------------
-- help_requests
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Students can create help requests in their class" ON public.help_requests;

CREATE POLICY "Students can create help requests in their class" ON public.help_requests
FOR INSERT TO authenticated
WITH CHECK (
  public.authorizeforclass(class_id)
  AND assignee IS NULL
  AND EXISTS (SELECT 1 FROM public.help_queues hq WHERE hq.id = help_queue AND hq.class_id = help_requests.class_id)
  AND (template_id IS NULL
       OR EXISTS (SELECT 1 FROM public.help_request_templates t
                   WHERE t.id = template_id AND t.class_id = help_requests.class_id))
  AND (referenced_submission_id IS NULL
       OR EXISTS (SELECT 1 FROM public.submissions s
                   WHERE s.id = referenced_submission_id AND s.class_id = help_requests.class_id))
  AND (followup_to IS NULL OR public.can_follow_up_help_request(followup_to, class_id))
  AND (
    class_id IN (SELECT public.user_class_ids_with_capability('help_students'))
    -- Class admin: same admin branch as authorizeforhelprequeststaff (admin holds no
    -- capabilities by design).
    OR EXISTS (
         SELECT 1 FROM public.user_privileges up
          WHERE up.user_id = auth.uid()
            AND up.class_id = help_requests.class_id
            AND up.role = 'admin')
    OR (
      created_by IS NOT NULL
      AND public.authorizeforprofile_in_class(created_by, class_id)
      AND status = 'open'
      AND resolved_by IS NULL
      AND resolved_at IS NULL
    )
  )
);

DROP POLICY IF EXISTS "instructors and graders can update" ON public.help_requests;
DROP POLICY IF EXISTS "Staff can update help requests" ON public.help_requests;

CREATE POLICY "Staff can update help requests"
ON public.help_requests
FOR UPDATE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('help_students')))
WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('help_students')));

DROP POLICY IF EXISTS "Students can update their own help requests" ON public.help_requests;

CREATE POLICY "Students can update their own help requests"
ON public.help_requests
FOR UPDATE TO authenticated
USING (
  class_id IN (SELECT public.user_class_ids_with_capability('help_students'))
  OR public.user_is_in_help_request(id)
)
WITH CHECK (
  class_id IN (SELECT public.user_class_ids_with_capability('help_students'))
  OR public.user_is_in_help_request(id)
);

DROP POLICY IF EXISTS "Staff can delete help requests in their class" ON public.help_requests;

CREATE POLICY "Staff can delete help requests in their class"
ON public.help_requests
FOR DELETE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('help_students')));

-- ---------------------------------------------------------------------------
-- help_request_messages
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "insert own message into accessible help request" ON public.help_request_messages;

CREATE POLICY "insert own message into accessible help request" ON public.help_request_messages
FOR INSERT TO authenticated
WITH CHECK (
  public.authorizeforprofile_in_class(author, class_id)
  AND public.can_access_help_request(help_request_id)
  AND COALESCE(is_system_message, false) = false
  AND (
    instructors_only = false
    OR class_id IN (SELECT public.user_class_ids_with_capability('help_students'))
    -- Class admin: same admin branch as authorizeforhelprequeststaff (admin holds no
    -- capabilities by design).
    OR EXISTS (
         SELECT 1 FROM public.user_privileges up
          WHERE up.user_id = auth.uid()
            AND up.class_id = help_request_messages.class_id
            AND up.role = 'admin')
  )
);

-- ---------------------------------------------------------------------------
-- help_request_students
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Staff can update help request memberships" ON public.help_request_students;

CREATE POLICY "Staff can update help request memberships" ON public.help_request_students
FOR UPDATE TO authenticated
USING (
  class_id IN (SELECT public.user_class_ids_with_capability('help_students'))
  -- Class admin: same admin branch as authorizeforhelprequeststaff (admin holds no
  -- capabilities by design).
  OR EXISTS (
       SELECT 1 FROM public.user_privileges up
        WHERE up.user_id = auth.uid()
          AND up.class_id = help_request_students.class_id
          AND up.role = 'admin')
)
WITH CHECK (
  (class_id IN (SELECT public.user_class_ids_with_capability('help_students'))
   OR EXISTS (
        SELECT 1 FROM public.user_privileges up
         WHERE up.user_id = auth.uid()
           AND up.class_id = help_request_students.class_id
           AND up.role = 'admin'))
  AND public.can_add_profile_to_help_request(help_request_id, profile_id)
);

-- ---------------------------------------------------------------------------
-- help_request_moderation
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Graders can create moderation records" ON public.help_request_moderation;
DROP POLICY IF EXISTS "Staff can create moderation records" ON public.help_request_moderation;

CREATE POLICY "Staff can create moderation records"
ON public.help_request_moderation
FOR INSERT TO authenticated
WITH CHECK (
  class_id IN (SELECT public.user_class_ids_with_capability('help_students'))
  AND EXISTS (
    SELECT 1 FROM public.user_privileges up
    WHERE up.user_id = auth.uid()
      AND (up.public_profile_id = moderator_profile_id OR up.private_profile_id = moderator_profile_id)
  )
  AND EXISTS (
    SELECT 1 FROM public.help_requests hr
    WHERE hr.id = help_request_id AND hr.class_id = help_request_moderation.class_id
  )
);

DROP POLICY IF EXISTS "Instructors can CRUD moderation records" ON public.help_request_moderation;
DROP POLICY IF EXISTS "Instructors can delete moderation records" ON public.help_request_moderation;
DROP POLICY IF EXISTS "Office hours managers can insert moderation records" ON public.help_request_moderation;
DROP POLICY IF EXISTS "Office hours managers can update moderation records" ON public.help_request_moderation;
DROP POLICY IF EXISTS "Office hours managers can delete moderation records" ON public.help_request_moderation;

-- New values (INSERT / UPDATE WITH CHECK) must point at a help request of the same
-- class. Existing rows (UPDATE USING / DELETE USING) need only manage_office_hours in
-- the row's class so a manager can repair or delete a legacy mismatch.
CREATE POLICY "Office hours managers can insert moderation records"
ON public.help_request_moderation
FOR INSERT TO authenticated
WITH CHECK (
  class_id IN (SELECT public.user_class_ids_with_capability('manage_office_hours'))
  AND EXISTS (
    SELECT 1 FROM public.help_requests hr
    WHERE hr.id = help_request_id AND hr.class_id = help_request_moderation.class_id
  )
);

CREATE POLICY "Office hours managers can update moderation records"
ON public.help_request_moderation
FOR UPDATE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_office_hours')))
WITH CHECK (
  class_id IN (SELECT public.user_class_ids_with_capability('manage_office_hours'))
  AND EXISTS (
    SELECT 1 FROM public.help_requests hr
    WHERE hr.id = help_request_id AND hr.class_id = help_request_moderation.class_id
  )
);

CREATE POLICY "Office hours managers can delete moderation records"
ON public.help_request_moderation
FOR DELETE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_office_hours')));

-- ---------------------------------------------------------------------------
-- student_karma_notes: keep SELECT as grader view; writes -> help_students
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Instructors and graders can CRUD karma notes" ON public.student_karma_notes;
DROP POLICY IF EXISTS "student_karma_notes_select_staff" ON public.student_karma_notes;
DROP POLICY IF EXISTS "Staff can insert karma notes" ON public.student_karma_notes;
DROP POLICY IF EXISTS "Staff can update karma notes" ON public.student_karma_notes;
DROP POLICY IF EXISTS "Staff can delete karma notes" ON public.student_karma_notes;

CREATE POLICY "student_karma_notes_select_staff"
ON public.student_karma_notes
FOR SELECT TO authenticated
USING (public.authorizeforclassgrader(class_id));

CREATE POLICY "Staff can insert karma notes"
ON public.student_karma_notes
FOR INSERT TO authenticated
WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('help_students')));

CREATE POLICY "Staff can update karma notes"
ON public.student_karma_notes
FOR UPDATE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('help_students')))
WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('help_students')));

CREATE POLICY "Staff can delete karma notes"
ON public.student_karma_notes
FOR DELETE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('help_students')));

-- ---------------------------------------------------------------------------
-- help_request_work_sessions
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Staff can create work sessions" ON public.help_request_work_sessions;

CREATE POLICY "Staff can create work sessions"
ON public.help_request_work_sessions
FOR INSERT TO authenticated
WITH CHECK (
  class_id IN (SELECT public.user_class_ids_with_capability('help_students'))
  AND EXISTS (
    SELECT 1 FROM public.help_requests hr
    WHERE hr.id = help_request_id AND hr.class_id = help_request_work_sessions.class_id
  )
);

DROP POLICY IF EXISTS "Instructors can delete work sessions" ON public.help_request_work_sessions;
DROP POLICY IF EXISTS "Office hours managers can delete work sessions" ON public.help_request_work_sessions;

CREATE POLICY "Office hours managers can delete work sessions"
ON public.help_request_work_sessions
FOR DELETE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_office_hours')));

DROP POLICY IF EXISTS "TAs can update own records, instructors can update any" ON public.help_request_work_sessions;
DROP POLICY IF EXISTS "TAs can update own records, managers can update any" ON public.help_request_work_sessions;

CREATE POLICY "TAs can update own records, managers can update any"
ON public.help_request_work_sessions
FOR UPDATE TO authenticated
USING (
  ta_profile_id IN (
    SELECT up.private_profile_id
    FROM public.user_privileges up
    WHERE up.user_id = auth.uid() AND up.private_profile_id IS NOT NULL
    UNION
    SELECT up.public_profile_id
    FROM public.user_privileges up
    WHERE up.user_id = auth.uid() AND up.public_profile_id IS NOT NULL
  )
  OR class_id IN (SELECT public.user_class_ids_with_capability('manage_office_hours'))
)
WITH CHECK (
  (
    ta_profile_id IN (
      SELECT up.private_profile_id
      FROM public.user_privileges up
      WHERE up.user_id = auth.uid() AND up.private_profile_id IS NOT NULL
      UNION
      SELECT up.public_profile_id
      FROM public.user_privileges up
      WHERE up.user_id = auth.uid() AND up.public_profile_id IS NOT NULL
    )
    OR class_id IN (SELECT public.user_class_ids_with_capability('manage_office_hours'))
  )
  -- Same parent check as INSERT: the session's request must be in the session's class.
  AND EXISTS (
    SELECT 1 FROM public.help_requests hr
    WHERE hr.id = help_request_id AND hr.class_id = help_request_work_sessions.class_id
  )
);

-- ---------------------------------------------------------------------------
-- help_queues: graders can CRUD today -> help_students; SELECT unchanged
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Instructors and graders can do anything" ON public.help_queues;
DROP POLICY IF EXISTS "Staff can create help queues" ON public.help_queues;
DROP POLICY IF EXISTS "Staff can update help queues" ON public.help_queues;
DROP POLICY IF EXISTS "Staff can delete help queues" ON public.help_queues;

CREATE POLICY "Staff can create help queues"
ON public.help_queues
FOR INSERT TO authenticated
WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('help_students')));

CREATE POLICY "Staff can update help queues"
ON public.help_queues
FOR UPDATE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('help_students')))
WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('help_students')));

CREATE POLICY "Staff can delete help queues"
ON public.help_queues
FOR DELETE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('help_students')));

-- ---------------------------------------------------------------------------
-- help_queue_assignments: graders can CRUD today -> help_students; SELECT unchanged
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Instructors and graders can CRUD help queue assignments" ON public.help_queue_assignments;
DROP POLICY IF EXISTS "Staff can create help queue assignments" ON public.help_queue_assignments;
DROP POLICY IF EXISTS "Staff can update help queue assignments" ON public.help_queue_assignments;
DROP POLICY IF EXISTS "Staff can delete help queue assignments" ON public.help_queue_assignments;

-- New values (INSERT / UPDATE WITH CHECK) must point at a queue of the same class.
-- Existing rows (UPDATE USING / DELETE USING) need only help_students in the row's
-- class so a holder can repair or delete a legacy mismatch.
CREATE POLICY "Staff can create help queue assignments"
ON public.help_queue_assignments
FOR INSERT TO authenticated
WITH CHECK (
  class_id IN (SELECT public.user_class_ids_with_capability('help_students'))
  AND EXISTS (
    SELECT 1 FROM public.help_queues hq
    WHERE hq.id = help_queue_id AND hq.class_id = help_queue_assignments.class_id
  )
);

CREATE POLICY "Staff can update help queue assignments"
ON public.help_queue_assignments
FOR UPDATE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('help_students')))
WITH CHECK (
  class_id IN (SELECT public.user_class_ids_with_capability('help_students'))
  AND EXISTS (
    SELECT 1 FROM public.help_queues hq
    WHERE hq.id = help_queue_id AND hq.class_id = help_queue_assignments.class_id
  )
);

CREATE POLICY "Staff can delete help queue assignments"
ON public.help_queue_assignments
FOR DELETE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('help_students')));

-- A TA whose role loses help_students can still end their own open shift, so it stops
-- counting as staffed. Only ending is allowed: the new row must be inactive with an
-- ended_at, stay theirs, and stay on a queue of the same class. Starting a shift still
-- needs help_students.
DROP POLICY IF EXISTS "Staff can end their own active shift" ON public.help_queue_assignments;

CREATE POLICY "Staff can end their own active shift"
ON public.help_queue_assignments
FOR UPDATE TO authenticated
USING (
  ended_at IS NULL
  AND ta_profile_id IN (
    SELECT up.private_profile_id
    FROM public.user_privileges up
    WHERE up.user_id = auth.uid() AND up.class_id = help_queue_assignments.class_id
  )
)
WITH CHECK (
  is_active = false
  AND ended_at IS NOT NULL
  AND ta_profile_id IN (
    SELECT up.private_profile_id
    FROM public.user_privileges up
    WHERE up.user_id = auth.uid() AND up.class_id = help_queue_assignments.class_id
  )
  AND EXISTS (
    SELECT 1 FROM public.help_queues hq
    WHERE hq.id = help_queue_id AND hq.class_id = help_queue_assignments.class_id
  )
);

-- ---------------------------------------------------------------------------
-- help_request_templates: instructor-only -> manage_office_hours; SELECT unchanged
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Instructors can CRUD templates" ON public.help_request_templates;
DROP POLICY IF EXISTS "Office hours managers can create templates" ON public.help_request_templates;
DROP POLICY IF EXISTS "Office hours managers can update templates" ON public.help_request_templates;
DROP POLICY IF EXISTS "Office hours managers can delete templates" ON public.help_request_templates;

CREATE POLICY "Office hours managers can create templates"
ON public.help_request_templates
FOR INSERT TO authenticated
WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('manage_office_hours')));

CREATE POLICY "Office hours managers can update templates"
ON public.help_request_templates
FOR UPDATE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_office_hours')))
WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('manage_office_hours')));

CREATE POLICY "Office hours managers can delete templates"
ON public.help_request_templates
FOR DELETE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_office_hours')));

-- ---------------------------------------------------------------------------
-- student_help_activity: instructor CRUD -> manage_office_hours; SELECT / system INSERT stay
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Instructors can CRUD activity records" ON public.student_help_activity;
DROP POLICY IF EXISTS "Office hours managers can insert activity records" ON public.student_help_activity;
DROP POLICY IF EXISTS "Office hours managers can update activity records" ON public.student_help_activity;
DROP POLICY IF EXISTS "Office hours managers can delete activity records" ON public.student_help_activity;

-- New values (INSERT / UPDATE WITH CHECK) must point at a help request of the same
-- class. Existing rows (UPDATE USING / DELETE USING) need only manage_office_hours in
-- the row's class so a manager can repair or delete a legacy mismatch.
CREATE POLICY "Office hours managers can insert activity records"
ON public.student_help_activity
FOR INSERT TO authenticated
WITH CHECK (
  class_id IN (SELECT public.user_class_ids_with_capability('manage_office_hours'))
  AND EXISTS (
    SELECT 1 FROM public.help_requests hr
    WHERE hr.id = help_request_id AND hr.class_id = student_help_activity.class_id
  )
);

CREATE POLICY "Office hours managers can update activity records"
ON public.student_help_activity
FOR UPDATE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_office_hours')))
WITH CHECK (
  class_id IN (SELECT public.user_class_ids_with_capability('manage_office_hours'))
  AND EXISTS (
    SELECT 1 FROM public.help_requests hr
    WHERE hr.id = help_request_id AND hr.class_id = student_help_activity.class_id
  )
);

CREATE POLICY "Office hours managers can delete activity records"
ON public.student_help_activity
FOR DELETE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_office_hours')));

-- Authorization from escalate_help_request in 20261116150100_help_request_escalation.sql.
CREATE OR REPLACE FUNCTION public.escalate_help_request(p_help_request_id bigint, p_note text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_request public.help_requests%ROWTYPE;
  v_caller uuid;
  v_note text := regexp_replace(coalesce(p_note, ''), '^\s+|\s+$', '', 'g');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;
  IF char_length(v_note) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'an escalation note of 1 to 500 characters is required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_request FROM public.help_requests WHERE id = p_help_request_id FOR UPDATE;
  IF NOT FOUND OR NOT (v_request.class_id IN (SELECT public.user_class_ids_with_capability('help_students'))
     OR EXISTS (
          SELECT 1 FROM public.user_privileges up
           WHERE up.user_id = auth.uid()
             AND up.class_id = v_request.class_id
             AND up.role = 'admin')) THEN
    RAISE EXCEPTION 'help request % not found', p_help_request_id USING ERRCODE = '42501';
  END IF;

  v_caller := public.help_request_caller_profile(v_request.class_id);
  IF v_request.status <> 'in_progress' OR v_request.assignee IS DISTINCT FROM v_caller THEN
    RAISE EXCEPTION 'only the staff member currently helping can escalate this request' USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('pawtograder.help_request_escalation_rpc', 'on', true);

  INSERT INTO public.help_request_escalations (class_id, help_request_id, escalated_by, source, previous_assignee, note)
  VALUES (v_request.class_id, v_request.id, v_caller, 'staff', v_request.assignee, v_note);

  -- Clearing the assignee ends the work session (trigger_help_request_work_sessions).
  UPDATE public.help_requests
     SET status = 'open',
         assignee = NULL,
         escalation_count = escalation_count + 1,
         last_escalated_at = now(),
         check_in_expires_at = NULL
   WHERE id = v_request.id;

  PERFORM public.log_help_request_activity(v_request.id, v_request.class_id, 'request_escalated', 'Request escalated by staff');

  PERFORM set_config('pawtograder.help_request_escalation_rpc', 'off', true);
END;
$$;

REVOKE ALL ON FUNCTION public.escalate_help_request(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.escalate_help_request(bigint, text) TO authenticated, service_role;

-- Authorization from finish_help_request in 20261116150100_help_request_escalation.sql.
CREATE OR REPLACE FUNCTION public.finish_help_request(p_help_request_id bigint, p_end_ticket boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_request public.help_requests%ROWTYPE;
  v_caller uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_request FROM public.help_requests WHERE id = p_help_request_id FOR UPDATE;
  IF NOT FOUND OR NOT (v_request.class_id IN (SELECT public.user_class_ids_with_capability('help_students'))
     OR EXISTS (
          SELECT 1 FROM public.user_privileges up
           WHERE up.user_id = auth.uid()
             AND up.class_id = v_request.class_id
             AND up.role = 'admin')) THEN
    RAISE EXCEPTION 'help request % not found', p_help_request_id USING ERRCODE = '42501';
  END IF;

  -- Resolve applies to active tickets. End ticket also applies to a resolved ticket whose
  -- check-in is still pending, so staff can withdraw the student's option to escalate.
  IF NOT (v_request.status IN ('open', 'in_progress')
          OR (p_end_ticket AND v_request.status = 'resolved'
              AND v_request.check_in_expires_at > now())) THEN
    RAISE EXCEPTION 'help request % is already finished', p_help_request_id USING ERRCODE = '22023';
  END IF;

  -- Same refusal as the CLI close: once a ticket is resolved or closed, video-call-controls
  -- disables both Join and End Call, so finishing it mid-call would strand the meeting with no way
  -- to tear it down.
  IF v_request.is_video_live THEN
    RAISE EXCEPTION 'end the video call before finishing help request %', p_help_request_id USING ERRCODE = '22023';
  END IF;

  v_caller := public.help_request_caller_profile(v_request.class_id);

  PERFORM set_config('pawtograder.help_request_escalation_rpc', 'on', true);

  UPDATE public.help_requests
     SET status = CASE WHEN p_end_ticket THEN 'closed'::public.help_request_status ELSE 'resolved'::public.help_request_status END,
         resolved_by = coalesce(CASE WHEN v_request.status = 'resolved' THEN resolved_by END, v_caller),
         resolved_at = coalesce(CASE WHEN v_request.status = 'resolved' THEN resolved_at END, now()),
         -- Only a ticket someone was helping gets a check-in. Resolving an unclaimed ticket
         -- must not hand the student an escalation they never earned by being helped.
         check_in_expires_at = CASE
           WHEN p_end_ticket OR v_request.status <> 'in_progress' THEN NULL
           ELSE now() + interval '10 minutes'
         END
   WHERE id = v_request.id;

  -- Ending a ticket that is already resolved only withdraws the check-in; the resolution was
  -- logged when staff pressed Resolve, and student_help_activity has no uniqueness constraint.
  IF v_request.status <> 'resolved' THEN
    PERFORM public.log_help_request_activity(
      v_request.id, v_request.class_id, 'request_resolved',
      CASE WHEN p_end_ticket THEN 'Request ended by staff' ELSE 'Request resolved by staff' END);
  END IF;

  PERFORM set_config('pawtograder.help_request_escalation_rpc', 'off', true);
END;
$$;

REVOKE ALL ON FUNCTION public.finish_help_request(bigint, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finish_help_request(bigint, boolean) TO authenticated, service_role;

-- Dashboard RPC from 20261117174200_office_hours_queue_health.sql; only authorization changes.
CREATE OR REPLACE FUNCTION public.office_hours_queue_health(p_class_id bigint)
RETURNS TABLE (
  queue_id bigint,
  queue_name text,
  waiting integer,
  oldest_wait_seconds integer,
  helping integer,
  staffed_tas integer,
  unstaffed_seconds integer,
  resolved_today integer,
  median_wait_seconds_today integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_zone text;
  v_start timestamptz;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.user_class_ids_with_capability('help_students') AS allowed(class_id)
    WHERE allowed.class_id = p_class_id
  ) THEN
    RAISE EXCEPTION 'Only course staff can view queue health' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(c.time_zone, 'UTC') INTO v_zone FROM public.classes c WHERE c.id = p_class_id;
  v_start := date_trunc('day', now() AT TIME ZONE v_zone) AT TIME ZONE v_zone;

  RETURN QUERY
  WITH queues AS (
    SELECT q.id, q.name FROM public.help_queues q WHERE q.class_id = p_class_id AND q.is_active
  ),
  open_now AS (
    SELECT r.help_queue AS qid, COUNT(*)::int AS n, MIN(r.created_at) AS oldest
    FROM public.help_requests r
    WHERE r.class_id = p_class_id AND r.status = 'open'
    GROUP BY r.help_queue
  ),
  helping_now AS (
    SELECT r.help_queue AS qid, COUNT(*)::int AS n
    FROM public.help_requests r
    WHERE r.class_id = p_class_id AND r.status = 'in_progress'
    GROUP BY r.help_queue
  ),
  staffed AS (
    SELECT a.help_queue_id AS qid, COUNT(*)::int AS n
    FROM public.help_queue_assignments a
    WHERE a.class_id = p_class_id AND a.ended_at IS NULL
    GROUP BY a.help_queue_id
  ),
  last_shift_end AS (
    SELECT a.help_queue_id AS qid, MAX(a.ended_at) AS ended
    FROM public.help_queue_assignments a
    WHERE a.class_id = p_class_id AND a.ended_at IS NOT NULL
    GROUP BY a.help_queue_id
  ),
  resolved_today AS (
    SELECT r.help_queue AS qid, COUNT(*)::int AS n
    FROM public.help_requests r
    WHERE r.class_id = p_class_id AND r.status = 'resolved' AND r.resolved_at >= v_start
    GROUP BY r.help_queue
  ),
  first_pickup AS (
    SELECT s.help_request_id, MIN(s.started_at) AS picked_at
    FROM public.help_request_work_sessions s
    WHERE s.class_id = p_class_id
    GROUP BY s.help_request_id
  ),
  median_wait AS (
    SELECT r.help_queue AS qid,
           percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (fp.picked_at - r.created_at))
           ) AS med
    FROM public.help_requests r
    JOIN first_pickup fp ON fp.help_request_id = r.id
    WHERE r.class_id = p_class_id AND fp.picked_at >= v_start
    GROUP BY r.help_queue
  )
  SELECT
    q.id,
    q.name,
    COALESCE(o.n, 0),
    COALESCE(EXTRACT(EPOCH FROM (now() - o.oldest)), 0)::int,
    COALESCE(h.n, 0),
    COALESCE(s.n, 0),
    CASE WHEN COALESCE(s.n, 0) = 0 AND le.ended IS NOT NULL
         THEN EXTRACT(EPOCH FROM (now() - le.ended))::int
         ELSE NULL END,
    COALESCE(rt.n, 0),
    COALESCE(m.med, 0)::int
  FROM queues q
  LEFT JOIN open_now o ON o.qid = q.id
  LEFT JOIN helping_now h ON h.qid = q.id
  LEFT JOIN staffed s ON s.qid = q.id
  LEFT JOIN last_shift_end le ON le.qid = q.id
  LEFT JOIN resolved_today rt ON rt.qid = q.id
  LEFT JOIN median_wait m ON m.qid = q.id
  ORDER BY q.name;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.office_hours_queue_health(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.office_hours_queue_health(bigint) TO authenticated;

-- Column allowlist from 20261117174100_classes_office_hours_health_thresholds.sql.
-- Other settings still need an instructor. Thresholds need manage_office_hours for every caller.
CREATE OR REPLACE FUNCTION public.only_calendar_or_discord_ids_changed(new_row classes)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (
      SELECT COALESCE(
        (
          SELECT bool_and(
            (changed.key = ANY(ARRAY[
              -- discord_server_id is absent on purpose: claim_discord_guild() is its only writer.
              -- A category id inside a guild the class already controls, so it stays editable.
              'discord_channel_group_id',
              'office_hours_ics_url',
              'events_ics_url',
              'office_hours_description'
            ]) AND public.authorizeforclassinstructor(new_row.id))
            OR (changed.key = 'office_hours_health_thresholds'
                AND new_row.id IN (SELECT public.user_class_ids_with_capability('manage_office_hours')))
            OR changed.key = 'updated_at'
          )
          FROM (
            SELECT t.key
            FROM jsonb_each(to_jsonb(new_row)) AS t(key, value)
            WHERE (to_jsonb(old_row)->t.key) IS DISTINCT FROM t.value
          ) AS changed
        ),
        true  -- no differences -> allow
      )
      FROM public.classes old_row
      WHERE old_row.id = new_row.id
    ),
    false -- no matching row found
  );
$function$;

DROP POLICY IF EXISTS "classes_instructor_update_calendar_or_discord_ids" ON public.classes;
CREATE POLICY "classes_instructor_update_calendar_or_discord_ids" ON public.classes
FOR UPDATE TO authenticated
USING (
  public.authorizeforclassinstructor(id)
  OR id IN (SELECT public.user_class_ids_with_capability('manage_office_hours'))
)
WITH CHECK (
  (public.authorizeforclassinstructor(id)
   OR id IN (SELECT public.user_class_ids_with_capability('manage_office_hours')))
  AND public.only_calendar_or_discord_ids_changed(classes.*)
);
