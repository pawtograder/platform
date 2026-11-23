-- #1010: removing students, their SIS sync override, and cancelling student invitations follow
-- manage_roster, for student rows only.
--
-- Why: these Enrollments actions needed an instructor, so no TA role could be given them. Now an
-- instructor can give manage_roster to a custom role such as a Head TA. Several roster paths can
-- make someone an instructor, so a non-instructor with manage_roster is limited to students: they
-- can never touch a grader or instructor row, change anyone's role or class_role_id (their own
-- included), or invite or add a grader or instructor.
--
-- What:
--   1. user_roles: a new UPDATE policy lets manage_roster holders update student rows in their
--      class, and the updated row must still be a student. The instructor policy is unchanged.
--   2. A BEFORE UPDATE trigger: someone who isn't an instructor of the class (or a platform admin)
--      may change only `disabled` and `sis_sync_opt_out` on a student row. Without it the policy
--      would also let them change sections, profiles, class_role_id and the rest.
--   3. invitations: the FOR ALL policy (TO public) becomes INSERT, UPDATE and DELETE policies TO
--      authenticated, with the same admin and instructor checks. A new UPDATE policy lets
--      manage_roster holders cancel a pending student invitation, and the same trigger keeps them
--      to the status column.
--
-- Creating invitations stays instructor-only on purpose. auto_accept_invitation_if_user_exists()
-- runs as the table owner and, when an invitation's sis_user_id matches someone already in the
-- class, re-enables that person's row and moves their sections, whatever their role. A "student"
-- invitation could then re-enable a removed grader or instructor. The page has no way for a
-- non-instructor to create invitations (CSV import is instructor-only), so nothing is lost.
--
-- Not changed: the instructor policies on user_roles, the SELECT policies, tags, profiles, and
-- the Forgejo triggers on user_roles (all AFTER triggers).
--
-- Safe to run again: policies and triggers are dropped before they're created, and the function
-- is CREATE OR REPLACE.

-- ---------------------------------------------------------------------------
-- 1. The trigger function, shared by user_roles and invitations
-- ---------------------------------------------------------------------------

-- The trigger's arguments name the columns a non-instructor may change. The row must be a student
-- row before and after.
--
-- It is SECURITY INVOKER on purpose, so current_user is the caller: an update straight from the API
-- runs as `authenticated`. The service role, migrations, cron and SECURITY DEFINER functions (which
-- run as their owner) aren't `authenticated`, so they pass, as they did before this trigger.
CREATE OR REPLACE FUNCTION public.guard_roster_manager_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF current_user <> 'authenticated'
     OR public.authorizeforclassinstructor(OLD.class_id)
     OR public.authorize_for_admin() THEN
    RETURN NEW;
  END IF;

  IF OLD.role IS DISTINCT FROM 'student'::public.app_role
     OR NEW.role IS DISTINCT FROM 'student'::public.app_role
     OR (to_jsonb(NEW) - TG_ARGV) IS DISTINCT FROM (to_jsonb(OLD) - TG_ARGV) THEN
    RAISE EXCEPTION 'Only an instructor can make this change. Without the instructor role you can only change: %',
      array_to_string(TG_ARGV, ', ')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.guard_roster_manager_update() IS
'BEFORE UPDATE trigger: a caller who is not an instructor of the class (or a platform admin) may change only the columns named in the trigger arguments, on a student row.';

-- ---------------------------------------------------------------------------
-- 2. user_roles
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Roster managers can update student enrollments" ON public.user_roles;

CREATE POLICY "Roster managers can update student enrollments" ON public.user_roles
  FOR UPDATE TO authenticated
  USING (role = 'student' AND class_id IN (SELECT public.user_class_ids_with_capability('manage_roster')))
  WITH CHECK (role = 'student' AND class_id IN (SELECT public.user_class_ids_with_capability('manage_roster')));

DROP TRIGGER IF EXISTS guard_roster_manager_update ON public.user_roles;
CREATE TRIGGER guard_roster_manager_update
  BEFORE UPDATE ON public.user_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_roster_manager_update('disabled', 'sis_sync_opt_out', 'updated_at');

-- ---------------------------------------------------------------------------
-- 3. invitations
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Instructors can manage invitations for their classes" ON public.invitations;
DROP POLICY IF EXISTS "Instructors can create invitations" ON public.invitations;
DROP POLICY IF EXISTS "Instructors can update invitations" ON public.invitations;
DROP POLICY IF EXISTS "Instructors can delete invitations" ON public.invitations;
DROP POLICY IF EXISTS "Roster managers can cancel student invitations" ON public.invitations;

-- The admin and instructor checks are the ones the FOR ALL policy had.
CREATE POLICY "Instructors can create invitations" ON public.invitations
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.role = 'admin' AND ur.disabled = false
    )
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.class_id = invitations.class_id
        AND ur.role = 'instructor' AND ur.disabled = false
    )
  );

CREATE POLICY "Instructors can update invitations" ON public.invitations
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.role = 'admin' AND ur.disabled = false
    )
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.class_id = invitations.class_id
        AND ur.role = 'instructor' AND ur.disabled = false
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.role = 'admin' AND ur.disabled = false
    )
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.class_id = invitations.class_id
        AND ur.role = 'instructor' AND ur.disabled = false
    )
  );

CREATE POLICY "Instructors can delete invitations" ON public.invitations
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.role = 'admin' AND ur.disabled = false
    )
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.class_id = invitations.class_id
        AND ur.role = 'instructor' AND ur.disabled = false
    )
  );

-- Cancel only: a pending student invitation can become cancelled, and nothing else. Moving it back
-- to pending would run auto_accept_invitation_if_user_exists() again.
CREATE POLICY "Roster managers can cancel student invitations" ON public.invitations
  FOR UPDATE TO authenticated
  USING (
    role = 'student' AND status = 'pending'
    AND class_id IN (SELECT public.user_class_ids_with_capability('manage_roster'))
  )
  WITH CHECK (
    role = 'student' AND status = 'cancelled'
    AND class_id IN (SELECT public.user_class_ids_with_capability('manage_roster'))
  );

DROP TRIGGER IF EXISTS guard_roster_manager_update ON public.invitations;
CREATE TRIGGER guard_roster_manager_update
  BEFORE UPDATE ON public.invitations
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_roster_manager_update('status', 'updated_at');
