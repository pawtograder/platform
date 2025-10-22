CREATE OR REPLACE FUNCTION "public"."create_all_repos_for_assignment"("course_id" bigint, "assignment_id" bigint, "p_force" boolean DEFAULT false) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
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
begin
  raise notice 'Enqueue create_all_repos_for_assignment course_id=%, assignment_id=%, force=%', v_course_id, v_assignment_id, p_force;
  if v_course_id is null or v_assignment_id is null then
    raise warning 'create_all_repos_for_assignment called with NULL parameters, skipping';
    return;
  end if;

  -- Only instructors (manual) or service role may enable force
  if auth.uid() is not null and not public.authorizeforclassinstructor(v_course_id::bigint) then
    raise exception 'Access denied: Only instructors can force-create repos for class %', v_course_id;
  end if;

  select c.slug, c.github_org, a.template_repo, a.group_config, a.slug, a.latest_template_sha
  into v_slug, v_org, v_template_repo, v_group_config, v_assignment_slug, v_latest_template_sha
  from public.assignments a
  join public.classes c on c.id = a.class_id
  where a.id = v_assignment_id and a.class_id = v_course_id;

  if v_slug is null or v_org is null or v_template_repo is null or v_template_repo = '' then
    raise exception 'Invalid class/assignment or missing template repo (class_id %, assignment_id %)', course_id, assignment_id;
  end if;

  raise notice 'Resolved org=%, slug=%, template=%', v_org, v_slug, v_template_repo;

  -- Enqueue individual repos for students not in groups; if p_force, enqueue even if repo exists
  for r_user_id, r_username, r_profile_id in
    select ur.user_id, u.github_username, ur.private_profile_id
    from public.user_roles ur
    join public.users u on u.user_id = ur.user_id
    where ur.class_id = v_course_id
      and ur.role = 'student'
      and ur.disabled = false
      and u.github_username is not null
      and not exists (
        select 1 from public.assignment_groups_members agm
        join public.assignment_groups ag on ag.id = agm.assignment_group_id
        where ag.assignment_id = v_assignment_id and agm.profile_id = ur.private_profile_id
      )
      and (
        p_force
        or not exists (
          select 1 from public.repositories r
          where r.repository = v_org || '/' || v_slug || '-' || v_assignment_slug || '-' || u.github_username
        )
      )
  loop
    raise notice 'Enqueue individual repo: %/%', v_org, v_slug || '-' || v_assignment_slug || '-' || r_username;
    perform public.enqueue_github_create_repo(
      v_course_id,
      v_org,
      v_slug || '-' || v_assignment_slug || '-' || r_username,
      v_template_repo,
      v_slug,
      array[r_username],
      false,
      null,
      v_assignment_id,  -- Pass assignment_id
      r_profile_id,     -- Pass profile_id
      null,             -- assignment_group_id is null for individual repos
      v_latest_template_sha
    );
  end loop;

  -- Enqueue group repos; if p_force, enqueue even if repo exists (worker will sync permissions)
  for r_group_id, r_group_name, r_members in
    select distinct on (ag.id)
           ag.id as group_id,
           ag.name as group_name,
           array_remove(array_agg(u.github_username), null) as members
    from public.assignment_groups ag
    left join public.assignment_groups_members agm on agm.assignment_group_id = ag.id
    left join public.user_roles ur on ur.private_profile_id = agm.profile_id and ur.disabled = false
    left join public.users u on u.user_id = ur.user_id
    where ag.assignment_id = v_assignment_id
      and (
        p_force
        or not exists (
          select 1 from public.repositories r 
          where r.repository = v_org || '/' || v_slug || '-' || v_assignment_slug || '-group-' || ag.name
        )
      )
    group by ag.id, ag.name
    having array_length(array_remove(array_agg(u.github_username), null), 1) > 0
  loop
    raise notice 'Enqueue group repo: %/%', v_org, v_slug || '-' || v_assignment_slug || '-group-' || r_group_name;
    perform public.enqueue_github_create_repo(
      v_course_id,
      v_org,
      v_slug || '-' || v_assignment_slug || '-group-' || r_group_name,
      v_template_repo,
      v_slug,
      r_members,
      false,
      null,
      v_assignment_id,  -- Pass assignment_id
      null,             -- profile_id is null for group repos
      r_group_id,       -- Pass assignment_group_id
      v_latest_template_sha
    );
  end loop;
end;
$$;

-- Add unique constraint to prevent duplicate groups with same assignment_id and name
ALTER TABLE public.assignment_groups 
ADD CONSTRAINT unique_assignment_group_name 
UNIQUE (assignment_id, name);

-- Add unique constraint to prevent a student from being in multiple groups for the same assignment
ALTER TABLE public.assignment_groups_members
ADD CONSTRAINT unique_assignment_group_member
UNIQUE (assignment_id, profile_id);
