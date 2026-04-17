-- When a group assignment is released before groups exist, students get individual repos from
-- create_all_repos_for_assignment (release trigger / cron). Later, when instructors create groups
-- or move students, nothing re-invoked repo creation. Re-queue repo sync when groups or
-- membership change for an already-released group/both assignment so new group repos are created.
--
-- create_all_repos_for_assignment enforces authorizeforclassinstructor when auth.uid() is set.
-- This trigger runs in student group-join/leave transactions, so it must call
-- create_all_repos_for_assignment_internal (no auth guard) instead of the public RPC.

CREATE OR REPLACE FUNCTION public.create_all_repos_for_assignment_internal(
  course_id bigint,
  assignment_id bigint,
  p_force boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_course_id bigint := course_id;
  v_assignment_id bigint := assignment_id;
  v_slug text;
  v_org text;
  v_template_repo text;
  v_group_config text;
  v_assignment_slug text;
  v_latest_template_sha text;
  r_user_id uuid;
  r_username text;
  r_profile_id uuid;
  r_group_id bigint;
  r_group_name text;
  r_members text[];
BEGIN
  IF v_course_id IS NULL OR v_assignment_id IS NULL THEN
    RAISE WARNING 'create_all_repos_for_assignment_internal called with NULL parameters, skipping';
    RETURN;
  END IF;

  SELECT c.slug, c.github_org, a.template_repo, a.group_config, a.slug, a.latest_template_sha
  INTO v_slug, v_org, v_template_repo, v_group_config, v_assignment_slug, v_latest_template_sha
  FROM public.assignments a
  JOIN public.classes c ON c.id = a.class_id
  WHERE a.id = v_assignment_id AND a.class_id = v_course_id;

  IF v_slug IS NULL OR v_org IS NULL OR v_template_repo IS NULL OR v_template_repo = '' THEN
    RAISE EXCEPTION 'Invalid class/assignment or missing template repo (class_id %, assignment_id %)',
      v_course_id, v_assignment_id;
  END IF;

  RAISE NOTICE 'Resolved org=%, slug=%, template=%', v_org, v_slug, v_template_repo;

  FOR r_user_id, r_username, r_profile_id IN
    SELECT ur.user_id, u.github_username, ur.private_profile_id
    FROM public.user_roles ur
    JOIN public.users u ON u.user_id = ur.user_id
    WHERE ur.class_id = v_course_id
      AND ur.role = 'student'
      AND ur.disabled = false
      AND u.github_username IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.assignment_groups_members agm
        JOIN public.assignment_groups ag ON ag.id = agm.assignment_group_id
        WHERE ag.assignment_id = v_assignment_id AND agm.profile_id = ur.private_profile_id
      )
      AND (
        p_force
        OR NOT EXISTS (
          SELECT 1 FROM public.repositories r
          WHERE r.repository = v_org || '/' || v_slug || '-' || v_assignment_slug || '-' || u.github_username
        )
      )
  LOOP
    RAISE NOTICE 'Enqueue individual repo: %/%', v_org, v_slug || '-' || v_assignment_slug || '-' || r_username;
    PERFORM public.enqueue_github_create_repo(
      v_course_id,
      v_org,
      v_slug || '-' || v_assignment_slug || '-' || r_username,
      v_template_repo,
      v_slug,
      ARRAY[r_username],
      false,
      null,
      v_assignment_id,
      r_profile_id,
      null,
      v_latest_template_sha
    );
  END LOOP;

  FOR r_group_id, r_group_name, r_members IN
    SELECT DISTINCT ON (ag.id)
           ag.id AS group_id,
           ag.name AS group_name,
           array_remove(array_agg(u.github_username), null) AS members
    FROM public.assignment_groups ag
    LEFT JOIN public.assignment_groups_members agm ON agm.assignment_group_id = ag.id
    LEFT JOIN public.user_roles ur ON ur.private_profile_id = agm.profile_id AND ur.disabled = false
    LEFT JOIN public.users u ON u.user_id = ur.user_id
    WHERE ag.assignment_id = v_assignment_id
      AND (
        p_force
        OR NOT EXISTS (
          SELECT 1 FROM public.repositories r
          WHERE r.repository = v_org || '/' || v_slug || '-' || v_assignment_slug || '-group-' || ag.name
        )
      )
    GROUP BY ag.id, ag.name
    HAVING array_length(array_remove(array_agg(u.github_username), null), 1) > 0
  LOOP
    RAISE NOTICE 'Enqueue group repo: %/%', v_org, v_slug || '-' || v_assignment_slug || '-group-' || r_group_name;
    PERFORM public.enqueue_github_create_repo(
      v_course_id,
      v_org,
      v_slug || '-' || v_assignment_slug || '-group-' || r_group_name,
      v_template_repo,
      v_slug,
      r_members,
      false,
      null,
      v_assignment_id,
      null,
      r_group_id,
      v_latest_template_sha
    );
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_all_repos_for_assignment_internal(bigint, bigint, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_all_repos_for_assignment_internal(bigint, bigint, boolean) TO postgres;

COMMENT ON FUNCTION public.create_all_repos_for_assignment_internal(bigint, bigint, boolean) IS
  'Enqueue repo creation for an assignment without auth.uid() / instructor checks; for triggers and other trusted callers.';

CREATE OR REPLACE FUNCTION public.create_all_repos_for_assignment(
  course_id bigint,
  assignment_id bigint,
  p_force boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RAISE NOTICE 'Enqueue create_all_repos_for_assignment course_id=%, assignment_id=%, force=%',
    course_id, assignment_id, p_force;
  IF course_id IS NULL OR assignment_id IS NULL THEN
    RAISE WARNING 'create_all_repos_for_assignment called with NULL parameters, skipping';
    RETURN;
  END IF;

  IF auth.uid() IS NOT NULL AND NOT public.authorizeforclassinstructor(course_id::bigint) THEN
    RAISE EXCEPTION 'Access denied: Only instructors can force-create repos for class %', course_id;
  END IF;

  PERFORM public.create_all_repos_for_assignment_internal(course_id, assignment_id, p_force);
END;
$function$;

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

  PERFORM public.create_all_repos_for_assignment_internal(v_class_id, v_assignment_id, false);

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
