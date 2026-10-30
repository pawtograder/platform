-- Protect the capability tables (#1010, step 2).
--
-- Step 1 (20261027120000_class_roles_and_capabilities.sql) made the tables read-only for users.
-- This lets holders of manage_roles (today: instructors) customize TA access, and nothing else:
--   * class_roles        create, rename and delete custom roles (default_for IS NULL). The four
--                        default roles are fixed: only migrations change them;
--   * role_capabilities  add and remove capabilities on custom roles, except manage_roles, which
--                        stays with instructors;
--   * capabilities       still no app writes: only migrations add capabilities.
--
-- Custom roles hold graders only. The user_roles trigger now enforces that every user sits on the
-- default role for their app_role, except graders, who may sit on a custom role, and it always
-- resets class_role_id when app_role or class_id changes: access follows the role. Who may move a
-- grader between roles stays with the existing instructor-only user_roles UPDATE policy
-- (20250507213522_add_rls_for_user_roles.sql).
--
-- The manage_roles check can't use step 1's inline shape here: it reads role_capabilities, and
-- role_capabilities' own policies read class_roles, so Postgres stops with "infinite recursion
-- detected in policy". Like authorize_for_private_discussion_thread
-- (20250917002948_optimize-submission-rls.sql), a SECURITY DEFINER function reads the tables
-- without RLS. It takes no per-row argument, so `class_id IN (SELECT f(...))` runs it once per
-- statement, not once per row.

-- ---------------------------------------------------------------------------
-- Table privileges
-- ---------------------------------------------------------------------------

-- TRUNCATE skips RLS, so revoke it on all three (same as 20260825140000_audit_findings_2026_08.sql).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.capabilities FROM anon, authenticated;
REVOKE TRUNCATE ON public.class_roles, public.role_capabilities FROM anon, authenticated;

-- RLS cannot express "only these columns may change" on UPDATE. Column privileges limit
-- class_roles updates to a rename, so class_id and default_for can't change.
REVOKE UPDATE ON public.class_roles FROM anon, authenticated;
GRANT UPDATE (name) ON public.class_roles TO authenticated;

-- Inserts may set only class_id and name. Otherwise a user could pick an id the identity sequence
-- hands out later, and seed_default_class_roles (ON CONFLICT DO NOTHING) would silently skip that
-- default role for the next new class.
REVOKE INSERT ON public.class_roles FROM anon, authenticated;
GRANT INSERT (class_id, name) ON public.class_roles TO authenticated;

-- A capability is added or removed, never edited in place.
REVOKE UPDATE ON public.role_capabilities FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- The classes where the current user holds a capability
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.user_class_ids_with_capability(p_capability text)
RETURNS SETOF bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT up.class_id
  FROM public.user_privileges up
  JOIN public.role_capabilities rc ON rc.role_id = up.class_role_id
  WHERE up.user_id = (SELECT auth.uid())
    AND rc.capability = p_capability;
$$;

-- Policies run as the caller, so authenticated needs EXECUTE. It only reveals the caller's own
-- capabilities.
REVOKE ALL ON FUNCTION public.user_class_ids_with_capability(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.user_class_ids_with_capability(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- class_roles: custom roles only, in classes where the user holds manage_roles
-- ---------------------------------------------------------------------------

CREATE POLICY "Role managers can create custom class roles" ON public.class_roles
  FOR INSERT TO authenticated
  WITH CHECK (
    default_for IS NULL
    AND class_id IN (SELECT public.user_class_ids_with_capability('manage_roles'))
  );

CREATE POLICY "Role managers can rename custom class roles" ON public.class_roles
  FOR UPDATE TO authenticated
  USING (
    default_for IS NULL
    AND class_id IN (SELECT public.user_class_ids_with_capability('manage_roles'))
  )
  WITH CHECK (
    default_for IS NULL
    AND class_id IN (SELECT public.user_class_ids_with_capability('manage_roles'))
  );

-- Deleting a role someone is on fails on the user_roles composite foreign key.
CREATE POLICY "Role managers can delete custom class roles" ON public.class_roles
  FOR DELETE TO authenticated
  USING (
    default_for IS NULL
    AND class_id IN (SELECT public.user_class_ids_with_capability('manage_roles'))
  );

-- ---------------------------------------------------------------------------
-- role_capabilities: custom roles only, never manage_roles
-- ---------------------------------------------------------------------------

CREATE POLICY "Role managers can add capabilities to custom class roles" ON public.role_capabilities
  FOR INSERT TO authenticated
  WITH CHECK (
    capability <> 'manage_roles'
    AND role_id IN (
      SELECT cr.id FROM public.class_roles cr
      WHERE cr.default_for IS NULL
        AND cr.class_id IN (SELECT public.user_class_ids_with_capability('manage_roles'))
    )
  );

CREATE POLICY "Role managers can remove capabilities from custom class roles" ON public.role_capabilities
  FOR DELETE TO authenticated
  USING (
    capability <> 'manage_roles'
    AND role_id IN (
      SELECT cr.id FROM public.class_roles cr
      WHERE cr.default_for IS NULL
        AND cr.class_id IN (SELECT public.user_class_ids_with_capability('manage_roles'))
    )
  );

-- ---------------------------------------------------------------------------
-- user_roles: access follows the role, and only graders sit on custom roles
-- ---------------------------------------------------------------------------

-- Replaces step 1's version. A change of app_role or class_id now always resets class_role_id to
-- the new default (before, a custom role was kept, so a Head TA changed to student kept Head TA).
-- Any other class_role_id must be the default for NEW.role, or a custom role when NEW.role is
-- grader. This applies to migrations too.
CREATE OR REPLACE FUNCTION public.user_roles_set_default_class_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_default_for public.app_role;
BEGIN
  IF NEW.class_role_id IS NULL
     OR (TG_OP = 'UPDATE'
         AND (NEW.role IS DISTINCT FROM OLD.role OR NEW.class_id IS DISTINCT FROM OLD.class_id))
  THEN
    SELECT cr.id INTO NEW.class_role_id
    FROM public.class_roles cr
    WHERE cr.class_id = NEW.class_id
      AND cr.default_for = NEW.role;

    IF NEW.class_role_id IS NULL THEN
      RAISE EXCEPTION 'class % has no default class role for app_role %', NEW.class_id, NEW.role;
    END IF;
    RETURN NEW;
  END IF;

  SELECT cr.default_for INTO v_default_for
  FROM public.class_roles cr
  WHERE cr.id = NEW.class_role_id
    AND cr.class_id = NEW.class_id;

  -- A role from another class: the composite foreign key rejects it.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF v_default_for IS DISTINCT FROM NEW.role
     AND NOT (NEW.role = 'grader' AND v_default_for IS NULL)
  THEN
    RAISE EXCEPTION 'class role % is not allowed for app_role %: only graders can be on a custom role',
      NEW.class_role_id, NEW.role
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.user_roles_set_default_class_role() FROM PUBLIC, anon, authenticated;
