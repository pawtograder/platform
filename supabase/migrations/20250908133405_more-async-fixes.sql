-- Fix create_repos_for_student to only create repos for released assignments
DROP function if exists public.sync_student_github_team(class_id integer);
DROP function if exists public.sync_staff_github_team(class_id integer);

create or replace function public.create_repos_for_student(user_id uuid, class_id integer default null, p_force boolean default false)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_username text;
  v_slug text;
  v_org text;
  v_user_id uuid := user_id;
  v_class_id integer := class_id;
  r_assignment_id bigint;
  r_assignment_slug text;
  r_template_repo text;
  r_course_id bigint;
  r_course_slug text;
  r_github_org text;
  r_latest_template_sha text;
  r_profile_id uuid;
begin
  if user_id is null then
    raise warning 'create_repos_for_student called with NULL user_id, skipping';
    return;
  end if;

  select u.github_username into v_username from public.users u where u.user_id = v_user_id;
  if v_username is null or v_username = '' then
    raise exception 'User % has no GitHub username linked', user_id;
  end if;

  if p_force then
    -- If called manually (auth present), require instructor for the target class. If class_id is null, forbid for non-service callers.
    if auth.uid() is not null then
      if class_id is null then
        raise exception 'Force create for all classes requires service role';
      end if;
      if not public.authorizeforclassinstructor(class_id::bigint) then
        raise exception 'Access denied: Only instructors can force-create repos for class %', class_id;
      end if;
    end if;
    else 
      if auth.uid() is not null and auth.uid() <> v_user_id then
        raise exception 'Access denied: Only service role or target user can create repos for class %', class_id;
      end if;
  end if;

  for r_assignment_id, r_assignment_slug, r_template_repo, r_course_id, r_course_slug, r_github_org, r_latest_template_sha, r_profile_id in
    select a.id as assignment_id, a.slug as assignment_slug, a.template_repo, c.id as course_id, c.slug as course_slug, c.github_org, a.latest_template_sha, ur.private_profile_id
    from public.assignments a
    join public.classes c on c.id = a.class_id
    join public.user_roles ur on ur.class_id = c.id
    where ur.user_id = v_user_id
      and ur.private_profile_id is not null
      and (v_class_id is null or c.id = v_class_id)
      and a.template_repo is not null and a.template_repo <> ''
      and a.group_config <> 'groups'
      and a.release_date is not null and a.release_date <= now()  -- Only released assignments!
      and (
        p_force
        or not exists (
          select 1 from public.repositories r
          where r.assignment_id = a.id and r.profile_id = ur.private_profile_id
        )
      )
  loop
    perform public.enqueue_github_create_repo(
      r_course_id,
      r_github_org,
      r_course_slug || '-' || r_assignment_slug || '-' || v_username,
      r_template_repo,
      r_course_slug,
      array[v_username],
      false,
      null,
      r_assignment_id,  -- Pass assignment_id
      r_profile_id,     -- Pass profile_id
      null,             -- assignment_group_id is null for individual repos
      r_latest_template_sha
    );
  end loop;
end;
$$;
