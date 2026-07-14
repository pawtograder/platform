-- Self-healing for stuck/blank student repos.
--
-- Adds:
--   * enqueue_create_repo_for_repository(repo_id) — re-enqueue a create_repo job for an EXISTING
--     repository row, re-deriving creation_method/source/usernames from the assignment's repo_mode
--     (single source of truth shared by the retry button and the reconciler).
--   * retry_repository_creation(repo_id) — instructor-facing: clears creation_error and re-enqueues.
--   * reconcile_stuck_repo_creations(stale_minutes) — service-role: re-enqueues transient stuck
--     repos (is_github_ready=false AND creation_error IS NULL AND stale). Repos with creation_error
--     set are terminal (await an instructor retry) and are left alone.
--   * invoke_github_repo_reconciler_background_task() + a pg_cron schedule that invokes the
--     github-repo-reconciler edge function every 15 minutes (the edge function also emits the
--     >12h Sentry alerts, which plpgsql cannot do).

-- ---------------------------------------------------------------------------
-- Per-repository re-enqueue with repo_mode-aware derivation.
-- ---------------------------------------------------------------------------
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
  select rp.id, rp.class_id, rp.assignment_id, rp.profile_id, rp.assignment_group_id, rp.repository,
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

  if r.repo_mode in ('none', 'no_submission') then
    raise notice 'Repository % assignment repo_mode=%; nothing to enqueue', p_repository_id, r.repo_mode;
    return null;
  end if;

  v_creation_method := case when r.repo_mode = 'template_only_staff' then 'template' else 'fork' end;
  v_repo_name := split_part(r.repository, '/', 2);

  if r.assignment_group_id is not null then
    -- Group repo: collect member usernames; resolve the prior-assignment source by group name.
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
    -- Individual repo: single owner username; resolve prior-assignment source by profile.
    -- Filter out disabled (dropped) roles, matching the group path above and create_all_repos_for_assignment,
    -- so a dropped student is not re-granted repo access on reconcile/retry.
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
    raise warning 'No source repository resolved for repository % (fork_from_prior_assignment); skipping', p_repository_id;
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

  -- Bump updated_at so the reconciler's stale window (is_github_ready=false AND updated_at < now - N)
  -- does not re-enqueue a DUPLICATE create_repo job for this repo while this one is still in
  -- flight/backoff. Transient createRepo retries never otherwise touch the row, so without this a
  -- second job can race the first (e.g. delete+regenerate a repo the other job is finalizing).
  update public.repositories set updated_at = now() where id = p_repository_id;

  return v_msg_id;
end;
$$;

revoke all on function public.enqueue_create_repo_for_repository(bigint) from public;
grant execute on function public.enqueue_create_repo_for_repository(bigint) to service_role;

-- ---------------------------------------------------------------------------
-- Instructor-facing retry: clear the recorded error and re-enqueue.
-- ---------------------------------------------------------------------------
create or replace function public.retry_repository_creation(p_repository_id bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_class_id bigint;
  v_msg_id bigint;
begin
  select class_id into v_class_id from public.repositories where id = p_repository_id;
  if not found then
    raise exception 'Repository % not found', p_repository_id;
  end if;
  if not public.authorizeforclassinstructor(v_class_id) then
    raise exception 'Not authorized to retry repository creation for this class';
  end if;

  update public.repositories set creation_error = null where id = p_repository_id;
  v_msg_id := public.enqueue_create_repo_for_repository(p_repository_id);
  return v_msg_id;
end;
$$;

revoke all on function public.retry_repository_creation(bigint) from public;
grant execute on function public.retry_repository_creation(bigint) to authenticated;

-- ---------------------------------------------------------------------------
-- Reconciler: re-enqueue transient stuck repos (safety net for lost/failed jobs).
-- ---------------------------------------------------------------------------
create or replace function public.reconcile_stuck_repo_creations(p_stale_minutes int default 15)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_count integer := 0;
begin
  for r in
    select rp.id
      from public.repositories rp
      join public.assignments a on a.id = rp.assignment_id
     where rp.is_github_ready = false
       and rp.creation_error is null
       and rp.updated_at < now() - make_interval(mins => p_stale_minutes)
       and a.repo_mode not in ('none', 'no_submission')
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

revoke all on function public.reconcile_stuck_repo_creations(int) from public;
grant execute on function public.reconcile_stuck_repo_creations(int) to service_role;

-- ---------------------------------------------------------------------------
-- Cron: invoke the reconciler edge function every 15 minutes.
-- The edge function calls reconcile_stuck_repo_creations() and emits >12h Sentry alerts.
-- ---------------------------------------------------------------------------
create or replace function public.invoke_github_repo_reconciler_background_task()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.call_edge_function_internal(
    '/functions/v1/github-repo-reconciler',
    'POST',
    '{"Content-type":"application/json","x-supabase-webhook-source":"github-repo-reconciler"}'::jsonb,
    '{}'::jsonb,
    5000,
    null, null, null, null, null
  );
end;
$$;

revoke all on function public.invoke_github_repo_reconciler_background_task() from public;
grant execute on function public.invoke_github_repo_reconciler_background_task() to service_role;

do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'github-repo-reconciler') then
      perform cron.unschedule('github-repo-reconciler');
    end if;
    perform cron.schedule(
      'github-repo-reconciler',
      '*/15 * * * *',
      $$select public.invoke_github_repo_reconciler_background_task();$$
    );
    raise notice 'GitHub repo reconciler cron scheduled every 15 minutes';
  end if;
exception
  when insufficient_privilege then
    raise notice 'Skipping github-repo-reconciler cron schedule: insufficient privilege';
end;
$cron$;
