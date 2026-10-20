-- CW-10 foundation. Provider selection is opt-in and fixed after provisioning.
-- The UI picker and GitHub banner gating follow in a separate PR.
ALTER TABLE public.assignments
  ADD COLUMN git_provider text NOT NULL DEFAULT 'github';
ALTER TABLE public.assignments ADD CONSTRAINT assignments_git_provider_check
  CHECK (git_provider IN ('github', 'forgejo')) NOT VALID;
ALTER TABLE public.repositories
  ADD COLUMN git_provider text NOT NULL DEFAULT 'github';
ALTER TABLE public.repositories ADD CONSTRAINT repositories_git_provider_check
  CHECK (git_provider IN ('github', 'forgejo')) NOT VALID;
ALTER TABLE public.classes ADD COLUMN forgejo_org text;

COMMENT ON COLUMN public.assignments.git_provider IS
  'Repository host for this assignment. Cannot change once any repository exists.';
COMMENT ON COLUMN public.repositories.git_provider IS
  'Repository host, required to match the assignment provider.';
COMMENT ON COLUMN public.classes.forgejo_org IS
  'Forgejo organization for this class.';

CREATE OR REPLACE FUNCTION public.assignments_validate_git_provider() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_enabled boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- delete_assignment_with_all_data deletes repository rows before enqueueing GitHub cleanup.
    -- Once those rows are gone, an enqueue guard cannot recover their provider.
    IF OLD.git_provider = 'forgejo' THEN
      RAISE EXCEPTION 'Deleting Forgejo assignments or their course is not supported yet. If no repositories exist, switch the assignment to GitHub before deleting. Otherwise, wait for provider-aware cleanup.'
        USING ERRCODE = 'feature_not_supported';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.git_provider = OLD.git_provider AND NEW.class_id = OLD.class_id THEN
      RETURN NEW;
    END IF;
    IF NEW.git_provider IS DISTINCT FROM OLD.git_provider
       AND EXISTS (SELECT 1 FROM public.repositories WHERE assignment_id = OLD.id) THEN
      RAISE EXCEPTION 'Cannot change repository host after repositories exist'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.git_provider = 'forgejo' THEN
    -- Same first-entry, boolean-only semantics as courseFeatureEnabled. Missing/malformed is off.
    SELECT f -> 'enabled' = 'true'::jsonb INTO v_enabled
      FROM public.classes c,
           LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(c.features) = 'array' THEN c.features ELSE '[]'::jsonb END
           ) f
      WHERE c.id = NEW.class_id AND f ->> 'name' = 'cloud-workspaces'
      LIMIT 1;
    IF NOT coalesce(v_enabled, false) THEN
      RAISE EXCEPTION 'Enable cloud-workspaces for this course before selecting Forgejo'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER assignments_validate_git_provider
  BEFORE INSERT OR UPDATE OF git_provider, class_id ON public.assignments
  FOR EACH ROW EXECUTE FUNCTION public.assignments_validate_git_provider();
CREATE TRIGGER assignments_guard_forgejo_delete
  BEFORE DELETE ON public.assignments
  FOR EACH ROW EXECUTE FUNCTION public.assignments_validate_git_provider();

CREATE FUNCTION public.repositories_validate_git_provider() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_provider text;
BEGIN
  -- Block provider changes without blocking concurrent repo inserts or submission FK checks.
  SELECT git_provider INTO v_provider FROM public.assignments
    WHERE id = NEW.assignment_id FOR SHARE;
  IF FOUND AND NEW.git_provider IS DISTINCT FROM v_provider THEN
    RAISE EXCEPTION 'Repository host must match its assignment'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER repositories_validate_git_provider
  BEFORE INSERT OR UPDATE OF git_provider, assignment_id ON public.repositories
  FOR EACH ROW EXECUTE FUNCTION public.repositories_validate_git_provider();

REVOKE ALL ON FUNCTION public.assignments_validate_git_provider() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.repositories_validate_git_provider() FROM PUBLIC, anon, authenticated;

-- Keep the existing function identities and grants. The GitHub bodies below are unchanged
-- except for provider guards. No separately callable, unguarded RPCs are introduced.
-- Each Source migration retains the original implementation rationale and history.

-- Source: 20260816120000_bound_repo_creation_retries.sql
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
  v_repo_name text;
  v_existing_name text;
  v_args jsonb;
begin
  -- Take the same parent lock as repository insertion before checking the chosen host.
  perform 1 from public.assignments where id = p_assignment_id for share;
  if exists (select 1 from public.assignments where id = p_assignment_id and git_provider <> 'github')
     or exists (select 1 from public.repositories
                where class_id = p_class_id and repository = p_org || '/' || p_repo_name
                  and git_provider <> 'github') then
    return null;
  end if;
  v_repo_name := p_repo_name;
  full_repo_name := p_org || '/' || v_repo_name;

  insert into public.api_gateway_calls(method, status_code, class_id, debug_id)
  values ('create_repo', 0, p_class_id, p_debug_id)
  returning id into log_id;

  if p_assignment_id is not null then
    select id, repository into repo_id, v_existing_name
    from public.repositories
    where assignment_id = p_assignment_id
      and (
        (p_profile_id is not null and profile_id = p_profile_id) or
        (p_assignment_group_id is not null and assignment_group_id = p_assignment_group_id)
      )
    order by (repository = p_org || '/' || p_repo_name) desc, id
    limit 1;

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
      on conflict do nothing
      returning id into repo_id;

      if repo_id is null then
        select id, repository into repo_id, v_existing_name
        from public.repositories
        where repository = full_repo_name
          and assignment_id = p_assignment_id
          and (
            (p_profile_id is not null and profile_id = p_profile_id) or
            (p_assignment_group_id is not null and assignment_group_id = p_assignment_group_id)
          );
        if repo_id is null then
          raise exception 'Repository name % is already used by a different assignment, student or group', full_repo_name;
        end if;
        v_repo_name := substring(v_existing_name from position('/' in v_existing_name) + 1);
      end if;
    else
      v_repo_name := substring(v_existing_name from position('/' in v_existing_name) + 1);
    end if;
  end if;

  if repo_id is not null then
    update public.repositories
       set last_creation_attempt_at = now()
     where id = repo_id;
  end if;

  v_args := jsonb_build_object(
    'org', p_org,
    'repoName', v_repo_name,
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

-- Source: 20250904234806_async-github-worker.sql
create or replace function public.enqueue_github_sync_repo_permissions(
  p_class_id bigint,
  p_org text,
  p_repo text,
  p_course_slug text,
  p_github_usernames text[],
  p_debug_id text default null
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  log_id bigint;
  message_id bigint;
begin
  -- GitHubWrapper treats a supplied owner/name as authoritative, regardless of p_org.
  if exists (select 1 from public.repositories
              where class_id = p_class_id
                and repository = case when strpos(p_repo, '/') > 0 then p_repo else p_org || '/' || p_repo end
                and git_provider <> 'github') then
    return null;
  end if;
  insert into public.api_gateway_calls(method, status_code, class_id, debug_id)
  values ('sync_repo_permissions', 0, p_class_id, p_debug_id)
  returning id into log_id;

  select pgmq_public.send(
    'async_calls',
    jsonb_build_object(
      'method', 'sync_repo_permissions',
      'class_id', p_class_id,
      'debug_id', p_debug_id,
      'log_id', log_id,
      'args', jsonb_build_object(
        'org', p_org,
        'repo', p_repo,
        'courseSlug', p_course_slug,
        'githubUsernames', p_github_usernames
      )
    )
  ) into message_id;

  return message_id;
end;
$$;

-- Source: 20250904234806_async-github-worker.sql
create or replace function public.enqueue_github_archive_repo(
  p_class_id bigint,
  p_org text,
  p_repo text,
  p_debug_id text default null
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  log_id bigint;
  message_id bigint;
begin
  -- Match the same owner/name that archiveRepoAndLock will use.
  if exists (select 1 from public.repositories
              where class_id = p_class_id
                and repository = case when strpos(p_repo, '/') > 0 then p_repo else p_org || '/' || p_repo end
                and git_provider <> 'github') then
    return null;
  end if;
  insert into public.api_gateway_calls(method, status_code, class_id, debug_id)
  values ('archive_repo_and_lock', 0, p_class_id, p_debug_id)
  returning id into log_id;

  select pgmq_public.send(
    'async_calls',
    jsonb_build_object(
      'method', 'archive_repo_and_lock',
      'class_id', p_class_id,
      'debug_id', p_debug_id,
      'log_id', log_id,
      'args', jsonb_build_object(
        'org', p_org,
        'repo', p_repo
      )
    )
  ) into message_id;

  return message_id;
end;
$$;

-- Source: 20260816120000_bound_repo_creation_retries.sql
create or replace function public.enqueue_create_repo_for_repository(p_repository_id bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_creation_method text;
  v_source_repo text;
  v_usernames text[];
  v_repo_name text;
  v_msg_id bigint;
begin
  select rp.git_provider, rp.id, rp.class_id, rp.assignment_id, rp.profile_id, rp.assignment_group_id, rp.repository,
         a.repo_mode, a.template_repo, a.source_assignment_id, a.latest_template_sha,
         a.slug as assignment_slug,
         c.slug as course_slug, c.github_org,
         jsonb_build_object(
           'blockForcePush', coalesce(a.protect_block_force_push, true),
           'requirePullRequest', coalesce(a.protect_require_pull_request, false),
           'requiredReviewers', coalesce(a.protect_required_reviewers, 0)
         ) as branch_protection
    into r
    from public.repositories rp
    join public.assignments a on a.id = rp.assignment_id
    join public.classes c on c.id = rp.class_id
   where rp.id = p_repository_id;

  if not found then
    raise exception 'Repository % not found', p_repository_id;
  end if;

  if r.git_provider <> 'github' then
    return null;
  end if;

  if r.repo_mode in ('none', 'no_submission') then
    raise notice 'Repository % assignment repo_mode=%; nothing to enqueue', p_repository_id, r.repo_mode;
    return null;
  end if;

  v_creation_method := case when r.repo_mode = 'template_only_staff' then 'template' else 'fork' end;
  -- Keep everything after the first slash. Legacy stored repo names may contain more slashes.
  -- See section 5 of 20260816120000_bound_repo_creation_retries.sql.
  v_repo_name := substring(r.repository from position('/' in r.repository) + 1);

  if r.assignment_group_id is not null then
    select array_remove(array_agg(u.github_username), null)
      into v_usernames
      from public.assignment_groups_members agm
      join public.user_roles ur on ur.private_profile_id = agm.profile_id and ur.disabled = false
      join public.users u on u.user_id = ur.user_id
     where agm.assignment_group_id = r.assignment_group_id;

    if r.repo_mode = 'fork_from_prior_assignment' then
      select pr.repository
        into v_source_repo
        from public.repositories pr
        join public.assignment_groups ag on ag.id = pr.assignment_group_id
        join public.assignment_groups cur on cur.id = r.assignment_group_id
       where pr.assignment_id = r.source_assignment_id
         and ag.name = cur.name
       limit 1;
    else
      v_source_repo := r.template_repo;
    end if;
  else
    select array[u.github_username]
      into v_usernames
      from public.user_roles ur
      join public.users u on u.user_id = ur.user_id
     where ur.private_profile_id = r.profile_id
       and ur.disabled = false
       and u.github_username is not null
     limit 1;

    if r.repo_mode = 'fork_from_prior_assignment' then
      select pr.repository
        into v_source_repo
        from public.repositories pr
       where pr.assignment_id = r.source_assignment_id
         and pr.profile_id = r.profile_id
       limit 1;
    else
      v_source_repo := r.template_repo;
    end if;
  end if;

  if v_usernames is null then
    v_usernames := array[]::text[];
  end if;

  if r.repo_mode = 'fork_from_prior_assignment' and v_source_repo is null then
    update public.repositories
       set creation_error = format(
             'No repository found on the source assignment (id %s) to fork from. Create the source repositories first, then use Retry.',
             r.source_assignment_id),
           last_creation_attempt_at = now(),
           updated_at = now()
     where id = p_repository_id;
    raise warning 'No source repository resolved for repository % (fork_from_prior_assignment); parked for instructor retry', p_repository_id;
    return null;
  end if;

  select public.enqueue_github_create_repo(
    r.class_id,
    r.github_org,
    v_repo_name,
    coalesce(r.template_repo, v_source_repo),
    r.course_slug,
    v_usernames,
    false, -- p_is_template_repo
    'reconcile-repo-' || p_repository_id || '-' || extract(epoch from now())::bigint, -- p_debug_id
    r.assignment_id,
    r.profile_id,
    r.assignment_group_id,
    r.latest_template_sha,
    v_creation_method,
    v_source_repo,
    r.branch_protection,
    null -- p_student_team_permission
  ) into v_msg_id;

  update public.repositories
     set updated_at = now(),
         creation_attempts = creation_attempts + 1,
         last_creation_attempt_at = now()
   where id = p_repository_id;

  return v_msg_id;
end;
$$;

-- Source: 20260910010000_park_dead_lettered_repo_creations.sql
create or replace function public.reconcile_stuck_repo_creations(p_stale_minutes integer default 15)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_count integer := 0;
  v_max_attempts constant integer := 8;
  v_max_backoff_doublings constant integer := 5;  -- caps the interval at 32x p_stale_minutes
  v_inflight_repo_ids text[];
begin
  v_inflight_repo_ids := public.repo_ids_with_queued_create();

  update public.repositories rp
     set creation_error = format(
           'Repository creation did not succeed after %s automatic attempts. Check the assignment template repository and GitHub org configuration, then use Retry.',
           v_max_attempts)
    from public.assignments a
   where a.id = rp.assignment_id
     and rp.is_github_ready = false
     and rp.git_provider = 'github'
     and rp.creation_error is null
     and rp.creation_attempts >= v_max_attempts
     and rp.id::text <> all (v_inflight_repo_ids)
     and rp.updated_at < now() - make_interval(
           mins => p_stale_minutes * (2 ^ least(rp.creation_attempts, v_max_backoff_doublings))::int
         )
     and a.repo_mode not in ('none', 'no_submission');

  update public.repositories rp
     set creation_error = 'Repository creation failed and the job was dead-lettered, so automatic retries have stopped. Check the assignment template repository and GitHub org configuration (a private template needs org permission to be forked), then use Retry.'
    from public.assignments a
   where a.id = rp.assignment_id
     and rp.is_github_ready = false
     and rp.git_provider = 'github'
     and rp.creation_error is null
     and rp.last_creation_attempt_at is not null
     and rp.id::text <> all (v_inflight_repo_ids)
     and a.repo_mode not in ('none', 'no_submission')
     and exists (
           select 1
             from public.repo_ids_with_dead_lettered_create() d
            where d.repo_id = rp.id::text
              and d.dead_lettered_at >= rp.last_creation_attempt_at
         );

  for r in
    select rp.id
      from public.repositories rp
      join public.assignments a on a.id = rp.assignment_id
      join public.classes c on c.id = rp.class_id
     where rp.is_github_ready = false
       and rp.git_provider = 'github'
       and rp.creation_error is null
       and rp.creation_attempts < v_max_attempts
       and a.repo_mode not in ('none', 'no_submission')
       and (
         public.is_class_active(c.archived, c.end_date)
         or rp.last_creation_attempt_at > now() - interval '7 days'
       )
       and rp.id::text <> all (v_inflight_repo_ids)
       and rp.updated_at < now() - make_interval(
             mins => p_stale_minutes * (2 ^ least(rp.creation_attempts, v_max_backoff_doublings))::int
           )
  loop
    begin
      perform public.enqueue_create_repo_for_repository(r.id);
      v_count := v_count + 1;
    exception
      when others then
        raise warning 'reconcile: failed to enqueue repository %: %', r.id, sqlerrm;
    end;
  end loop;
  return v_count;
end;
$$;
