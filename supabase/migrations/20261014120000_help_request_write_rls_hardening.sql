-- Office hours write-side RLS hardening.
--
-- The INSERT policies on the help_request_* child tables checked only that the caller
-- belongs to the row's class_id and (sometimes) owns the author column. None of them tied
-- help_request_id to that class or to the caller's access, so:
--   * any student could post into any help request in their class, private or not, and
--     the insert fans out to the participants' notifications and the help_request:<id>
--     realtime channel (reported bug);
--   * class_id is caller-supplied, so rows could name a help request in a different class;
--   * check_can_add_to_help_request authorized staff against the caller-supplied class_id,
--     so a grader in ANY class could add themselves to a private request in another class,
--     after which can_access_help_request (realtime channel auth) let them subscribe to it;
--   * file references on private requests could be read, edited and deleted by any class
--     member; feedback and read receipts could be written under another student's
--     profile; is_system_message could be set by students to spoof system messages.
-- The create_help_request_with_participants RPC already enforces all of this; these
-- policies bring direct table writes up to the same bar. SECURITY DEFINER triggers and
-- RPCs run as the table owner, so these policies do not apply to them. The BEFORE UPDATE
-- trigger on help_requests does apply, keyed on auth.uid(); no current RPC updates
-- help_requests, and the CLI edge function uses the service role.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Class of a help request, readable regardless of the caller's SELECT visibility (a
-- student cannot SELECT a private request they are not in, so an EXISTS against
-- help_requests inside a policy would silently fail closed for the wrong reason).
CREATE OR REPLACE FUNCTION public.help_request_class_id(p_help_request_id bigint)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT hr.class_id FROM public.help_requests hr WHERE hr.id = p_help_request_id;
$$;

-- True when p_profile_id is one of the caller's own profiles in p_class_id.
CREATE OR REPLACE FUNCTION public.authorizeforprofile_in_class(p_profile_id uuid, p_class_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_privileges up
     WHERE up.user_id = auth.uid()
       AND up.class_id = p_class_id
       AND (up.private_profile_id = p_profile_id OR up.public_profile_id = p_profile_id)
  );
$$;

-- Private-request membership is class-independent (user_is_in_help_request matches on
-- profile alone), so a membership row that names the wrong class still granted access.
-- Require class membership on that path too. This is what closes realtime channel access
-- (check_unified_realtime_authorization -> can_access_help_request) for forged rows.
CREATE OR REPLACE FUNCTION public.can_access_help_request(help_request_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT
    CASE
      WHEN hr.is_private = false THEN
        public.authorizeforclass(hr.class_id)
      WHEN hr.is_private = true THEN
        public.authorizeforclassgrader(hr.class_id)
        OR (public.authorizeforclass(hr.class_id) AND public.user_is_in_help_request(hr.id))
      ELSE false
    END
  FROM public.help_requests hr
  WHERE hr.id = help_request_id;
$$;

-- ---------------------------------------------------------------------------
-- help_request_messages
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "insert for self in class" ON public.help_request_messages;
CREATE POLICY "insert own message into accessible help request" ON public.help_request_messages
FOR INSERT TO authenticated
WITH CHECK (
  public.authorizeforprofile_in_class(author, class_id)
  AND class_id = public.help_request_class_id(help_request_id)
  AND public.can_access_help_request(help_request_id)
  AND COALESCE(is_system_message, false) = false
  AND (instructors_only = false OR public.authorizeforclassgrader(class_id))
);

-- ---------------------------------------------------------------------------
-- help_request_students
-- ---------------------------------------------------------------------------

-- Authorize against the request's own class, never the row's caller-supplied class_id,
-- and require the profile being added to be an active member of that class.
CREATE OR REPLACE FUNCTION public.check_can_add_to_help_request(
  p_help_request_id bigint, p_profile_id uuid, p_user_id uuid, p_class_id bigint)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_hr public.help_requests%ROWTYPE;
  v_role public.app_role;
  v_private_profile_id uuid;
  v_public_profile_id uuid;
BEGIN
  SELECT * INTO v_hr FROM public.help_requests WHERE id = p_help_request_id;
  IF NOT FOUND OR v_hr.class_id IS DISTINCT FROM p_class_id THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.class_id = v_hr.class_id
       AND ur.disabled = false
       AND (ur.private_profile_id = p_profile_id OR ur.public_profile_id = p_profile_id)
  ) THEN
    RETURN false;
  END IF;

  SELECT up.role, up.private_profile_id, up.public_profile_id
    INTO v_role, v_private_profile_id, v_public_profile_id
    FROM public.user_privileges up
   WHERE up.user_id = p_user_id AND up.class_id = v_hr.class_id
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_role IN ('instructor', 'grader', 'admin') THEN
    RETURN true;
  END IF;

  IF NOT v_hr.is_private THEN
    RETURN true;
  END IF;

  RETURN v_hr.created_by IN (v_private_profile_id, v_public_profile_id)
      OR EXISTS (
           SELECT 1 FROM public.help_request_students hrs
            WHERE hrs.help_request_id = p_help_request_id
              AND hrs.profile_id IN (v_private_profile_id, v_public_profile_id)
         );
END;
$$;

-- The 3-arg overload is no longer referenced by the policy; keep it but make it fail
-- closed on a class mismatch in case anything else still calls it.
CREATE OR REPLACE FUNCTION public.check_can_add_to_help_request(
  p_help_request_id bigint, p_user_id uuid, p_class_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT public.check_can_add_to_help_request(
    p_help_request_id,
    (SELECT up.private_profile_id FROM public.user_privileges up
      WHERE up.user_id = p_user_id AND up.class_id = p_class_id LIMIT 1),
    p_user_id,
    p_class_id);
$$;

DROP POLICY IF EXISTS "Students can add students to help requests they have access to" ON public.help_request_students;
CREATE POLICY "Students can add students to help requests they have access to" ON public.help_request_students
FOR INSERT TO authenticated
WITH CHECK (public.check_can_add_to_help_request(help_request_id, profile_id, auth.uid(), class_id));

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
  v_role public.app_role;
  v_private_profile_id uuid;
  v_public_profile_id uuid;
BEGIN
  SELECT class_id INTO v_class_id FROM public.help_requests WHERE id = p_help_request_id;
  IF v_class_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT up.role, up.private_profile_id, up.public_profile_id
    INTO v_role, v_private_profile_id, v_public_profile_id
    FROM public.user_privileges up
   WHERE up.user_id = p_user_id AND up.class_id = v_class_id
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_role IN ('instructor', 'grader', 'admin') THEN
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

-- Membership rows whose class_id disagrees with their request were never written by the
-- product (the RPC and the client both copy the request's class). Run the forensics
-- queries BEFORE applying this so the evidence is captured first.
DELETE FROM public.help_request_students hrs
 USING public.help_requests hr
 WHERE hr.id = hrs.help_request_id
   AND hr.class_id <> hrs.class_id;

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
  AND (
    public.authorizeforclassgrader(class_id)
    OR (
      created_by IS NOT NULL
      AND public.authorizeforprofile_in_class(created_by, class_id)
      AND status = 'open'
      AND resolved_by IS NULL
      AND resolved_at IS NULL
    )
  )
);

-- The participant UPDATE policy admits every column. Pin the ones a student has no reason
-- to change; staff may still move a request between queues, but only within its class.
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
  IF auth.uid() IS NULL OR public.authorizeforclassgrader(OLD.class_id) THEN
    RETURN NEW;
  END IF;

  IF NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.help_queue IS DISTINCT FROM OLD.help_queue
     OR NEW.assignee IS DISTINCT FROM OLD.assignee
     OR NEW.followup_to IS DISTINCT FROM OLD.followup_to
     OR NEW.template_id IS DISTINCT FROM OLD.template_id THEN
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

DROP TRIGGER IF EXISTS enforce_help_request_update_columns_tr ON public.help_requests;
CREATE TRIGGER enforce_help_request_update_columns_tr
BEFORE UPDATE ON public.help_requests
FOR EACH ROW EXECUTE FUNCTION public.enforce_help_request_update_columns();

-- ---------------------------------------------------------------------------
-- help_request_file_references
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Users can CRUD file references in their classes" ON public.help_request_file_references;

-- Visible exactly when the help request is. The subquery runs as the caller, so the
-- help_requests SELECT policy decides (staff: all; students: public requests in their
-- class, or private ones they created or joined). Previously any class member could
-- read the code references on every private request.
CREATE POLICY "Users can view file references on help requests they can see" ON public.help_request_file_references
FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.help_requests hr
                WHERE hr.id = help_request_file_references.help_request_id
                  AND hr.class_id = help_request_file_references.class_id));

CREATE POLICY "Participants and staff can add file references" ON public.help_request_file_references
FOR INSERT TO authenticated
WITH CHECK (
  class_id = public.help_request_class_id(help_request_id)
  AND (public.authorizeforclassgrader(class_id)
       OR (public.authorizeforclass(class_id) AND public.user_is_in_help_request(help_request_id)))
);

CREATE POLICY "Participants and staff can update file references" ON public.help_request_file_references
FOR UPDATE TO authenticated
USING (
  public.authorizeforclassgrader(class_id)
  OR (public.authorizeforclass(class_id) AND public.user_is_in_help_request(help_request_id))
)
WITH CHECK (
  class_id = public.help_request_class_id(help_request_id)
  AND (public.authorizeforclassgrader(class_id)
       OR (public.authorizeforclass(class_id) AND public.user_is_in_help_request(help_request_id)))
);

CREATE POLICY "Participants and staff can delete file references" ON public.help_request_file_references
FOR DELETE TO authenticated
USING (
  public.authorizeforclassgrader(class_id)
  OR (public.authorizeforclass(class_id) AND public.user_is_in_help_request(help_request_id))
);

-- ---------------------------------------------------------------------------
-- help_request_feedback
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Students associated with the help request can create" ON public.help_request_feedback;
CREATE POLICY "Students associated with the help request can create" ON public.help_request_feedback
FOR INSERT TO authenticated
WITH CHECK (
  class_id = public.help_request_class_id(help_request_id)
  AND public.authorizeforprofile_in_class(student_profile_id, class_id)
  AND public.user_is_in_help_request(help_request_id)
);

-- ---------------------------------------------------------------------------
-- help_request_message_read_receipts
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Users can create read receipts for accessible help requests via" ON public.help_request_message_read_receipts;
CREATE POLICY "Users can create read receipts for accessible help requests via" ON public.help_request_message_read_receipts
FOR INSERT TO authenticated
WITH CHECK (
  class_id = public.help_request_class_id(help_request_id)
  AND public.authorizeforprofile_in_class(viewer_id, class_id)
  AND public.can_access_help_request(help_request_id)
  AND EXISTS (SELECT 1 FROM public.help_request_messages m
               WHERE m.id = message_id AND m.help_request_id = help_request_message_read_receipts.help_request_id)
);

-- ---------------------------------------------------------------------------
-- help_request_watchers
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Users can insert their own help request watchers" ON public.help_request_watchers;
CREATE POLICY "Users can insert their own help request watchers" ON public.help_request_watchers
FOR INSERT TO authenticated
WITH CHECK (
  (SELECT auth.uid()) = user_id
  AND class_id = public.help_request_class_id(help_request_id)
  AND public.can_access_help_request(help_request_id)
);
