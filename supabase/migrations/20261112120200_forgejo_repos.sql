-- CW-13 (#1093): forgejo-reconciler creates student repos for released Forgejo assignments, after
-- it creates accounts. forgejo_repos_needed() lists students who have a Forgejo login but no ready
-- repo. Creation is safe to repeat: the repo name is fixed, an existing repo is adopted, and adding a
-- collaborator twice changes nothing. So, unlike accounts, nothing is claimed first.
--
-- Individual assignments in template_only_staff mode only. Groups are #1236; the handout repo is
-- set up on Forgejo by hand until #1237.

CREATE OR REPLACE FUNCTION public.forgejo_repos_needed(p_instance_url text, p_limit integer)
RETURNS TABLE (
  assignment_id bigint,
  class_id bigint,
  profile_id uuid,
  login text,
  owner text,
  name text,
  template_repo text
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT a.id, a.class_id, ur.private_profile_id, ga.login,
         coalesce(nullif(c.forgejo_org, ''), c.slug), a.slug || '-' || ga.login, a.template_repo
  FROM public.assignments a
  JOIN public.classes c ON c.id = a.class_id
  JOIN public.user_roles ur ON ur.class_id = a.class_id AND ur.role = 'student' AND NOT ur.disabled
  JOIN public.git_accounts ga ON ga.user_id = ur.user_id AND ga.provider = 'forgejo'
    AND ga.instance_url = p_instance_url AND ga.login IS NOT NULL
  WHERE a.git_provider = 'forgejo'
    AND a.repo_mode = 'template_only_staff'
    AND a.group_config = 'individual'
    AND coalesce(a.template_repo, '') <> ''
    AND a.release_date <= now()
    AND public.cloud_workspaces_enabled(c.features)
    AND NOT EXISTS (
      SELECT 1 FROM public.repositories r
      WHERE r.assignment_id = a.id AND r.profile_id = ur.private_profile_id AND r.is_github_ready
    )
  -- Random, not by id: a row that keeps failing stays listed, and a fixed order would let 50 of them
  -- fill every pass. Each pass samples the backlog, so everything is reached eventually.
  ORDER BY random()
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.forgejo_repos_needed(text, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.forgejo_repos_needed(text, integer) TO service_role;

-- create_all_repos_for_assignment(bigint, bigint, boolean): latest body from
-- 20261106140000_assignments_save_by_capability.sql, plus the Forgejo branch. Both release paths
-- (the assignments trigger and the every-minute release check) call this, so a Forgejo assignment's
-- repos are created on release instead of at the next hourly run. The GitHub path would raise here
-- for a class with no github_org.
CREATE OR REPLACE FUNCTION public.create_all_repos_for_assignment(course_id bigint, assignment_id bigint, p_force boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if course_id is null or assignment_id is null then
    raise warning 'create_all_repos_for_assignment called with NULL parameters, skipping';
    return;
  end if;

  -- Admins of any course, or holders of manage_assignments in this class (#1010): the
  -- assignments trigger calls this when a save moves release_date into the past.
  if auth.uid() is not null and not (
    exists (select 1 from public.user_privileges up where up.user_id = auth.uid() and up.role = 'admin')
    or course_id::bigint in (select public.user_class_ids_with_capability('manage_assignments'))
  ) then
    raise exception 'Access denied: manage_assignments is required to create repos for class %', course_id;
  end if;

  if exists (select 1 from public.assignments a
             where a.id = create_all_repos_for_assignment.assignment_id and a.git_provider = 'forgejo') then
    perform public.kick_forgejo_reconciler();
    return;
  end if;

  perform public.create_all_repos_for_assignment_internal(course_id, assignment_id, p_force);
end;
$function$;
