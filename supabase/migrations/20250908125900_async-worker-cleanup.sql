-- Fix repository creation logic for async GitHub worker
-- Main issue: before enqueuing a create repo message, we need to create the repositories row!

-- 1) Update enqueue_github_create_repo to create repository record first
-- Drop existing function to avoid signature conflicts
drop function if exists public.enqueue_github_create_repo(bigint, text, text, text, text, text[], boolean, text, bigint, uuid, bigint, text);

create or replace function public.enqueue_github_create_repo(
  p_class_id bigint,
  p_org text,
  p_repo_name text,
  p_template_repo text,
  p_course_slug text,
  p_github_usernames text[],
  p_is_template_repo boolean default false,
  p_debug_id text default null,
  p_assignment_id bigint default null,
  p_profile_id uuid default null,
  p_assignment_group_id bigint default null,
  p_latest_template_sha text default null
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  log_id bigint;
  message_id bigint;
  repo_id bigint;
  full_repo_name text;
begin
  -- Construct full repository name
  full_repo_name := p_org || '/' || p_repo_name;
  
  -- Insert log record first
  insert into public.api_gateway_calls(method, status_code, class_id, debug_id)
  values ('create_repo', 0, p_class_id, p_debug_id)
  returning id into log_id;
  
  -- Create repository record first (like the old logic did)
  -- Only create if assignment_id is provided and repository doesn't already exist
  if p_assignment_id is not null then
    -- Check if repository already exists
    select id into repo_id 
    from public.repositories 
    where assignment_id = p_assignment_id 
      and (
        (p_profile_id is not null and profile_id = p_profile_id) or
        (p_assignment_group_id is not null and assignment_group_id = p_assignment_group_id)
      );
    
    if repo_id is null then
      -- Create new repository record
      insert into public.repositories(
        profile_id,
        assignment_group_id,
        assignment_id,
        repository,
        class_id,
        synced_handout_sha,
        is_github_ready
      )
      values (
        p_profile_id,
        p_assignment_group_id,
        p_assignment_id,
        full_repo_name,
        p_class_id,
        p_latest_template_sha,
        false  -- Will be set to true by async worker after GitHub repo is created
      )
      returning id into repo_id;
    end if;
  end if;
  
  -- Enqueue message with log_id and repo_id
  select pgmq_public.send(
    'async_calls',
    jsonb_build_object(
      'method', 'create_repo',
      'class_id', p_class_id,
      'debug_id', p_debug_id,
      'log_id', log_id,
      'repo_id', repo_id,  -- Add repo_id to the message
      'args', jsonb_build_object(
        'org', p_org,
        'repoName', p_repo_name,
        'templateRepo', p_template_repo,
        'isTemplateRepo', p_is_template_repo,
        'courseSlug', p_course_slug,
        'githubUsernames', p_github_usernames
      )
    )
  ) into message_id;
  
  return message_id;
end;
$$;

-- Drop the old function signature and recreate with proper permissions
revoke all on function public.enqueue_github_create_repo(bigint, text, text, text, text, text[], boolean, text) from public;
grant execute on function public.enqueue_github_create_repo(bigint, text, text, text, text, text[], boolean, text, bigint, uuid, bigint, text) to service_role;

-- 2) Update create_all_repos_for_assignment to pass assignment details to enqueue function
create or replace function public.create_all_repos_for_assignment(course_id bigint, assignment_id bigint, p_force boolean default false)
returns void
language plpgsql
security definer
set search_path = public
as $$
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
          where r.assignment_id = v_assignment_id and r.profile_id = ur.private_profile_id
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
    select ag.id as group_id,
           ag.name as group_name,
           array_remove(array_agg(u.github_username), null) as members
    from public.assignment_groups ag
    left join public.assignment_groups_members agm on agm.assignment_group_id = ag.id
    left join public.user_roles ur on ur.private_profile_id = agm.profile_id
    left join public.users u on u.user_id = ur.user_id
    where ag.assignment_id = v_assignment_id
      and (
        p_force
        or not exists (
          select 1 from public.repositories r where r.assignment_group_id = ag.id
        )
      )
    group by ag.id, ag.name
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

-- 3) Update create_repos_for_student to pass assignment details to enqueue function
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
  end if;

  for r_assignment_id, r_assignment_slug, r_template_repo, r_course_id, r_course_slug, r_github_org, r_latest_template_sha, r_profile_id in
    select a.id as assignment_id, a.slug as assignment_slug, a.template_repo, c.id as course_id, c.slug as course_slug, c.github_org, a.latest_template_sha, ur.private_profile_id
    from public.assignments a
    join public.classes c on c.id = a.class_id
    join public.user_roles ur on ur.class_id = c.id
    where ur.user_id = v_user_id
      and (v_class_id is null or c.id = v_class_id)
      and a.template_repo is not null and a.template_repo <> ''
      and a.group_config <> 'groups'
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

-- 4) Update GitHubAsyncEnvelope type to include repo_id (this is handled in the TypeScript types)
-- The async worker will update the repository record directly using the Supabase client
