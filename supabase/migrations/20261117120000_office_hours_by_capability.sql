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
--   * help_requests staff UPDATE / DELETE: role IN (instructor, grader) -> help_students.
--     The student half of "Students can update their own help requests" stays.
--   * help_request_students staff UPDATE: authorizeforhelprequeststaff -> help_students.
--   * help_request_moderation grader INSERT -> help_students; instructor FOR ALL and
--     DELETE -> manage_office_hours (split FOR ALL into INSERT / UPDATE / DELETE).
--   * student_karma_notes: split FOR ALL so SELECT stays a grader view and writes follow
--     help_students.
--   * help_request_work_sessions: staff INSERT -> help_students; instructor DELETE ->
--     manage_office_hours; UPDATE keeps the own-record path and swaps the instructor
--     half for manage_office_hours.
--   * help_queues and help_queue_assignments: graders can CRUD these today, so action
--     policies follow help_students (SELECT policies unchanged). Queue assignments also
--     require the parent queue to share class_id.
--   * help_request_templates and student_help_activity instructor FOR ALL -> split into
--     INSERT / UPDATE / DELETE under manage_office_hours (SELECT / system INSERT stay).
--   * SECURITY DEFINER helpers that gate a staff write (can_add_profile_to_help_request,
--     check_can_remove_from_help_request, can_follow_up_help_request,
--     authorizeforhelprequestparticipant, enforce_help_request_update_columns,
--     forbid_help_request_privacy_downgrade) swap only the staff role check for
--     help_students. Signatures, attributes and grants stay. authorizeforhelprequeststaff
--     itself is unchanged so private-request views keep working for any staff member.
--   * Child-row action policies that name a parent id also require that parent to share
--     class_id (moderation, work sessions, queue assignments).
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

  -- Graders can help students, manage flashcards and run live polls today (#1010 areas
  -- 10, 13 and 11), so new classes put those on the default grader role. Instructors
  -- already get them from the CROSS JOIN above.
  INSERT INTO public.role_capabilities (role_id, capability)
  SELECT cr.id, cap
  FROM public.class_roles cr
  CROSS JOIN (VALUES ('help_students'), ('manage_flashcards'), ('run_polls')) AS caps(cap)
  WHERE cr.class_id = p_class_id AND cr.default_for = 'grader'
  ON CONFLICT DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_default_class_roles(bigint) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers: swap only the staff role check for help_students
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.authorizeforhelprequestparticipant(p_help_request_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT (hr.class_id IN (SELECT public.user_class_ids_with_capability('help_students'))
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

  IF v_class_id IN (SELECT public.user_class_ids_with_capability('help_students')) THEN
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
  IF auth.uid() IS NULL
     OR OLD.class_id IN (SELECT public.user_class_ids_with_capability('help_students')) THEN
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
    IF NEW.class_id IS DISTINCT FROM OLD.class_id THEN
        RAISE EXCEPTION 'help request % cannot be moved between classes', OLD.id
            USING ERRCODE = '42501';
    END IF;

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
  )
);

-- ---------------------------------------------------------------------------
-- help_request_students
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Staff can update help request memberships" ON public.help_request_students;

CREATE POLICY "Staff can update help request memberships" ON public.help_request_students
FOR UPDATE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('help_students')))
WITH CHECK (
  class_id IN (SELECT public.user_class_ids_with_capability('help_students'))
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
USING (
  class_id IN (SELECT public.user_class_ids_with_capability('manage_office_hours'))
  AND EXISTS (
    SELECT 1 FROM public.help_requests hr
    WHERE hr.id = help_request_id AND hr.class_id = help_request_moderation.class_id
  )
)
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
USING (
  class_id IN (SELECT public.user_class_ids_with_capability('manage_office_hours'))
  AND EXISTS (
    SELECT 1 FROM public.help_requests hr
    WHERE hr.id = help_request_id AND hr.class_id = help_request_moderation.class_id
  )
);

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
USING (
  class_id IN (SELECT public.user_class_ids_with_capability('help_students'))
  AND EXISTS (
    SELECT 1 FROM public.help_queues hq
    WHERE hq.id = help_queue_id AND hq.class_id = help_queue_assignments.class_id
  )
)
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
USING (
  class_id IN (SELECT public.user_class_ids_with_capability('help_students'))
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
USING (
  class_id IN (SELECT public.user_class_ids_with_capability('manage_office_hours'))
  AND EXISTS (
    SELECT 1 FROM public.help_requests hr
    WHERE hr.id = help_request_id AND hr.class_id = student_help_activity.class_id
  )
)
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
USING (
  class_id IN (SELECT public.user_class_ids_with_capability('manage_office_hours'))
  AND EXISTS (
    SELECT 1 FROM public.help_requests hr
    WHERE hr.id = help_request_id AND hr.class_id = student_help_activity.class_id
  )
);
