-- A custom role starts as a copy of the default grader role, and the default grader role can be
-- edited (#1010).
--
-- Why: this replaces the "custom roles can only add" rule from 20261030120000_protect_class_roles.sql.
-- In the user study, one instructor wanted TAs who can do more than a grader, and another wanted a
-- course coordinator who can assign grading but not grade, which is less than a grader. With every
-- custom role built on top of the default grader role, that second role couldn't exist. Now each
-- role is its own full list, and an instructor can turn a copied default off.
--
-- What:
--   1. user_class_capabilities() returns only the capabilities of the user's own class role
--      (user_privileges.class_role_id). It no longer adds the default role for their app_role.
--      It stays the one place that decides, so useCapability, lib/ssrUtils.ts, the edge-function
--      helper and every policy (through user_class_ids_with_capability) follow without changes.
--   2. A new custom role starts with the class's default grader role's capabilities, copied by an
--      AFTER INSERT trigger on class_roles. manage_roles is never copied, nor a capability the
--      creator doesn't hold. After that the two lists are separate: editing one doesn't change the
--      other.
--   3. Role managers can now add and remove capabilities on the default grader role, with the same
--      limits as on custom roles: never manage_roles, and only a capability they hold. The
--      instructor, student and admin roles stay fixed, and the default grader role still can't be
--      renamed or deleted (the class_roles policies stay custom-only).
--   4. Existing custom roles get the default grader role's capabilities, so no grader loses what
--      they held through the old rule.
--
-- Not changed: instructors, students and admins sit on their own default role, so for them the old
-- join added nothing and they hold exactly what they held before. Every capability is still on the
-- default instructor role. The #1171 broadcast trigger (20261106120000_role_capabilities_broadcast.sql)
-- already sends a staff note for a change on any role, so pages refresh for the default grader role too.
--
-- Safe to run again: every policy and trigger is dropped first, and the inserts skip rows that exist.

-- ---------------------------------------------------------------------------
-- 1. A user holds only their own class role's capabilities
-- ---------------------------------------------------------------------------

-- The one place that decides what a user can do: in each class, the capabilities of their class
-- role. The useCapability RPC, lib/ssrUtils.ts and user_class_ids_with_capability() all read it.
CREATE OR REPLACE FUNCTION public.user_class_capabilities()
RETURNS TABLE (class_id bigint, capability text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT DISTINCT up.class_id, rc.capability
  FROM public.user_privileges up
  JOIN public.role_capabilities rc ON rc.role_id = up.class_role_id
  WHERE up.user_id = (SELECT auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- 2. A new custom role starts as a copy of the default grader role
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER so the copy doesn't depend on the role_capabilities INSERT policy. It keeps that
-- policy's last rule itself: a signed-in creator only gets the capabilities they hold in the class,
-- so a copy never gives the new role more than its creator has. Migrations and the service role
-- (no auth.uid()) copy the whole list.
CREATE OR REPLACE FUNCTION public.class_roles_copy_default_grader_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  INSERT INTO public.role_capabilities (role_id, capability)
  SELECT NEW.id, rc.capability
  FROM public.class_roles base
  JOIN public.role_capabilities rc ON rc.role_id = base.id
  WHERE base.class_id = NEW.class_id
    AND base.default_for = 'grader'
    AND rc.capability <> 'manage_roles'
    AND (
      (SELECT auth.uid()) IS NULL
      OR rc.capability IN (
        SELECT ucc.capability FROM public.user_class_capabilities() ucc WHERE ucc.class_id = NEW.class_id
      )
    )
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.class_roles_copy_default_grader_role() FROM PUBLIC, anon, authenticated;

-- Default roles (seed_default_class_roles) are skipped: they get their capabilities there.
DROP TRIGGER IF EXISTS trg_class_roles_copy_default_grader_role ON public.class_roles;
CREATE TRIGGER trg_class_roles_copy_default_grader_role
AFTER INSERT ON public.class_roles
FOR EACH ROW
WHEN (NEW.default_for IS NULL)
EXECUTE FUNCTION public.class_roles_copy_default_grader_role();

-- ---------------------------------------------------------------------------
-- 3. Role managers can edit the default grader role
-- ---------------------------------------------------------------------------

-- The #1171 policies with one wider condition: the role is a custom role or the default grader
-- role. Everything else is the same.
DROP POLICY IF EXISTS "Role managers can add capabilities to custom class roles" ON public.role_capabilities;
DROP POLICY IF EXISTS "Role managers can remove capabilities from custom class roles" ON public.role_capabilities;
DROP POLICY IF EXISTS "Role managers can add capabilities to grader roles" ON public.role_capabilities;
DROP POLICY IF EXISTS "Role managers can remove capabilities from grader roles" ON public.role_capabilities;

-- The last check: only a capability the caller holds in the role's class, so a role manager can't
-- give a role more than they have.
CREATE POLICY "Role managers can add capabilities to grader roles" ON public.role_capabilities
  FOR INSERT TO authenticated
  WITH CHECK (
    capability <> 'manage_roles'
    AND role_id IN (
      SELECT cr.id FROM public.class_roles cr
      WHERE (cr.default_for IS NULL OR cr.default_for = 'grader')
        AND cr.class_id IN (SELECT public.user_class_ids_with_capability('manage_roles'))
    )
    AND capability IN (
      SELECT ucc.capability
      FROM public.user_class_capabilities() ucc
      JOIN public.class_roles cr ON cr.class_id = ucc.class_id
      WHERE cr.id = role_capabilities.role_id
    )
  );

CREATE POLICY "Role managers can remove capabilities from grader roles" ON public.role_capabilities
  FOR DELETE TO authenticated
  USING (
    capability <> 'manage_roles'
    AND role_id IN (
      SELECT cr.id FROM public.class_roles cr
      WHERE (cr.default_for IS NULL OR cr.default_for = 'grader')
        AND cr.class_id IN (SELECT public.user_class_ids_with_capability('manage_roles'))
    )
  );

-- ---------------------------------------------------------------------------
-- 4. Existing custom roles keep what their graders held
-- ---------------------------------------------------------------------------

-- Under the old rule a grader on a custom role also held the default grader role's capabilities.
-- Put those on the custom role itself, so nobody loses them now that the join is gone.
INSERT INTO public.role_capabilities (role_id, capability)
SELECT custom.id, rc.capability
FROM public.class_roles custom
JOIN public.class_roles base ON base.class_id = custom.class_id AND base.default_for = 'grader'
JOIN public.role_capabilities rc ON rc.role_id = base.id
WHERE custom.default_for IS NULL
  AND rc.capability <> 'manage_roles'
ON CONFLICT DO NOTHING;
