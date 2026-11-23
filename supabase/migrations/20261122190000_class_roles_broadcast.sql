-- Role metadata belongs on the same staff channel as enrollments and capabilities.
CREATE TRIGGER broadcast_class_roles_realtime
AFTER INSERT OR UPDATE OR DELETE ON public.class_roles
FOR EACH ROW EXECUTE FUNCTION public.broadcast_course_table_change_unified();

-- The existing capability trigger looks up the course through class_roles. A cascade runs
-- after its parent is gone, so clear the children first while that lookup still works.
-- A refused role deletion rolls these deletes and their broadcasts back in the same transaction.
CREATE FUNCTION public.class_roles_delete_capabilities_before_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.role_capabilities WHERE role_id = OLD.id;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.class_roles_delete_capabilities_before_delete() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER class_roles_delete_capabilities_before_delete
BEFORE DELETE ON public.class_roles
FOR EACH ROW EXECUTE FUNCTION public.class_roles_delete_capabilities_before_delete();
