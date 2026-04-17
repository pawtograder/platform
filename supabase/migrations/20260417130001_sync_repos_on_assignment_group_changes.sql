-- When a group assignment is released before groups exist, students get individual repos from
-- create_all_repos_for_assignment (release trigger / cron). Later, when instructors create groups
-- or move students, nothing re-invoked repo creation. Re-queue repo sync when groups or
-- membership change for an already-released group/both assignment so new group repos are created.

CREATE OR REPLACE FUNCTION public.sync_repos_after_assignment_group_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_assignment_id bigint;
  v_class_id bigint;
  v_group_config public.assignment_group_mode;
  v_release timestamptz;
  v_template text;
BEGIN
  IF TG_TABLE_NAME = 'assignment_groups' THEN
    IF TG_OP = 'DELETE' THEN
      v_assignment_id := OLD.assignment_id;
      v_class_id := OLD.class_id;
    ELSE
      v_assignment_id := NEW.assignment_id;
      v_class_id := NEW.class_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'assignment_groups_members' THEN
    IF TG_OP = 'DELETE' THEN
      v_assignment_id := OLD.assignment_id;
      v_class_id := OLD.class_id;
    ELSE
      v_assignment_id := NEW.assignment_id;
      v_class_id := NEW.class_id;
    END IF;
  ELSE
    RAISE WARNING 'sync_repos_after_assignment_group_change: unexpected table %', TG_TABLE_NAME;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  SELECT a.group_config, a.release_date, a.template_repo
  INTO v_group_config, v_release, v_template
  FROM public.assignments a
  WHERE a.id = v_assignment_id AND a.class_id = v_class_id;

  IF v_group_config IS NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF v_group_config NOT IN ('groups', 'both') THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF v_template IS NULL OR v_template = '' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF v_release IS NULL OR v_release > now() THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  RAISE NOTICE 'sync_repos_after_assignment_group_change: enqueue repos for assignment_id=%, class_id=% (source=% %)',
    v_assignment_id, v_class_id, TG_TABLE_NAME, TG_OP;

  PERFORM public.create_all_repos_for_assignment(v_class_id, v_assignment_id, false);

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.sync_repos_after_assignment_group_change() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_repos_after_assignment_group_change() TO postgres;

COMMENT ON FUNCTION public.sync_repos_after_assignment_group_change() IS
  'After groups or membership change, enqueue repo creation/sync for released group/both assignments (new groups get repos without toggling release date).';

DROP TRIGGER IF EXISTS trigger_sync_repos_on_assignment_groups_change ON public.assignment_groups;
CREATE TRIGGER trigger_sync_repos_on_assignment_groups_change
  AFTER INSERT OR UPDATE OR DELETE ON public.assignment_groups
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_repos_after_assignment_group_change();

DROP TRIGGER IF EXISTS trigger_sync_repos_on_assignment_groups_members_change ON public.assignment_groups_members;
CREATE TRIGGER trigger_sync_repos_on_assignment_groups_members_change
  AFTER INSERT OR UPDATE OR DELETE ON public.assignment_groups_members
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_repos_after_assignment_group_change();
