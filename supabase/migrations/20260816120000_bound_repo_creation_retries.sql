-- Stop the github-async-worker from thrashing on unbounded create_repo enqueues.
--
-- Two independent mechanisms were re-enqueueing the same repositories forever.
--
-- 1. reconcile_stuck_repo_creations() (pg_cron, every 15 minutes) re-enqueued EVERY
--    repository row with is_github_ready = false and creation_error IS NULL, across
--    every class in the instance, with no attempt counter, no backoff and no ceiling.
--    enqueue_create_repo_for_repository() bumps updated_at, which only suppresses a
--    duplicate inside the 15-minute stale window; the next tick re-enqueued the whole
--    set again. A repository that fails in a way that does not set creation_error
--    (only NonRetryableRepoError does; a generic throw leaves it NULL) therefore
--    generated 96 create_repo jobs per day, forever, each with the worker's own retry
--    budget on top.
--
-- 2. create_all_repos_for_assignment_internal() decided "does this repo already
--    exist?" by string-comparing a DERIVED repo name against repositories.repository,
--    while enqueue_github_create_repo() dedupes the row on
--    (assignment_id, profile_id | assignment_group_id). Whenever the stored name and
--    the derived name disagreed, the existence check missed, the enqueue found the
--    existing row and did not insert, and the stored name never converged -- so the
--    next call enqueued again. Permanently. The names diverge when a group name needs
--    sanitizing (every TS path applies sanitizeRepoNameComponent, no SQL path did),
--    when a student's GitHub login is renamed, or when a class/assignment slug is
--    edited after repos exist. The FOR EACH ROW trigger on assignment_groups_members
--    then multiplied it: R rows written x (mismatched groups + students without repos).
--
-- This migration:
--   1. sanitize_repo_name_component() -- the SQL twin of _shared/repoNames.ts.
--   2. enqueue_github_create_repo() sanitizes the repo name at the single choke point
--      every SQL caller already goes through, so the row and GitHub agree.
--   3. create_all_repos_for_assignment_internal() dedupes on identity, not on name.
--   4. repositories.creation_attempts / .last_creation_attempt_at + a reset trigger.
--   5. reconcile_stuck_repo_creations() gains exponential backoff, an attempt ceiling
--      that parks the row for an instructor, and active-class scoping.
--   6. A one-time backfill that parks rows already stuck long enough to have been
--      retried hundreds of times, so the backlog drains instead of replaying.

-- ============================================================================
-- 1. Repo-name sanitizer (SQL twin of supabase/functions/_shared/repoNames.ts)
-- ============================================================================

-- Kept byte-for-byte equivalent to sanitizeRepoNameComponent() so a name derived in
-- SQL and the same name derived in TypeScript resolve to one repository. Applied to
-- the whole assembled name rather than per component: the class and assignment slugs
-- are already URL-safe, so the result is identical, and one call site covers every
-- caller instead of every concatenation site.
create or replace function public.sanitize_repo_name_component(raw text)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_sanitized text;
begin
  if raw is null then
    return null;
  end if;

  v_sanitized := normalize(raw, NFKD);
  -- spaces & other characters GitHub does not accept in a repo name -> hyphen
  v_sanitized := regexp_replace(v_sanitized, '[^A-Za-z0-9._-]+', '-', 'g');
  -- collapse runs
  v_sanitized := regexp_replace(v_sanitized, '-{2,}', '-', 'g');
  -- trim leading/trailing separators
  v_sanitized := regexp_replace(v_sanitized, '^[-_.]+|[-_.]+$', '', 'g');

  -- An input made up entirely of illegal characters collapses to '', and GitHub
  -- rejects that. Fail loudly here rather than letting an unusable name reach the
  -- queue, matching the TypeScript helper.
  if v_sanitized = '' then
    raise exception 'sanitize_repo_name_component: input "%" produced an empty repo-name component', raw;
  end if;

  return v_sanitized;
end;
$$;

comment on function public.sanitize_repo_name_component(text) is
  'Normalize a repo name to the character set GitHub accepts. SQL twin of sanitizeRepoNameComponent() in supabase/functions/_shared/repoNames.ts; the two must stay in sync or SQL- and TS-derived names diverge and dedupe by name breaks.';

grant execute on function public.sanitize_repo_name_component(text) to authenticated, service_role;

-- ============================================================================
-- 2. Sanitize at the enqueue choke point
-- ============================================================================
--
-- Unchanged from 20260530120200 except for the sanitize of p_repo_name. Every SQL
-- path that creates a repo goes through here (create_all_repos_for_assignment_internal,
-- publish_assignment_group_changes, copy_groups_from_assignment,
-- enqueue_create_repo_for_repository), so this is the one place that has to apply it.
-- Before this, a group named "Team 1" was stored as `org/course-hw1-group-Team 1`
-- while GitHub coerced the actual repo to `Team-1` -- which also broke webhook
-- lookups that resolve a repository row by name.
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
  -- Sanitize the name the CALLER derived. Only a name we are about to store is
  -- sanitized; a name read back off an existing row is authoritative and is used
  -- verbatim (see below).
  v_repo_name := public.sanitize_repo_name_component(p_repo_name);
  full_repo_name := p_org || '/' || v_repo_name;

  insert into public.api_gateway_calls(method, status_code, class_id, debug_id)
  values ('create_repo', 0, p_class_id, p_debug_id)
  returning id into log_id;

  if p_assignment_id is not null then
    -- Historic data contains rows that share an identity (no unique constraint enforces
    -- one repo per assignment+profile / assignment+group). A bare `select ... into` over
    -- those picks an arbitrary row, so a retry for one row could enqueue against another
    -- row's repository. Prefer the row whose stored name is exactly the one the caller
    -- asked for -- which is how enqueue_create_repo_for_repository addresses a specific
    -- row -- and fall back to the lowest id so the choice is at least deterministic.
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

      -- A concurrent enqueue for the same repo can win the race between the select
      -- above and this insert. `unique_repo_name` turns that into a no-op rather than
      -- a duplicate; re-read the winner's row so both callers enqueue against one row.
      -- The re-read is constrained to the SAME identity: a row holding this name for a
      -- different assignment/profile/group is a genuine name collision, and adopting it
      -- would silently point this job at someone else's repository. Fail loudly instead,
      -- which is what the bare unique violation did before.
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
        v_repo_name := split_part(v_existing_name, '/', 2);
      end if;
    else
      -- An existing row's stored name is authoritative: it is what a GitHub repo was
      -- (or will be) created as, what webhooks resolve against, and what
      -- enqueue_create_repo_for_repository reads back on a retry. Re-sanitizing it
      -- would retarget the job at a DIFFERENT repository -- `…-group-Team--One` is a
      -- perfectly valid GitHub name, but the sanitizer collapses it to
      -- `…-group-Team-One` -- and the worker marks the row ready by repo_id without
      -- writing the name back, so the row would end up pointing at a repo nobody
      -- created. Use the stored name and leave the row alone.
      v_repo_name := split_part(v_existing_name, '/', 2);
    end if;
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

grant execute on function public.enqueue_github_create_repo(
  bigint, text, text, text, text, text[], boolean, text, bigint, uuid, bigint, text,
  text, text, jsonb, text
) to service_role;

-- ============================================================================
-- 3. Dedupe on identity, not on a derived name
-- ============================================================================
--
-- Unchanged from 20260530120200 except for the two existence checks, which now key on
-- the same (assignment_id, profile_id) / (assignment_id, assignment_group_id) identity
-- that enqueue_github_create_repo uses to decide whether to insert a row. Comparing
-- derived names could never converge: a mismatch made the check miss on every call
-- while the enqueue kept reusing the existing row.
create or replace function public.create_all_repos_for_assignment_internal(
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
    raise warning 'create_all_repos_for_assignment_internal called with NULL parameters, skipping';
    return;
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

  if v_repo_mode = 'no_submission' then
    -- No git repos for this mode; instead make sure every student/group has an
    -- empty 'manual' submission so graders see a row for everyone.
    perform public.create_all_manual_submissions_for_assignment(v_course_id, v_assignment_id);
    return;
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

  if v_repo_mode = 'fork_from_prior_assignment' and v_source_assignment_id is null then
    raise exception 'Assignment % has repo_mode=fork_from_prior_assignment but no source_assignment_id', v_assignment_id;
  end if;

  v_creation_method := case
    when v_repo_mode = 'template_only_staff' then 'template'
    else 'fork'
  end;
  v_default_source := v_template_repo;

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
        -- Identity, not name: this is the key enqueue_github_create_repo dedupes on.
        or not exists (
          select 1 from public.repositories r
          where r.assignment_id = v_assignment_id
            and r.profile_id = ur.private_profile_id
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
        -- Identity, not name. A renamed group used to miss here forever.
        or not exists (
          select 1 from public.repositories r
          where r.assignment_id = v_assignment_id
            and r.assignment_group_id = ag.id
        )
      )
    group by ag.id, ag.name
    having array_length(array_remove(array_agg(u.github_username), null), 1) > 0
  loop
    if v_repo_mode = 'fork_from_prior_assignment' then
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
      -- Sanitize the group name as its own COMPONENT, exactly as the TypeScript paths
      -- do. Sanitizing only the assembled name would let two groups whose names are
      -- entirely illegal characters ("###" and "@@@") both collapse to
      -- `<slug>-<assignment>-group` and collide on one repository; per-component
      -- sanitization raises on such a name instead, matching sanitizeRepoNameComponent.
      v_slug || '-' || v_assignment_slug || '-group-' || public.sanitize_repo_name_component(r_group_name),
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

revoke all on function public.create_all_repos_for_assignment_internal(bigint, bigint, boolean) from public;
grant execute on function public.create_all_repos_for_assignment_internal(bigint, bigint, boolean) to postgres;

comment on function public.create_all_repos_for_assignment_internal(bigint, bigint, boolean) is
  'Enqueue repo creation for an assignment per its repo_mode (template/fork/none) without auth.uid()/instructor checks; for triggers and other trusted callers. Skips students/groups that already have a repository row for this assignment, keyed on identity (profile_id / assignment_group_id) to match enqueue_github_create_repo -- never on a derived repo name, which cannot converge once it diverges.';

-- ============================================================================
-- 4. Attempt accounting on repositories
-- ============================================================================

alter table public.repositories
  add column if not exists creation_attempts integer not null default 0,
  add column if not exists last_creation_attempt_at timestamptz;

comment on column public.repositories.creation_attempts is
  'How many times automatic reconciliation has re-enqueued creation for this repo. Drives the reconciler backoff and ceiling; reset to 0 when the repo becomes ready or an instructor retries.';
comment on column public.repositories.last_creation_attempt_at is
  'When reconciliation last re-enqueued creation for this repo.';

-- Partial index matching the reconciler's scan: the pending set is tiny next to the
-- table, and the reconciler runs every 15 minutes.
create index if not exists repositories_pending_creation_idx
  on public.repositories (updated_at)
  where is_github_ready = false and creation_error is null;

-- Reset the counter the moment a repo becomes ready, whichever of the four creation
-- paths got it there (async worker, assignment-create-all-repos, github-user-sync,
-- autograder-create-repos-for-student). Keeping this in SQL means a row that later
-- flips back to not-ready starts a fresh retry budget rather than inheriting a stale
-- count, without every TS caller having to remember.
create or replace function public.reset_repo_creation_attempts_on_ready()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.is_github_ready and not coalesce(old.is_github_ready, false) then
    new.creation_attempts := 0;
    new.creation_error := null;
  end if;
  return new;
end;
$$;

drop trigger if exists reset_repo_creation_attempts_on_ready on public.repositories;
create trigger reset_repo_creation_attempts_on_ready
  before update on public.repositories
  for each row
  execute function public.reset_repo_creation_attempts_on_ready();

-- ============================================================================
-- 5. Count the attempt when reconciliation re-enqueues
-- ============================================================================
--
-- Unchanged from 20260709130000 except for the final UPDATE, which now records the
-- attempt as well as bumping updated_at.
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

  -- Record the attempt. updated_at feeds the reconciler's stale window (so a second
  -- job cannot race one still in flight) and creation_attempts feeds its backoff and
  -- ceiling -- without the counter, a repo that can never succeed was re-enqueued
  -- every 15 minutes forever.
  update public.repositories
     set updated_at = now(),
         creation_attempts = creation_attempts + 1,
         last_creation_attempt_at = now()
   where id = p_repository_id;

  return v_msg_id;
end;
$$;

revoke all on function public.enqueue_create_repo_for_repository(bigint) from public;
grant execute on function public.enqueue_create_repo_for_repository(bigint) to service_role;

-- ============================================================================
-- 6. Instructor retry clears the parked state
-- ============================================================================
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

  update public.repositories
     set creation_error = null
   where id = p_repository_id;

  v_msg_id := public.enqueue_create_repo_for_repository(p_repository_id);

  -- Zero the counter AFTER the enqueue, not before: enqueue_create_repo_for_repository
  -- increments it, so resetting first would leave the instructor with seven automatic
  -- retries rather than the full budget. A deliberate manual retry states that the
  -- underlying problem is fixed, so it does not spend an automatic attempt. The
  -- updated_at bump from the enqueue survives (this write refreshes it again), so the
  -- reconciler's stale window still keeps a second job from racing this one.
  update public.repositories
     set creation_attempts = 0
   where id = p_repository_id;

  return v_msg_id;
end;
$$;

revoke all on function public.retry_repository_creation(bigint) from public;
grant execute on function public.retry_repository_creation(bigint) to authenticated;

-- ============================================================================
-- 7. Bounded reconciliation
-- ============================================================================
--
-- Three bounds the previous version had none of:
--   * Active classes only. The old scan covered every repository row ever created,
--     so finished courses kept generating GitHub calls indefinitely. Matches the
--     scoping #924 applied to the Discord role sync.
--   * Exponential backoff on creation_attempts: 15m, 30m, 1h, 2h, 4h, then 8h.
--   * A ceiling. At MAX_ATTEMPTS the row is parked with creation_error set, which
--     both removes it from this scan and surfaces it to the instructor's Retry
--     button and the reconciler edge function's >12h Sentry alert. Roughly 32h of
--     automatic retries before a human is asked to look.
create or replace function public.reconcile_stuck_repo_creations(p_stale_minutes int default 15)
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
begin
  -- Park anything that has exhausted its automatic retries. Done as a set operation
  -- before the loop so a row is parked exactly once, and so the loop below never sees
  -- it again.
  update public.repositories rp
     set creation_error = format(
           'Repository creation did not succeed after %s automatic attempts. Check the assignment template repository and GitHub org configuration, then use Retry.',
           v_max_attempts)
    from public.assignments a
   where a.id = rp.assignment_id
     and rp.is_github_ready = false
     and rp.creation_error is null
     and rp.creation_attempts >= v_max_attempts
     and a.repo_mode not in ('none', 'no_submission');

  for r in
    select rp.id
      from public.repositories rp
      join public.assignments a on a.id = rp.assignment_id
      join public.classes c on c.id = rp.class_id
     where rp.is_github_ready = false
       and rp.creation_error is null
       and rp.creation_attempts < v_max_attempts
       and a.repo_mode not in ('none', 'no_submission')
       -- Recurring per-class work must not run for courses that have ended.
       and public.is_class_active(c.archived, c.end_date)
       -- Exponential backoff: each failed attempt doubles the wait, capped.
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

revoke all on function public.reconcile_stuck_repo_creations(int) from public;
grant execute on function public.reconcile_stuck_repo_creations(int) to service_role;

comment on function public.reconcile_stuck_repo_creations(int) is
  'Re-enqueue transient stuck repo creations for active classes, with exponential backoff and an attempt ceiling that parks the row for an instructor. Bounded by design: an unbounded version re-enqueued every not-ready repo in the instance every 15 minutes.';

-- ============================================================================
-- 8. One-time backlog drain
-- ============================================================================
--
-- Rows that have been stuck long enough to have already been re-enqueued hundreds of
-- times get parked now rather than being handed a fresh retry budget by the new
-- backoff. They become visible to instructors via creation_error and the Retry
-- button, which is the correct end state for a repo that has never once succeeded.
-- Deliberately conservative: only rows in classes that have ended, or pending longer
-- than a week in a running class.
--
-- Keyed on updated_at, NOT created_at: a repository row can be created once and go
-- pending much later. assignment-create-all-repos flips an existing row back to
-- is_github_ready = false when a permission sync finds no valid usernames or skips
-- collaborator removals, and the async worker leaves a row pending when it cannot mark
-- it ready. Keying on created_at would park those the instant they go pending, purely
-- because the row itself is old, and the reconciler would then skip them until an
-- instructor retried by hand. updated_at measures the thing this cutoff is about: how
-- long THIS pending state has lasted.
update public.repositories rp
   set creation_attempts = 8,
       creation_error = 'Repository creation did not succeed after repeated automatic attempts. Check the assignment template repository and GitHub org configuration, then use Retry.'
  from public.assignments a,
       public.classes c
 where a.id = rp.assignment_id
   and c.id = rp.class_id
   and rp.is_github_ready = false
   and rp.creation_error is null
   and a.repo_mode not in ('none', 'no_submission')
   and (
     not public.is_class_active(c.archived, c.end_date)
     or rp.updated_at < now() - interval '7 days'
   );
