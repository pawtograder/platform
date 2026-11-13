-- CW-13 (#1093, merged scope of #1096): a repository name is unique per provider, not globally.
-- `org/repo` can exist on GitHub and on Forgejo, so the unique index becomes (git_provider, repository),
-- and every lookup by name also filters by provider (the edge functions, in the same change).
--
-- Down path: drop the new constraint and re-add unique_repo_name. That fails if a name already exists
-- on both providers; rename one of the two rows first.

ALTER TABLE public.repositories DROP CONSTRAINT unique_repo_name;
ALTER TABLE public.repositories
  ADD CONSTRAINT repositories_git_provider_repository_key UNIQUE (git_provider, repository);

-- The three GitHub enqueues skipped any name that had a non-GitHub row. Under the new index that would
-- also skip a GitHub repo sharing a Forgejo repo's name. Bodies are from
-- 20261020150000_assignment_git_provider.sql; only the provider guards change.

create or replace function public.enqueue_github_create_repo( p_class_id bigint, p_org text, p_repo_name text,
  p_template_repo text, p_course_slug text, p_github_usernames text[],
  p_is_template_repo boolean default false, p_debug_id text default null, p_assignment_id bigint default null,
  p_profile_id uuid default null, p_assignment_group_id bigint default null, p_latest_template_sha text default null,
  p_creation_method text default 'template',           -- 'template' | 'fork'
  p_source_repo text default null,                     -- owner/repo to fork when method='fork'
  p_branch_protection jsonb default null,              -- {blockForcePush, requirePullRequest, requiredReviewers}
  p_student_team_permission text default null          -- 'pull' (mode 2 handout) | null
) returns bigint language plpgsql security definer set search_path = public as $$
declare
  log_id bigint; message_id bigint; repo_id bigint; full_repo_name text; v_repo_name text;
  v_existing_name text; v_args jsonb;
begin
  -- Take the same parent lock as repository insertion before checking the chosen host.
  perform 1 from public.assignments where id = p_assignment_id for share;
  if exists (select 1 from public.assignments where id = p_assignment_id and git_provider <> 'github')
     -- With an assignment, its provider is authoritative: a Forgejo repo with the same name is a different repo.
     or (p_assignment_id is null and exists (select 1 from public.repositories where class_id = p_class_id
                  and repository = p_org || '/' || p_repo_name and git_provider <> 'github')) then
    return null;
  end if;
  v_repo_name := p_repo_name;
  full_repo_name := p_org || '/' || v_repo_name;
  insert into public.api_gateway_calls(method, status_code, class_id, debug_id) values ('create_repo', 0, p_class_id, p_debug_id)
  returning id into log_id;
  if p_assignment_id is not null then
    select id, repository into repo_id, v_existing_name from public.repositories where assignment_id = p_assignment_id and (
        (p_profile_id is not null and profile_id = p_profile_id) or
        (p_assignment_group_id is not null and assignment_group_id = p_assignment_group_id) )
    order by (repository = p_org || '/' || p_repo_name) desc, id limit 1;
    if repo_id is null then
      insert into public.repositories( profile_id, assignment_group_id, assignment_id, repository,
        class_id, synced_handout_sha, is_github_ready ) values ( p_profile_id, p_assignment_group_id, p_assignment_id, full_repo_name,
        p_class_id, p_latest_template_sha, false ) on conflict do nothing returning id into repo_id;
      if repo_id is null then
        select id, repository into repo_id, v_existing_name from public.repositories where repository = full_repo_name
          and assignment_id = p_assignment_id and ( (p_profile_id is not null and profile_id = p_profile_id) or
            (p_assignment_group_id is not null and assignment_group_id = p_assignment_group_id) );
        if repo_id is null then raise exception 'Repository name % is already used by a different assignment, student or group', full_repo_name; end if;
        v_repo_name := substring(v_existing_name from position('/' in v_existing_name) + 1);
      end if;
    else
      v_repo_name := substring(v_existing_name from position('/' in v_existing_name) + 1);
    end if;
  end if;
  if repo_id is not null then update public.repositories set last_creation_attempt_at = now() where id = repo_id; end if;
  v_args := jsonb_build_object( 'org', p_org, 'repoName', v_repo_name,
    'templateRepo', p_template_repo, 'isTemplateRepo', p_is_template_repo,
    'courseSlug', p_course_slug, 'githubUsernames', p_github_usernames );
  if p_creation_method is not null and p_creation_method <> 'template' then v_args := v_args || jsonb_build_object('creationMethod', p_creation_method); end if;
  if p_source_repo is not null then v_args := v_args || jsonb_build_object('sourceRepo', p_source_repo); end if;
  if p_branch_protection is not null then v_args := v_args || jsonb_build_object('branchProtection', p_branch_protection); end if;
  if p_student_team_permission is not null then v_args := v_args || jsonb_build_object('studentTeamPermission', p_student_team_permission); end if;
  select pgmq_public.send('async_calls', jsonb_build_object( 'method', 'create_repo', 'class_id', p_class_id,
      'debug_id', p_debug_id, 'log_id', log_id, 'repo_id', repo_id, 'args', v_args )) into message_id;
  return message_id;
end;
$$;

create or replace function public.enqueue_github_sync_repo_permissions( p_class_id bigint, p_org text, p_repo text,
  p_course_slug text, p_github_usernames text[], p_debug_id text default null
) returns bigint language plpgsql security definer set search_path = public as $$
declare
  log_id bigint; message_id bigint;
  v_full_name text := case when strpos(p_repo, '/') > 0 then p_repo else p_org || '/' || p_repo end;
begin
  -- GitHubWrapper treats a supplied owner/name as authoritative, regardless of p_org.
  -- Skip only a name that is on another host and not on GitHub: a name is unique per provider.
  -- Group publish and copy pass the class's GitHub org with the name after the row's owner, so a
  -- Forgejo row under its own owner is matched by that name too.
  if exists (select 1 from public.repositories where class_id = p_class_id and git_provider <> 'github'
                and (repository = v_full_name or substring(repository from position('/' in repository) + 1) = p_repo))
     and not exists (select 1 from public.repositories where class_id = p_class_id and repository = v_full_name
                and git_provider = 'github') then
    return null;
  end if;
  insert into public.api_gateway_calls(method, status_code, class_id, debug_id) values ('sync_repo_permissions', 0, p_class_id, p_debug_id)
  returning id into log_id;
  select pgmq_public.send('async_calls', jsonb_build_object( 'method', 'sync_repo_permissions', 'class_id', p_class_id,
      'debug_id', p_debug_id, 'log_id', log_id, 'args', jsonb_build_object( 'org', p_org, 'repo', p_repo,
        'courseSlug', p_course_slug, 'githubUsernames', p_github_usernames ) )) into message_id;
  return message_id;
end;
$$;

create or replace function public.enqueue_github_archive_repo( p_class_id bigint, p_org text, p_repo text, p_debug_id text default null
) returns bigint language plpgsql security definer set search_path = public as $$
declare
  log_id bigint; message_id bigint;
  v_full_name text := case when strpos(p_repo, '/') > 0 then p_repo else p_org || '/' || p_repo end;
begin
  -- Match the same owner/name that archiveRepoAndLock will use.
  -- Skip only a name that is on another host and not on GitHub: a name is unique per provider.
  -- Group publish and copy pass the class's GitHub org with the name after the row's owner, so a
  -- Forgejo row under its own owner is matched by that name too.
  if exists (select 1 from public.repositories where class_id = p_class_id and git_provider <> 'github'
                and (repository = v_full_name or substring(repository from position('/' in repository) + 1) = p_repo))
     and not exists (select 1 from public.repositories where class_id = p_class_id and repository = v_full_name
                and git_provider = 'github') then
    return null;
  end if;
  insert into public.api_gateway_calls(method, status_code, class_id, debug_id) values ('archive_repo_and_lock', 0, p_class_id, p_debug_id)
  returning id into log_id;
  select pgmq_public.send('async_calls', jsonb_build_object( 'method', 'archive_repo_and_lock', 'class_id', p_class_id,
      'debug_id', p_debug_id, 'log_id', log_id, 'args', jsonb_build_object('org', p_org, 'repo', p_repo) )) into message_id;
  return message_id;
end;
$$;
