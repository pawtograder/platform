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
--   * user_is_in_help_request matched a profile from any class, so a membership row naming
--     the wrong class still granted access;
--   * any user could watch any help request in any class, and the watcher fan-out in
--     create_help_request_notification sends the request text to every watcher;
--   * file references on private requests could be read, edited and deleted by any class
--     member; feedback and read receipts could be written under another student's
--     profile; is_system_message could be set by students to spoof system messages.
--
-- The root cause is fixed with a composite foreign key: every child row's
-- (help_request_id, class_id) must match its request, so class_id can no longer disagree
-- with the request on INSERT or UPDATE. The policies below then check the caller's access
-- to that request, as create_help_request_with_participants already does. SECURITY
-- DEFINER triggers and RPCs run as the table owner, so these policies do not apply to
-- them. The BEFORE UPDATE trigger on help_requests does apply, keyed on auth.uid(); no
-- current RPC updates help_requests, and the CLI edge function uses the service role.
--
-- The cleanup below deletes the rows that broke these rules. Forensics on production were
-- run before this migration, so the deleted rows are not archived.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Course staff for help requests. The help_requests and help_request_messages SELECT
-- policies treat 'admin' as staff, so the write checks do too.
CREATE OR REPLACE FUNCTION public.authorizeforhelprequeststaff(p_class_id bigint)
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
       AND up.role IN ('instructor', 'grader', 'admin')
  );
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

-- Only the user's profiles in the request's own class count. The old version matched a
-- profile from any class.
CREATE OR REPLACE FUNCTION public.user_is_in_help_request(p_help_request_id bigint, p_user_id uuid DEFAULT auth.uid())
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.help_requests hr
      JOIN public.user_privileges up
        ON up.user_id = p_user_id AND up.class_id = hr.class_id
     WHERE hr.id = p_help_request_id
       AND (hr.created_by = up.private_profile_id
            OR EXISTS (SELECT 1 FROM public.help_request_students hrs
                        WHERE hrs.help_request_id = hr.id
                          AND hrs.profile_id IN (up.private_profile_id, up.public_profile_id)))
  );
$$;

-- Realtime channel auth (check_unified_realtime_authorization) and the message, watcher
-- and read receipt policies use this.
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
        public.authorizeforhelprequeststaff(hr.class_id)
        OR public.user_is_in_help_request(hr.id)
      ELSE false
    END
  FROM public.help_requests hr
  WHERE hr.id = help_request_id;
$$;

-- Staff, or the creator or a member of the request. Used for file references, which only
-- the people working on a request may change.
CREATE OR REPLACE FUNCTION public.authorizeforhelprequestparticipant(p_help_request_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT public.authorizeforhelprequeststaff(hr.class_id)
         OR public.user_is_in_help_request(hr.id)
    FROM public.help_requests hr
   WHERE hr.id = p_help_request_id;
$$;

-- ---------------------------------------------------------------------------
-- Cleanup, then the composite foreign keys
-- ---------------------------------------------------------------------------

-- Rows whose class_id disagrees with their request were never written by the product
-- (the RPC and the client both copy the request's class). They must go before the
-- composite foreign keys can be added.
DELETE FROM public.help_request_message_read_receipts c USING public.help_requests hr
 WHERE hr.id = c.help_request_id AND hr.class_id <> c.class_id;
DELETE FROM public.help_request_messages c USING public.help_requests hr
 WHERE hr.id = c.help_request_id AND hr.class_id <> c.class_id;
DELETE FROM public.help_request_students c USING public.help_requests hr
 WHERE hr.id = c.help_request_id AND hr.class_id <> c.class_id;
DELETE FROM public.help_request_watchers c USING public.help_requests hr
 WHERE hr.id = c.help_request_id AND hr.class_id <> c.class_id;
DELETE FROM public.help_request_file_references c USING public.help_requests hr
 WHERE hr.id = c.help_request_id AND hr.class_id <> c.class_id;
DELETE FROM public.help_request_feedback c USING public.help_requests hr
 WHERE hr.id = c.help_request_id AND hr.class_id <> c.class_id;

-- The old watcher INSERT policy checked only user_id, so a user could watch a private
-- request they cannot see. Remove watchers who do not pass can_access_help_request.
DELETE FROM public.help_request_watchers w
 USING public.help_requests hr
 WHERE hr.id = w.help_request_id
   AND NOT EXISTS (
         SELECT 1 FROM public.user_privileges up
          WHERE up.user_id = w.user_id
            AND up.class_id = hr.class_id
            AND (up.role IN ('instructor', 'grader', 'admin') OR hr.is_private = false))
   AND NOT public.user_is_in_help_request(hr.id, w.user_id);

ALTER TABLE public.help_requests
  ADD CONSTRAINT help_requests_id_class_id_key UNIQUE (id, class_id);

-- Each composite key replaces the single-column key on help_request_id, keeping its
-- ON UPDATE / ON DELETE actions. Keeping both would give PostgREST two relationships
-- between the same tables and break embedding.
ALTER TABLE public.help_request_messages
  DROP CONSTRAINT help_request_messages_help_request_id_fkey,
  ADD CONSTRAINT help_request_messages_help_request_id_fkey
    FOREIGN KEY (help_request_id, class_id) REFERENCES public.help_requests (id, class_id);
ALTER TABLE public.help_request_students
  DROP CONSTRAINT help_request_students_help_request_id_fkey,
  ADD CONSTRAINT help_request_students_help_request_id_fkey
    FOREIGN KEY (help_request_id, class_id) REFERENCES public.help_requests (id, class_id)
    ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE public.help_request_watchers
  DROP CONSTRAINT help_request_watchers_help_request_id_fkey,
  ADD CONSTRAINT help_request_watchers_help_request_id_fkey
    FOREIGN KEY (help_request_id, class_id) REFERENCES public.help_requests (id, class_id)
    ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE public.help_request_file_references
  DROP CONSTRAINT help_request_file_references_help_request_id_fkey,
  ADD CONSTRAINT help_request_file_references_help_request_id_fkey
    FOREIGN KEY (help_request_id, class_id) REFERENCES public.help_requests (id, class_id)
    ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE public.help_request_feedback
  DROP CONSTRAINT help_request_feedback_help_request_id_fkey,
  ADD CONSTRAINT help_request_feedback_help_request_id_fkey
    FOREIGN KEY (help_request_id, class_id) REFERENCES public.help_requests (id, class_id)
    ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE public.help_request_message_read_receipts
  DROP CONSTRAINT help_request_message_read_receipts_help_request_id_fkey,
  ADD CONSTRAINT help_request_message_read_receipts_help_request_id_fkey
    FOREIGN KEY (help_request_id, class_id) REFERENCES public.help_requests (id, class_id)
    ON UPDATE CASCADE ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- help_request_messages
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "insert for self in class" ON public.help_request_messages;
CREATE POLICY "insert own message into accessible help request" ON public.help_request_messages
FOR INSERT TO authenticated
WITH CHECK (
  public.authorizeforprofile_in_class(author, class_id)
  AND public.can_access_help_request(help_request_id)
  AND COALESCE(is_system_message, false) = false
  AND (instructors_only = false OR public.authorizeforhelprequeststaff(class_id))
);

-- ---------------------------------------------------------------------------
-- help_request_students
-- ---------------------------------------------------------------------------

-- Replaces check_can_add_to_help_request, which authorized against the row's
-- caller-supplied class_id. The profile being added must be an active member of the
-- request's class. Staff may add anyone; on a private request, other callers must
-- already be in it.
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
     AND (public.authorizeforhelprequeststaff(hr.class_id)
          OR (public.authorizeforclass(hr.class_id)
              AND (hr.is_private = false OR public.user_is_in_help_request(hr.id))))
    FROM public.help_requests hr
   WHERE hr.id = p_help_request_id;
$$;

DROP POLICY IF EXISTS "Students can add students to help requests they have access to" ON public.help_request_students;
DROP FUNCTION IF EXISTS public.check_can_add_to_help_request(bigint, uuid, bigint);
CREATE POLICY "Students can add students to help requests they have access to" ON public.help_request_students
FOR INSERT TO authenticated
WITH CHECK (public.can_add_profile_to_help_request(help_request_id, profile_id));

-- The old WITH CHECK looked only at the row's class_id, so staff could move a membership
-- to any request and profile. Apply the INSERT rule to the new row.
DROP POLICY IF EXISTS "Staff can update help request memberships" ON public.help_request_students;
CREATE POLICY "Staff can update help request memberships" ON public.help_request_students
FOR UPDATE TO authenticated
USING (public.authorizeforhelprequeststaff(class_id))
WITH CHECK (
  public.authorizeforhelprequeststaff(class_id)
  AND public.can_add_profile_to_help_request(help_request_id, profile_id)
);

-- p_class_id was unused. It now has to match the request's class.
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
  IF v_class_id IS NULL OR v_class_id IS DISTINCT FROM p_class_id THEN
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

-- ---------------------------------------------------------------------------
-- help_requests
-- ---------------------------------------------------------------------------

-- followup_to must be a request in the same class that the caller is staff for or took
-- part in, as in create_help_request_with_participants.
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
       AND (public.authorizeforhelprequeststaff(p_class_id)
            OR public.user_is_in_help_request(prev.id))
  );
$$;

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
    public.authorizeforhelprequeststaff(class_id)
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
-- Clearing creator, follow-up or template is allowed: those foreign keys are ON DELETE
-- SET NULL, and the cascade runs as whoever deleted the referenced row, who may not be
-- staff in this request's class.
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
  IF auth.uid() IS NULL OR public.authorizeforhelprequeststaff(OLD.class_id) THEN
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

DROP TRIGGER IF EXISTS enforce_help_request_update_columns_tr ON public.help_requests;
CREATE TRIGGER enforce_help_request_update_columns_tr
BEFORE UPDATE ON public.help_requests
FOR EACH ROW EXECUTE FUNCTION public.enforce_help_request_update_columns();

-- ---------------------------------------------------------------------------
-- help_request_file_references
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Users can CRUD file references in their classes" ON public.help_request_file_references;

-- Visible exactly when the help request is. The predicate is written out here, as in the
-- help_request_messages SELECT policy, instead of an EXISTS on help_requests, which would
-- run the full help_requests SELECT policy for every row. Previously any class member
-- could read the code references on every private request.
CREATE POLICY "Users can view file references on help requests they can see" ON public.help_request_file_references
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1
    FROM public.user_privileges up
    JOIN public.help_requests hr ON hr.id = help_request_file_references.help_request_id
   WHERE up.user_id = auth.uid()
     AND up.class_id = help_request_file_references.class_id
     AND (up.role IN ('instructor', 'grader', 'admin')
          OR (up.role = 'student' AND hr.is_private = false)
          OR (up.role = 'student' AND hr.is_private = true
              AND (hr.created_by IN (up.private_profile_id, up.public_profile_id)
                   OR hr.assignee IN (up.private_profile_id, up.public_profile_id)
                   OR EXISTS (SELECT 1 FROM public.help_request_students hrs
                               WHERE hrs.help_request_id = hr.id
                                 AND hrs.profile_id IN (up.private_profile_id, up.public_profile_id)))))
));

CREATE POLICY "Participants and staff can add file references" ON public.help_request_file_references
FOR INSERT TO authenticated
WITH CHECK (public.authorizeforhelprequestparticipant(help_request_id));

CREATE POLICY "Participants and staff can update file references" ON public.help_request_file_references
FOR UPDATE TO authenticated
USING (public.authorizeforhelprequestparticipant(help_request_id))
WITH CHECK (public.authorizeforhelprequestparticipant(help_request_id));

CREATE POLICY "Participants and staff can delete file references" ON public.help_request_file_references
FOR DELETE TO authenticated
USING (public.authorizeforhelprequestparticipant(help_request_id));

-- ---------------------------------------------------------------------------
-- help_request_feedback
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Students associated with the help request can create" ON public.help_request_feedback;
CREATE POLICY "Students associated with the help request can create" ON public.help_request_feedback
FOR INSERT TO authenticated
WITH CHECK (
  public.authorizeforprofile_in_class(student_profile_id, class_id)
  AND public.user_is_in_help_request(help_request_id)
);

-- ---------------------------------------------------------------------------
-- help_request_message_read_receipts
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Users can create read receipts for accessible help requests via" ON public.help_request_message_read_receipts;
CREATE POLICY "Users can create read receipts for accessible help requests via" ON public.help_request_message_read_receipts
FOR INSERT TO authenticated
WITH CHECK (
  public.authorizeforprofile_in_class(viewer_id, class_id)
  AND public.can_access_help_request(help_request_id)
  AND EXISTS (SELECT 1 FROM public.help_request_messages m
               WHERE m.id = message_id AND m.help_request_id = help_request_message_read_receipts.help_request_id)
);

-- ---------------------------------------------------------------------------
-- help_request_watchers
-- ---------------------------------------------------------------------------

-- INSERT and UPDATE use the same check, so a watcher row cannot be moved onto a request
-- the user cannot see.
DROP POLICY IF EXISTS "Users can insert their own help request watchers" ON public.help_request_watchers;
CREATE POLICY "Users can insert their own help request watchers" ON public.help_request_watchers
FOR INSERT TO authenticated
WITH CHECK (
  (SELECT auth.uid()) = user_id
  AND public.can_access_help_request(help_request_id)
);

DROP POLICY IF EXISTS "Users can update their own help request watchers" ON public.help_request_watchers;
CREATE POLICY "Users can update their own help request watchers" ON public.help_request_watchers
FOR UPDATE TO authenticated
USING ((SELECT auth.uid()) = user_id)
WITH CHECK (
  (SELECT auth.uid()) = user_id
  AND public.can_access_help_request(help_request_id)
);

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

-- Supabase grants EXECUTE on new public functions to anon. These are only needed by RLS
-- policies, which run as authenticated.
REVOKE ALL ON FUNCTION public.authorizeforhelprequeststaff(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.authorizeforhelprequeststaff(bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.authorizeforprofile_in_class(uuid, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.authorizeforprofile_in_class(uuid, bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.authorizeforhelprequestparticipant(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.authorizeforhelprequestparticipant(bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.can_add_profile_to_help_request(bigint, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_add_profile_to_help_request(bigint, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.can_follow_up_help_request(bigint, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_follow_up_help_request(bigint, bigint) TO authenticated, service_role;
