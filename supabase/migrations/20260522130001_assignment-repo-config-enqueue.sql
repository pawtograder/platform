-- Extend enqueue_github_create_repo + the entry-point bulk-create functions to
-- carry the new per-assignment repo config (creation_method, source_repo,
-- branch_protection, student_team_permission) into pgmq messages, so the
-- async worker creates repos via fork vs template-generate per the
-- assignment's repo_mode and applies the desired branch ruleset.
--
-- The existing fn signatures are preserved so trigger-driven enqueue points
-- (assignment-group membership changes, user-role inserts, etc.) keep working
-- without modification — they enqueue with the historical defaults and the
-- worker treats those messages as template-generate w/ block_force_push=true,
-- which matches today's behavior.

-- 1) New 4-argument extension of the enqueuer.
drop function if exists public.enqueue_github_create_repo(
  bigint, text, text, text, text, text[], boolean, text, bigint, uuid, bigint, text,
  text, text, jsonb, text
);

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
  p_latest_template_sha text default null,
  p_creation_method text default 'template',           -- 'template' | 'fork'
  p_source_repo text default null,                     -- owner/repo to fork when method='fork'
  p_branch_protection jsonb default null,              -- {blockForcePush, requirePullRequest, requiredReviewers}
  p_student_team_permission text default null          -- 'pull' (mode 2 handout) | null
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
  v_args jsonb;
begin
  full_repo_name := p_org || '/' || p_repo_name;

  insert into public.api_gateway_calls(method, status_code, class_id, debug_id)
  values ('create_repo', 0, p_class_id, p_debug_id)
  returning id into log_id;

  if p_assignment_id is not null then
    select id into repo_id
    from public.repositories
    where assignment_id = p_assignment_id
      and (
        (p_profile_id is not null and profile_id = p_profile_id) or
        (p_assignment_group_id is not null and assignment_group_id = p_assignment_group_id)
      );

    if repo_id is null then
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
        false
      )
      returning id into repo_id;
    end if;
  end if;

  v_args := jsonb_build_object(
    'org', p_org,
    'repoName', p_repo_name,
    'templateRepo', p_template_repo,
    'isTemplateRepo', p_is_template_repo,
    'courseSlug', p_course_slug,
    'githubUsernames', p_github_usernames
  );
  if p_creation_method is not null and p_creation_method <> 'template' then
    v_args := v_args || jsonb_build_object('creationMethod', p_creation_method);
  end if;
  if p_source_repo is not null then
    v_args := v_args || jsonb_build_object('sourceRepo', p_source_repo);
  end if;
  if p_branch_protection is not null then
    v_args := v_args || jsonb_build_object('branchProtection', p_branch_protection);
  end if;
  if p_student_team_permission is not null then
    v_args := v_args || jsonb_build_object('studentTeamPermission', p_student_team_permission);
  end if;

  select pgmq_public.send(
    'async_calls',
    jsonb_build_object(
      'method', 'create_repo',
      'class_id', p_class_id,
      'debug_id', p_debug_id,
      'log_id', log_id,
      'repo_id', repo_id,
      'args', v_args
    )
  ) into message_id;

  return message_id;
end;
$$;

grant execute on function public.enqueue_github_create_repo(
  bigint, text, text, text, text, text[], boolean, text, bigint, uuid, bigint, text,
  text, text, jsonb, text
) to service_role;

-- 2) Rewrite create_all_repos_for_assignment to compute the strategy and pass
--    it through. For repo_mode='none' we early-return. For
--    fork_from_prior_assignment we resolve each student/group's source repo
--    against the source assignment's repositories.
create or replace function public.create_all_repos_for_assignment(
  course_id bigint, assignment_id bigint, p_force boolean default false
) returns void
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
  v_assignment_slug text;
  v_latest_template_sha text;
  v_repo_mode public.assignment_repo_mode;
  v_source_assignment_id bigint;
  v_branch_protection jsonb;
  v_creation_method text;
  v_default_source text;
  r_user_id uuid;
  r_username text;
  r_profile_id uuid;
  r_group_id bigint;
  r_group_name text;
  r_members text[];
  r_source_repo text;
begin
  if v_course_id is null or v_assignment_id is null then
    raise warning 'create_all_repos_for_assignment called with NULL parameters, skipping';
    return;
  end if;

  if auth.uid() is not null and not public.authorizeforclassinstructor(v_course_id::bigint) then
    raise exception 'Access denied: Only instructors can force-create repos for class %', v_course_id;
  end if;

  select c.slug, c.github_org, a.template_repo, a.slug, a.latest_template_sha,
         a.repo_mode, a.source_assignment_id,
         jsonb_build_object(
           'blockForcePush', coalesce(a.protect_block_force_push, true),
           'requirePullRequest', coalesce(a.protect_require_pull_request, false),
           'requiredReviewers', coalesce(a.protect_required_reviewers, 0)
         )
    into v_slug, v_org, v_template_repo, v_assignment_slug, v_latest_template_sha,
         v_repo_mode, v_source_assignment_id, v_branch_protection
    from public.assignments a
    join public.classes c on c.id = a.class_id
   where a.id = v_assignment_id and a.class_id = v_course_id;

  if v_slug is null or v_org is null then
    raise exception 'Invalid class/assignment (class_id %, assignment_id %)', course_id, assignment_id;
  end if;

  if v_repo_mode = 'none' then
    raise notice 'Assignment % has repo_mode=none; nothing to enqueue', v_assignment_id;
    return;
  end if;

  if v_repo_mode in ('template_only_staff', 'template_with_student_forks')
     and (v_template_repo is null or v_template_repo = '')
  then
    raise exception 'Assignment % is missing template_repo for mode %', v_assignment_id, v_repo_mode;
  end if;

  v_creation_method := case
    when v_repo_mode = 'template_only_staff' then 'template'
    else 'fork'
  end;
  v_default_source := v_template_repo;  -- mode 1 and mode 2 fork/generate from the handout

  -- Enqueue individual repos for students not in groups.
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
    if v_repo_mode = 'fork_from_prior_assignment' then
      select r.repository into r_source_repo
        from public.repositories r
       where r.assignment_id = v_source_assignment_id
         and r.profile_id = r_profile_id
       limit 1;
      if r_source_repo is null then
        raise warning 'No source repository for profile % on assignment %; skipping', r_profile_id, v_source_assignment_id;
        continue;
      end if;
    else
      r_source_repo := v_default_source;
    end if;

    perform public.enqueue_github_create_repo(
      v_course_id,
      v_org,
      v_slug || '-' || v_assignment_slug || '-' || r_username,
      coalesce(v_template_repo, r_source_repo),
      v_slug,
      array[r_username],
      false,
      null,
      v_assignment_id,
      r_profile_id,
      null,
      v_latest_template_sha,
      v_creation_method,
      r_source_repo,
      v_branch_protection,
      null
    );
  end loop;

  -- Enqueue group repos.
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
    if v_repo_mode = 'fork_from_prior_assignment' then
      -- Match by group name on the source assignment.
      select r.repository into r_source_repo
        from public.repositories r
        join public.assignment_groups ag on ag.id = r.assignment_group_id
       where r.assignment_id = v_source_assignment_id
         and ag.name = r_group_name
       limit 1;
      if r_source_repo is null then
        raise warning 'No source repository for group % on assignment %; skipping', r_group_name, v_source_assignment_id;
        continue;
      end if;
    else
      r_source_repo := v_default_source;
    end if;

    perform public.enqueue_github_create_repo(
      v_course_id,
      v_org,
      v_slug || '-' || v_assignment_slug || '-group-' || r_group_name,
      coalesce(v_template_repo, r_source_repo),
      v_slug,
      r_members,
      false,
      null,
      v_assignment_id,
      null,
      r_group_id,
      v_latest_template_sha,
      v_creation_method,
      r_source_repo,
      v_branch_protection,
      null
    );
  end loop;
end;
$$;

-- 3) Rewrite create_repos_for_student similarly. This is the lazy on-login path
--    used by autograder-create-repos-for-student.
create or replace function public.create_repos_for_student(
  user_id uuid, class_id integer default null, p_force boolean default false
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_username text;
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
  r_repo_mode public.assignment_repo_mode;
  r_source_assignment_id bigint;
  r_branch_protection jsonb;
  r_creation_method text;
  r_source_repo text;
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
    if auth.uid() is not null then
      if class_id is null then
        raise exception 'Force create for all classes requires service role';
      end if;
      if not public.authorizeforclassinstructor(class_id::bigint) then
        raise exception 'Access denied: Only instructors can force-create repos for class %', class_id;
      end if;
    end if;
  end if;

  for r_assignment_id, r_assignment_slug, r_template_repo, r_course_id, r_course_slug, r_github_org,
      r_latest_template_sha, r_profile_id, r_repo_mode, r_source_assignment_id, r_branch_protection in
    select a.id, a.slug, a.template_repo, c.id, c.slug, c.github_org, a.latest_template_sha,
           ur.private_profile_id, a.repo_mode, a.source_assignment_id,
           jsonb_build_object(
             'blockForcePush', coalesce(a.protect_block_force_push, true),
             'requirePullRequest', coalesce(a.protect_require_pull_request, false),
             'requiredReviewers', coalesce(a.protect_required_reviewers, 0)
           )
    from public.assignments a
    join public.classes c on c.id = a.class_id
    join public.user_roles ur on ur.class_id = c.id
    where ur.user_id = v_user_id
      and (v_class_id is null or c.id = v_class_id)
      and a.repo_mode <> 'none'
      and a.group_config <> 'groups'
      and (
        a.repo_mode = 'fork_from_prior_assignment'
        or (a.template_repo is not null and a.template_repo <> '')
      )
      and (
        p_force
        or not exists (
          select 1 from public.repositories r
          where r.assignment_id = a.id and r.profile_id = ur.private_profile_id
        )
      )
  loop
    if r_repo_mode = 'fork_from_prior_assignment' then
      select r.repository into r_source_repo
        from public.repositories r
       where r.assignment_id = r_source_assignment_id
         and r.profile_id = r_profile_id
       limit 1;
      if r_source_repo is null then
        raise warning 'No source repository for profile % on assignment %; skipping', r_profile_id, r_source_assignment_id;
        continue;
      end if;
      r_creation_method := 'fork';
    elsif r_repo_mode = 'template_with_student_forks' then
      r_source_repo := r_template_repo;
      r_creation_method := 'fork';
    else
      r_source_repo := r_template_repo;
      r_creation_method := 'template';
    end if;

    perform public.enqueue_github_create_repo(
      r_course_id,
      r_github_org,
      r_course_slug || '-' || r_assignment_slug || '-' || v_username,
      coalesce(r_template_repo, r_source_repo),
      r_course_slug,
      array[v_username],
      false,
      null,
      r_assignment_id,
      r_profile_id,
      null,
      r_latest_template_sha,
      r_creation_method,
      r_source_repo,
      r_branch_protection,
      null
    );
  end loop;
end;
$$;
