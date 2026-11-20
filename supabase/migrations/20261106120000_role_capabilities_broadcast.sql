-- Tell staff pages when a role's capabilities change (#1010, step 3).
--
-- useCapability() asks user_class_capabilities() once per class page and asks again when a staff
-- channel note says something it depends on changed: the viewer's own user_roles row (already
-- broadcast by broadcast_user_roles_realtime) or a role's capabilities (this trigger).
-- role_capabilities has no class_id or id column, so broadcast_course_table_change_unified can't
-- be reused; this sends the same staff_data_change payload, looking the class up via class_roles.
--
-- class_roles needs no trigger: creating or renaming a role changes nobody's capabilities, and a
-- role someone is on can't be deleted (the user_roles foreign key). When an unused role is
-- deleted, its role_capabilities rows cascade after the class_roles row is gone, so the lookup
-- finds no class and nothing is sent, which is right: nobody held that role.

CREATE OR REPLACE FUNCTION public.broadcast_role_capabilities_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.role_capabilities;
  v_class_id bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := OLD;
  ELSE
    v_row := NEW;
  END IF;

  SELECT cr.class_id INTO v_class_id
  FROM public.class_roles cr
  WHERE cr.id = v_row.role_id;

  IF v_class_id IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM public.safe_broadcast(
    jsonb_build_object(
      'type', 'staff_data_change',
      'operation', TG_OP,
      'table', 'role_capabilities',
      'row_id', v_row.role_id,
      'class_id', v_class_id,
      'data', to_jsonb(v_row),
      'timestamp', NOW()
    ),
    'broadcast',
    'class:' || v_class_id || ':staff',
    true
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.broadcast_role_capabilities_change() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER broadcast_role_capabilities_realtime
AFTER INSERT OR UPDATE OR DELETE ON public.role_capabilities
FOR EACH ROW EXECUTE FUNCTION public.broadcast_role_capabilities_change();
