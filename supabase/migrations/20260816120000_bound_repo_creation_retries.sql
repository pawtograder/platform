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
--   1. sanitize_repo_name_component() -- the SQL twin of _shared/repoNames.ts, applied
--      per COMPONENT and never to an assembled name.
--   2. Sanitization happens at the sites that DERIVE a name, on the one component that
--      needs it: the group name, in create_all_repos_for_assignment_internal() and in
--      publish_assignment_group_changes(). enqueue_github_create_repo() passes the name
--      its caller derived straight through.
--
--      Nothing normalizes an assembled name, and that restraint is load-bearing rather
--      than laziness: TypeScript sanitizes the group-name component alone and leaves the
--      class and assignment slugs byte-for-byte, so ANY pass over the whole name -- even
--      one restricted to characters GitHub rejects -- makes SQL derive a different
--      repository than TypeScript for the same group, which is precisely the divergence
--      this migration exists to close. Slugs really do carry such characters: the e2e
--      harness builds a `dd/MM/yy HH:mm:ss#suffix` stamp into a class slug, so a
--      whole-name net rewrites `/`, `:` and `#` and every derived name stops matching.
--      Sanitizing an assembled name is therefore a bug, not a safety net.
--
--      A name read back off an existing row is authoritative and is used verbatim -- it
--      is what a GitHub repo was created as and what webhooks resolve against, and
--      `is_github_ready = false` does not mean no GitHub repo exists (the worker can
--      create the repo and fail to mark the row). So new rows converge on the name
--      GitHub will actually create, and existing rows keep resolving to their real
--      repository. Renaming the rows that already diverged is a data migration,
--      deliberately not folded in here.
--   3. create_all_repos_for_assignment_internal() dedupes on identity, not on name.
--   4. repositories.creation_attempts / .last_creation_attempt_at + a reset trigger.
--   5. reconcile_stuck_repo_creations() gains exponential backoff, an attempt ceiling
--      that parks the row for an instructor, and active-class scoping.
--   6. A one-time backfill that parks rows already stuck long enough to have been
--      retried hundreds of times, so the backlog drains instead of replaying.
--   7. A trigger on assignment_groups that refuses a group name with no repo-name form
--      ("---") and one that normalizes onto a sibling's ("Team--One" beside "Team-One").
--      Both pass today's app-layer validators and then produce a group that can never
--      get a repository, which is a class of stuck row rather than a stuck retry.

-- ============================================================================
-- 1. Repo-name sanitizer (SQL twin of supabase/functions/_shared/repoNames.ts)
-- ============================================================================

-- Kept byte-for-byte equivalent to sanitizeRepoNameComponent() so a name derived in
-- SQL and the same name derived in TypeScript resolve to one repository.
--
-- Apply this to a single COMPONENT (a group name), never to an assembled repo name.
-- The TypeScript paths sanitize only the group-name component and leave the class and
-- assignment slugs untouched, so running the collapse and trim rules over a whole name
-- would diverge from them: an assignment slugged `hw--1` assembles to
-- `course-hw--1-group-Team` in TypeScript but would collapse to `course-hw-1-group-Team`
-- here, and github-user-sync would then sync permissions against a repo that does not
-- exist. Nothing constrains slugs to make that collapse a no-op -- and a class slug can
-- hold characters GitHub rejects outright (`/`, `:`, `#`), which TypeScript passes
-- through untouched, so even a gentler whole-name pass diverges. There is deliberately
-- no whole-name sanitizer to reach for: normalize components, assemble, and leave the
-- assembled name alone.
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

-- An earlier revision of this migration also shipped sanitize_repo_name(), a weaker
-- pass over the ASSEMBLED name that only mapped characters GitHub rejects onto hyphens.
-- It is dropped rather than kept unused: however gentle, a whole-name pass rewrites
-- parts of the name no TypeScript path touches. A class slug carrying `/`, `:` or `#`
-- -- which the e2e harness generates on every run, and which nothing forbids in
-- production -- came out of it hyphenated, so the queued repoName stopped matching the
-- name every TypeScript path derives for the same repository, and repo lookups by name
-- missed. Dropped explicitly so an environment that already applied that revision does
-- not keep a function whose only correct number of callers is zero.
drop function if exists public.sanitize_repo_name(text);

-- ============================================================================
-- 2. One repository row per identity at the enqueue choke point
-- ============================================================================
--
-- Every SQL path that creates a repo goes through here
-- (create_all_repos_for_assignment_internal, publish_assignment_group_changes,
-- copy_groups_from_assignment, enqueue_create_repo_for_repository). Unchanged from
-- 20260530120200 except for how it picks the row to enqueue against and which name it
-- queues: the lookup now breaks ties deterministically, an insert that loses a race
-- re-reads the winner instead of raising, and a name read back off an existing row is
-- queued verbatim.
--
-- What this function deliberately does NOT do is sanitize. It queues p_repo_name as the
-- caller assembled it. Normalizing here would look like the obvious choke point and be
-- wrong: the caller has already sanitized the one component that needs it, and the rest
-- of the name -- the class and assignment slugs -- must stay byte-identical to what the
-- TypeScript paths produce, including characters GitHub itself rejects. A slug of
-- `e2e-17/08/26-00:34:10#f3oe` is not ours to fix here; rewriting it makes this the only
-- deriver in the system that disagrees with all the others.
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
  -- The caller's name, byte-for-byte. Callers sanitize the group-name COMPONENT before
  -- they assemble (create_all_repos_for_assignment_internal,
  -- publish_assignment_group_changes), matching what TypeScript does; anything this
  -- function did to the assembled name on top of that would only make SQL and
  -- TypeScript derive different repositories. v_repo_name exists because a name read
  -- back off an existing row overrides it below, not because it gets rewritten here.
  v_repo_name := p_repo_name;
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
        v_repo_name := substring(v_existing_name from position('/' in v_existing_name) + 1);
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
      v_repo_name := substring(v_existing_name from position('/' in v_existing_name) + 1);
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

    -- One unusable group name must not take down the assignment-wide pass. This runs
    -- inside the FOR EACH ROW trigger on assignment_groups_members, so an exception here
    -- aborts whatever transaction touched membership -- a student's group join, say.
    -- Two reachable cases, both allowed by the group-name validators
    -- (`^[a-zA-Z0-9_-]{1,36}$` in the UI and edge functions, `^[a-zA-Z0-9_-]+$` in the
    -- SQL RPCs), neither of which the sanitizer can express:
    --   * separator-only names ("---", "_") trim to an empty component and raise;
    --   * "Team-One" and "Team--One" both collapse to "Team-One" and collide on
    --     unique_repo_name.
    -- The TypeScript paths hit exactly the same two walls, since they call
    -- sanitizeRepoNameComponent on the same input -- so skipping is the consistent
    -- outcome, not a SQL-only quirk. Warn, skip that group, keep going. Validating
    -- names against the sanitizer at group-creation time (with post-sanitization
    -- uniqueness) is the real fix and belongs with the group-creation paths.
    begin
      perform public.enqueue_github_create_repo(
        v_course_id,
        v_org,
        -- Sanitize the group name as its own COMPONENT, exactly as the TypeScript paths
        -- do, so a name derived here and the same name derived there agree. Netting only
        -- the assembled name would leave "Team--One" uncollapsed in SQL while TypeScript
        -- collapses it -- the divergence this migration exists to close.
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
    exception
      -- Narrow on purpose. raise_exception covers the two name failures this handler
      -- exists for -- sanitize_repo_name_component rejecting a separator-only name, and
      -- the same-name-different-identity guard in enqueue_github_create_repo --
      -- and unique_violation covers two allowed names colliding after collapse.
      -- Everything else (a pgmq send failure, a deadlock, a permission error) propagates
      -- as before: those are not a property of this group's name, they affect every
      -- group in the pass, and swallowing them would report a success that never
      -- happened.
      when raise_exception or unique_violation then
        raise warning 'Could not enqueue a repo for group "%" (id %) on assignment %: %. Rename the group to something that survives repo-name normalization; no repository will be created for it until then.',
          r_group_name, r_group_id, v_assignment_id, sqlerrm;
    end;
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
  -- Strip only the org, i.e. everything up to the FIRST slash. split_part(..., '/', 2)
  -- would truncate at the SECOND one, and a repository name can legitimately contain a
  -- slash: nothing constrains class or assignment slugs, and e2e class slugs carry a
  -- formatted timestamp (`dd/MM/yy`). That truncation silently enqueued a shortened repo
  -- name for every such class.
  v_repo_name := substring(r.repository from position('/' in r.repository) + 1);

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
    -- Deterministic failure, not a transient one: there is no repository on the source
    -- assignment to fork, and no amount of retrying creates one. Returning here without
    -- touching the retry state left the row stale-and-unparked forever -- the reconciler
    -- counted the call as a success, the attempt ceiling was never approached and
    -- creation_error was never set, so it came back every 15 minutes and never surfaced
    -- the instructor Retry action. Park it instead; that is exactly what creation_error
    -- is for, and it takes the row out of reconcile_stuck_repo_creations' scan.
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
  -- Longest single requeue github-async-worker can apply to one job (12h for an extreme
  -- rate limit), plus an hour of margin. See the park comment below.
  v_worker_max_requeue constant interval := interval '13 hours';
begin
  -- Park anything that has exhausted its automatic retries AND has gone quiet for the
  -- interval its next attempt would have waited. Done as a set operation before the loop
  -- so a row is parked exactly once, and so the loop below never sees it again.
  --
  -- The staleness term is not belt-and-braces. Attempt eight is enqueued, not completed:
  -- the job can sit in the queue, and github-async-worker requeues a rate-limited create
  -- with a long delay. Parking on the attempt count alone means the very next tick
  -- reports a failure to the instructor while that attempt is still pending, and the
  -- Retry button they are being pointed at enqueues a second create_repo racing the
  -- first. Reusing the retry loop's own backoff interval -- deliberately the same
  -- expression, not a second timing rule that could drift from it -- parks a row exactly
  -- when it would otherwise have become eligible for attempt nine.
  --
  -- That expression alone is not long enough, though: it tops out at
  -- 15 min * 2^5 = 8 hours, while the worker can hold a single job longer than that.
  -- supabase/functions/github-async-worker/index.ts requeues an `extreme` rate limit
  -- with a default of 43200s = 12 hours (the baseDefault around line 2315) and requeues
  -- with 28800s = 8 hours when the error circuit breaker trips (around lines 2397 and
  -- 2461). An eighth attempt that hit an extreme rate limit is therefore still sitting
  -- in the queue, invisible to us, four hours before the backoff expression would call
  -- it dead. The floor of 13 hours covers the 12-hour worst case with an hour of margin
  -- for queue latency and reconciler tick spacing.
  --
  -- This couples the migration to the worker's retry policy: if those delays change,
  -- this floor has to change with them, or we go back to parking rows whose last
  -- attempt is still alive.
  update public.repositories rp
     set creation_error = format(
           'Repository creation did not succeed after %s automatic attempts. Check the assignment template repository and GitHub org configuration, then use Retry.',
           v_max_attempts)
    from public.assignments a
   where a.id = rp.assignment_id
     and rp.is_github_ready = false
     and rp.creation_error is null
     and rp.creation_attempts >= v_max_attempts
     and rp.updated_at < now() - greatest(
           make_interval(
             mins => p_stale_minutes * (2 ^ least(rp.creation_attempts, v_max_backoff_doublings))::int
           ),
           v_worker_max_requeue
         )
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
       -- Recurring per-class work must not run for courses that have ended -- EXCEPT to
       -- finish following up an attempt somebody actually made. retry_repository_creation
       -- clears creation_error and zeroes the counter, so on an archived class (or one
       -- ended over 30 days ago) the row it queued would fall outside this scan entirely:
       -- if that job is lost, or exhausts the worker's generic retries without writing a
       -- terminal error, the row sits at is_github_ready = false with no error, the UI
       -- shows it as pending, the Retry affordance is gone, and nothing can ever make it
       -- actionable again. Following up on a human's retry is not recurring work; it is
       -- one bounded sequence with an end.
       --
       -- Bounded by the same ceiling as everything else, which is what keeps this from
       -- being the side door back to the unbounded behavior this migration removed. An
       -- inactive-class row can only be picked up here while creation_attempts is under
       -- the ceiling, and the park UPDATE above -- which deliberately has no class filter
       -- -- ends the sequence by setting creation_error. Worst case after one click:
       -- 8 attempts over roughly 32 hours, then parked with an error the instructor can
       -- see. The row converges on ready or on parked, and either way stops being scanned.
       --
       -- Sizing the window. Every re-enqueue rewrites last_creation_attempt_at, so the
       -- window does not have to cover a whole retry sequence -- only the longest gap
       -- between two consecutive attempts, which is the 13-hour park floor above. Seven
       -- days is deliberately far above that minimum: a worker paused for a few days, or
       -- a queue that backed up over a weekend, should not permanently strand a row
       -- halfway through its sequence. It is still short enough that a dead class goes
       -- quiet within a week of the last attempt anyone made on it.
       --
       -- last_creation_attempt_at is written only when a job is actually queued, by
       -- enqueue_create_repo_for_repository, so a row nobody has touched in a dead class
       -- has an old or null value and stays out entirely.
       --
       -- The honest consequence: this follows up recent AUTOMATIC attempts too, not only
       -- human ones -- nothing on the row distinguishes them, and retry_repository_
       -- creation's counter reset is not a reliable marker. So archiving a class does not
       -- stop work on it the same instant; a row still pending finishes its remaining
       -- attempts (at most 8, roughly 32 hours) and is then parked with an error. That is
       -- bounded per row and terminal, which is the property this migration is about --
       -- unlike the behavior it replaced, where every not-ready row in the instance was
       -- re-enqueued every 15 minutes with no counter and no end.
       and (
         public.is_class_active(c.archived, c.end_date)
         or rp.last_creation_attempt_at > now() - interval '7 days'
       )
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
--
-- This does NOT need the in-flight guard the reconciler's park just grew. Both cutoffs
-- here are already staleness cutoffs on updated_at, and both are enormous next to the
-- reconciler's longest backoff of eight hours: a week of silence in a running class, or
-- a class that has ended and whose rows the reconciler no longer scans at all. Nothing
-- plausibly in flight survives either. And parking is recoverable in any case -- if a
-- late job does succeed, reset_repo_creation_attempts_on_ready clears creation_error and
-- the attempt count as the row flips ready, so a parked row heals itself rather than
-- needing the instructor to undo anything.
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

-- ============================================================================
-- 9. Reject group names that cannot become a repository name
-- ============================================================================
--
-- A group repository is named
--   <class_slug>-<assignment_slug>-group-<sanitize_repo_name_component(group.name)>
-- which makes the group name the only user-authored component of a GitHub repo name.
-- Two shapes of name pass the app-layer validators (`^[a-zA-Z0-9_-]{1,36}$` in the
-- create-group form, in publish_assignment_group_changes and in the bulk-import path)
-- and then have nowhere to go on the other side of that derivation:
--
--   * Separator-only names -- `---`, `_`, `-_-`. sanitize_repo_name_component() trims
--     them to the empty string and raises, so what the student sees is not "pick
--     another name" at the moment they pick it, but a create-all-repos call or an
--     async worker job failing later with a message about repo-name components. The
--     group exists, has members, and can never get a repository.
--   * Names that differ only in characters the sanitizer folds away: `Team-One` and
--     `Team--One` both normalize to `Team-One`. Both are legal, distinct rows under
--     unique_assignment_group_name; both derive the same repository name; and the
--     second one to reach the queue trips the unique_repo_name index on
--     repositories.repository. Which group loses is a race, and the loser's failure
--     surfaces in a worker rather than at the keyboard of whoever named it.
--
-- The uniqueness comparison is case-insensitive because GitHub is: `team-one` and
-- `Team-One` are one repository there, so two groups holding those names collide on
-- creation even though both rows are distinct. publish_assignment_group_changes
-- already refuses a case-insensitive duplicate of the plain name (and
-- unique_assignment_groups_name_assignment_id enforces it); this extends that same
-- rule to the sanitized form, which is what actually reaches GitHub.
--
-- This lives in the database rather than in one more validator because group rows are
-- written from several places -- the student-facing join/create flow, the instructor
-- RPCs, copy_groups_from_assignment, the CSV import, seeds -- and only the table sees
-- all of them.
--
-- Deliberately NOT enforced here: the character set and the 36-character limit. Those
-- stay exactly where they are, in the app layer. Names with spaces (`Brand New Team 9`)
-- are ordinary and sanitize cleanly to `Brand-New-Team-9`; rejecting them at the table
-- would break existing callers, seeds and rows for no gain. The rule this trigger
-- enforces is narrower and mechanical: whatever the name is, it must survive the
-- derivation and land on a repository name no sibling group also lands on.
--
-- Groups on assignments that never provision a repository ('none', 'no_submission') are
-- exempt from both rules -- there is no repository name to protect, so the rules would
-- only be rejecting labels. See the trigger body for how that interacts with an
-- assignment whose mode changes later.
--
-- Existing rows are grandfathered. The trigger fires on `update of name`, so a legacy
-- group that already violates either rule keeps its name, keeps its repository and
-- keeps working until somebody renames it -- at which point the new name has to be
-- valid. The audit at the end of this section reports the legacy violations into the
-- deploy log without failing the deploy.

-- security definer because RLS on assignment_groups scopes SELECT to the caller's
-- class enrollment, and the collision check has to see every sibling group regardless
-- of who is writing. A definer-less check would silently pass for a caller who cannot
-- read the row it collides with, which is the exact case this is meant to catch.
create or replace function public.validate_assignment_group_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_repo_mode text;
  v_sanitized text;
  v_other text;
  r record;
begin
  -- Both rules below exist only to protect a GitHub repository name. Two assignment
  -- modes never provision one -- create_all_repos_for_assignment_internal() returns
  -- early for 'no_submission' and 'none' -- so on a manual or paper assignment these
  -- checks reject group names for a repository that will never be created: `Team-One`
  -- beside `Team--One` is two perfectly good labels colliding over nothing, and `---`
  -- is a fine name for a group that submits on paper.
  --
  -- The exemption is evaluated per write, not stored, so an assignment that later moves
  -- to a repo-provisioning mode carries names admitted under it. Nothing retro-validates
  -- them, deliberately: that is the same grandfathering this migration applies to legacy
  -- rows, and it is why section 3 makes create_all_repos_for_assignment_internal() warn
  -- and skip a group whose name will not sanitize rather than abort the whole pass. The
  -- assignment still provisions every other group, the instructor gets a warning naming
  -- the group that did not, and renaming it goes through this trigger -- which by then
  -- does apply -- so the repair sticks.
  select a.repo_mode::text into v_repo_mode
    from public.assignments a
   where a.id = new.assignment_id;

  if v_repo_mode in ('none', 'no_submission') then
    return new;
  end if;

  begin
    v_sanitized := public.sanitize_repo_name_component(new.name);
  exception
    when others then
      raise exception 'Group name "%" cannot be used: a group name needs at least one letter or number in it. This group''s repository is named after it, and GitHub will not accept a name made only of dashes, underscores or dots. Pick a different name for the group.', new.name
        using errcode = 'check_violation';
  end;

  -- Serialize every writer of group names within one assignment. The scan below reads
  -- committed sibling rows, so without this two concurrent transactions -- one naming a
  -- group `Team-One`, one naming it `Team--One` -- each scan before the other's row is
  -- visible, both pass, both commit, and the pair that this trigger exists to prevent
  -- lands anyway. Neither unique index catches it: the stored names genuinely differ,
  -- and it is only the NORMALIZED forms that collide, which surfaces later as a
  -- unique_repo_name violation inside a worker. Assignment-scoped rather than global so
  -- unrelated classes never wait on each other.
  --
  -- A unique index on lower(sanitize_repo_name_component(name)) would be the tempting
  -- "upgrade" here. It is not available: the function raises on separator-only names, so
  -- the index expression is not total over existing data, and grandfathered rows that
  -- already collide (this migration's audit reports them rather than rewriting them)
  -- would make CREATE INDEX fail and take the deploy with it -- the same reason this PR
  -- declined a unique index over derived repository names. A lock plus a scan enforces
  -- the rule for new writes without demanding that history already obey it.
  --
  -- Deadlock analysis. This lock is taken in exactly one place, this trigger, and only
  -- for an insert or a rename of a group. A transaction normally touches one assignment
  -- -- the student create/join flow, an instructor rename, publish_assignment_group_
  -- changes and copy_groups_from_assignment all work against a single assignment_id --
  -- so it is one key per transaction and there is no second key to order against.
  -- copy_groups_from_assignment inserts many groups into its target and so reaches this
  -- line once per row, which is free: advisory locks are re-entrant, and repeat
  -- acquisitions of a key the transaction already holds only bump a reference count. It
  -- also takes its own `copy_groups:<class>:<target>` lock first and always in that
  -- order, so the two lock namespaces are acquired in a consistent sequence.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.format('assignment_group_name:%s', new.assignment_id), 0)
  );

  -- Row-at-a-time rather than one set query so that a grandfathered sibling whose own
  -- name does not sanitize cannot make this trigger raise on an unrelated group: a
  -- name with no repo-name form has no repository, so nothing can collide with it.
  --
  -- The scan skips any sibling whose name is byte-identical to the incoming one, and
  -- that exclusion is load-bearing -- do NOT simplify it away as redundant with the id
  -- guard:
  --
  --   A BEFORE INSERT trigger fires before ON CONFLICT arbitration, and identity
  --   defaults are already filled in by the time it runs. So an upsert that Postgres
  --   is about to route into an UPDATE of an existing row arrives here looking like a
  --   brand-new row with a fresh id, colliding with itself; `id is distinct from
  --   new.id` cannot tell the two apart. copy_groups_from_assignment reuses target
  --   groups exactly that way -- INSERT ... ON CONFLICT (assignment_id, name) DO
  --   UPDATE, so repository and submission history survive a re-copy -- and without
  --   this exclusion every copy into a target that already holds a same-named group
  --   aborts on a collision of a group with itself. That is an instructor's ordinary
  --   "copy groups from lab 1 to lab 2, then fix a roster and copy again" workflow.
  --
  -- Skipping those rows gives up no protection. A byte-identical duplicate is already
  -- rejected by unique_assignment_group_name (assignment_id, name), and a duplicate
  -- differing only in capitalization by unique_assignment_groups_name_assignment_id
  -- (lower(name), assignment_id). What those indexes cannot see, and what this trigger
  -- exists for, is a pair that is distinct as stored yet identical once sanitized --
  -- `Team--One` against `Team-One` -- and such a pair is never byte-identical, so it
  -- still reaches the comparison below.
  for r in
    select ag.id, ag.name
      from public.assignment_groups ag
     where ag.assignment_id = new.assignment_id
       and ag.id is distinct from new.id
       and ag.name is distinct from new.name
  loop
    begin
      v_other := lower(public.sanitize_repo_name_component(r.name));
    exception
      when others then
        v_other := null;
    end;

    if v_other is not null and v_other = lower(v_sanitized) then
      raise exception 'Group name "%" is too similar to the existing group "%" on this assignment. GitHub ignores capitalization and treats repeated dashes as one, so both group names turn into the same repository name ("%") and only one of the two groups could ever get its repository. Rename one of them so they differ by a letter or a number, not only by punctuation or capitalization.', new.name, r.name, v_sanitized
        using errcode = 'unique_violation';
    end if;
  end loop;

  return new;
end;
$$;

comment on function public.validate_assignment_group_name() is
  'Reject an assignment group name that cannot become a repository name: one that sanitize_repo_name_component() empties, or one that normalizes to the same component as a sibling group in the same assignment (compared case-insensitively, as GitHub does). Does not police character set or length -- those stay in the app layer, and names with spaces are valid here.';

drop trigger if exists validate_assignment_group_name on public.assignment_groups;
create trigger validate_assignment_group_name
  before insert or update of name on public.assignment_groups
  for each row
  execute function public.validate_assignment_group_name();

-- One-time audit of what the rules would have caught, reported and not enforced.
-- Renaming existing groups is a data decision (their repositories already exist under
-- the old names), so this only puts the counts in the deploy log for whoever has to
-- make it. Wrapped so that it can never fail the migration: an audit that aborts a
-- deploy is worse than no audit.
do $$
declare
  r record;
  v_keys text[] := '{}';
  v_unnameable int := 0;
  v_colliding_names int := 0;
  v_collision_clusters int := 0;
begin
  -- Same exemption the trigger applies: a group on a no-repo assignment has no repo
  -- name to violate, and counting it would send whoever reads this log after names that
  -- are fine.
  for r in
    select ag.id, ag.assignment_id, ag.name
      from public.assignment_groups ag
      join public.assignments a on a.id = ag.assignment_id
     where a.repo_mode not in ('none', 'no_submission')
  loop
    begin
      v_keys := v_keys || (r.assignment_id::text || ':' || lower(public.sanitize_repo_name_component(r.name)));
    exception
      when others then
        v_unnameable := v_unnameable + 1;
    end;
  end loop;

  select coalesce(count(*), 0), coalesce(sum(k.n), 0)
    into v_collision_clusters, v_colliding_names
    from (
      select count(*) as n
        from unnest(v_keys) as sanitized_key
       group by sanitized_key
      having count(*) > 1
    ) k;

  if v_unnameable > 0 then
    raise warning 'assignment_groups audit: % existing group name(s) do not sanitize to a usable repo-name component. They are grandfathered; renaming one now requires a valid name.', v_unnameable;
  end if;
  if v_collision_clusters > 0 then
    raise warning 'assignment_groups audit: % existing group name(s), in % collision set(s), normalize to the same repo-name component as a sibling group in the same assignment. They are grandfathered; only one group per set can hold the derived repository.', v_colliding_names, v_collision_clusters;
  end if;
exception
  when others then
    raise warning 'assignment_groups audit skipped: %', sqlerrm;
end;
$$;

-- ============================================================================
-- 10. Sanitize the group-name component in publish_assignment_group_changes
-- ============================================================================
--
-- The last SQL site that assembled a repo name out of a RAW group name. It builds
-- `<class_slug>-<assignment_slug>-group-<group name>` when it enqueues creation for a
-- group an instructor just published, and with no whole-name net left (section 1) that
-- concatenation is the one place SQL can still derive a name TypeScript never would: a
-- group named `Team--One` gives `-group-Team--One` here and `-group-Team-One` in
-- github-user-sync and in create_all_repos_for_assignment_internal. The repository row
-- then holds a name no GitHub repo has, permission sync misses, and the reconciler
-- re-enqueues it forever -- the failure mode this migration is about, arriving through
-- the one door left open.
--
-- The fix is one component, not the assembled name: wrap v_group_name in
-- sanitize_repo_name_component(), exactly as section 3 does in
-- create_all_repos_for_assignment_internal(). Everything around it -- the class and
-- assignment slugs -- stays byte-for-byte, because TypeScript leaves them alone too.
--
-- The body below is the live 20260624000000 definition re-emitted verbatim, with that
-- single expression changed and nothing else touched. It is copied rather than patched
-- because Postgres has no way to edit one expression of a function in place; when this
-- function is next revised, that revision supersedes this copy and must carry the
-- sanitize forward. The trigger in section 9 is the backstop that keeps the group name
-- itself derivable, but it cannot make this site agree with TypeScript -- only
-- sanitizing here can.
create or replace function public.publish_assignment_group_changes(
    p_class_id       bigint,
    p_assignment_id  bigint,
    p_groups_to_create jsonb default '[]'::jsonb,
    p_moves_to_fulfill jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_caller_profile_id uuid;
    v_course_slug       text;
    v_github_org        text;
    v_template_repo     text;
    v_latest_sha        text;
    v_assignment_slug   text;

    v_repo_mode            public.assignment_repo_mode;
    v_source_assignment_id bigint;
    v_branch_protection    jsonb;
    v_creation_method      text;
    v_group_source_repo    text;

    v_group             jsonb;
    v_move              jsonb;
    v_group_name        text;
    v_new_group_id      bigint;
    v_member_id         uuid;
    v_member_ids        jsonb;

    v_old_gid           bigint;
    v_new_gid           bigint;
    v_profile_id        uuid;
    v_empty_gid         bigint;

    v_membership_id     bigint;
    v_repo_record       record;

    v_affected_groups   bigint[] := '{}';
    v_deleted_groups    bigint[] := '{}';
    -- empty groups we intentionally keep (they have submissions); excluded from
    -- the permission sync so their preserved repo's GitHub access is left as-is
    v_preserved_groups  bigint[] := '{}';

    v_groups_created    integer := 0;
    v_members_added     integer := 0;
    v_members_moved     integer := 0;
    v_groups_dissolved  integer := 0;
    v_syncs_enqueued    integer := 0;
    v_errors            jsonb[] := '{}';
begin
    -- auth
    if auth.uid() is null then
        raise exception 'Not authenticated';
    end if;
    if not exists (
        select 1 from public.user_privileges up
        where up.user_id = auth.uid()
          and (up.role = 'admin' or (up.class_id = p_class_id and up.role = 'instructor'))
    ) then
        raise exception 'Only instructors can publish group changes';
    end if;

    select private_profile_id into v_caller_profile_id
    from public.user_roles
    where user_id = auth.uid()
      and class_id = p_class_id
      and role = 'instructor'
    limit 1;

    -- class + assignment metadata (one query), incl. repo_mode config
    select c.slug, c.github_org, a.slug, a.template_repo, a.latest_template_sha,
           a.repo_mode, a.source_assignment_id,
           jsonb_build_object(
             'blockForcePush', coalesce(a.protect_block_force_push, true),
             'requirePullRequest', coalesce(a.protect_require_pull_request, false),
             'requiredReviewers', coalesce(a.protect_required_reviewers, 0)
           )
    into   v_course_slug, v_github_org, v_assignment_slug, v_template_repo, v_latest_sha,
           v_repo_mode, v_source_assignment_id, v_branch_protection
    from   public.assignments a
    join   public.classes c on c.id = a.class_id
    where  a.id = p_assignment_id and a.class_id = p_class_id;

    if v_course_slug is null then
        raise exception 'Assignment % not found in class %', p_assignment_id, p_class_id;
    end if;

    -- Phase 1: process moves on existing groups
    for v_move in select * from jsonb_array_elements(p_moves_to_fulfill)
    loop
        v_profile_id := (v_move->>'profile_id')::uuid;
        v_old_gid    := (v_move->>'old_group_id')::bigint;
        v_new_gid    := (v_move->>'new_group_id')::bigint;

        begin
            if v_old_gid is not null and not exists (
                select 1 from public.assignment_groups
                where id = v_old_gid
                  and assignment_id = p_assignment_id
                  and class_id = p_class_id
            ) then
                v_errors := array_append(v_errors, jsonb_build_object(
                    'profile_id', v_profile_id,
                    'error', format('Group %s does not belong to assignment %s', v_old_gid, p_assignment_id)
                ));
                continue;
            end if;
            if v_new_gid is not null and not exists (
                select 1 from public.assignment_groups
                where id = v_new_gid
                  and assignment_id = p_assignment_id
                  and class_id = p_class_id
            ) then
                v_errors := array_append(v_errors, jsonb_build_object(
                    'profile_id', v_profile_id,
                    'error', format('Group %s does not belong to assignment %s', v_new_gid, p_assignment_id)
                ));
                continue;
            end if;

            if v_old_gid is not null then
                select id into v_membership_id
                from public.assignment_groups_members
                where assignment_group_id = v_old_gid
                  and profile_id = v_profile_id
                  and class_id = p_class_id;

                if v_membership_id is null then
                    v_errors := array_append(v_errors, jsonb_build_object(
                        'profile_id', v_profile_id,
                        'error', format('Student not in group %s', v_old_gid)
                    ));
                    continue;
                end if;

                delete from public.assignment_groups_members where id = v_membership_id;
                v_affected_groups := array_append(v_affected_groups, v_old_gid);
            end if;

            if v_new_gid is not null then
                if v_old_gid is null then
                    update public.submissions
                    set is_active = false
                    where assignment_id = p_assignment_id
                      and profile_id = v_profile_id;
                end if;

                insert into public.assignment_groups_members
                    (assignment_group_id, profile_id, assignment_id, class_id, added_by)
                values
                    (v_new_gid, v_profile_id, p_assignment_id, p_class_id, v_caller_profile_id);

                v_affected_groups := array_append(v_affected_groups, v_new_gid);
            end if;

            v_members_moved := v_members_moved + 1;

        exception when others then
            v_errors := array_append(v_errors, jsonb_build_object(
                'profile_id', v_profile_id,
                'error', SQLERRM
            ));
        end;
    end loop;

    -- Phase 2: create new groups and add their initial members
    for v_group in select * from jsonb_array_elements(p_groups_to_create)
    loop
        v_group_name := trim(v_group->>'name');
        v_member_ids := v_group->'member_ids';

        begin
            if v_group_name = '' or v_group_name is null then
                raise exception 'Group name cannot be empty';
            end if;
            if length(v_group_name) > 36 then
                raise exception 'Group name too long (max 36 chars)';
            end if;
            if v_group_name !~ '^[a-zA-Z0-9_-]+$' then
                raise exception 'Group name must be alphanumeric, hyphens, or underscores';
            end if;

            if exists (
                select 1 from public.assignment_groups
                where assignment_id = p_assignment_id and lower(name) = lower(v_group_name)
            ) then
                raise exception 'Group "%" already exists', v_group_name;
            end if;

            -- Resolve the creation strategy from repo_mode BEFORE creating the
            -- group, so a fork-mode group with no source repo is reported as an
            -- error without leaving a half-created group behind.
            v_creation_method := null;
            v_group_source_repo := null;
            if v_repo_mode not in ('none', 'no_submission') then
                if v_repo_mode = 'fork_from_prior_assignment' then
                    select r.repository into v_group_source_repo
                      from public.repositories r
                      join public.assignment_groups ag on ag.id = r.assignment_group_id
                     where r.assignment_id = v_source_assignment_id
                       and ag.name = v_group_name
                     limit 1;
                    if v_group_source_repo is null then
                        raise exception 'No source repository for group "%" on source assignment %', v_group_name, v_source_assignment_id;
                    end if;
                    v_creation_method := 'fork';
                elsif v_repo_mode = 'template_with_student_forks' then
                    v_group_source_repo := v_template_repo;
                    v_creation_method := 'fork';
                else  -- template_only_staff
                    v_group_source_repo := v_template_repo;
                    v_creation_method := 'template';
                end if;
            end if;

            insert into public.assignment_groups (name, assignment_id, class_id)
            values (v_group_name, p_assignment_id, p_class_id)
            returning id into v_new_group_id;

            v_groups_created := v_groups_created + 1;

            -- enqueue repo creation per repo_mode (empty usernames; permission sync below)
            if v_creation_method is not null
               and v_github_org is not null
               and (v_repo_mode = 'fork_from_prior_assignment'
                    or (v_template_repo is not null and v_template_repo != '')) then
                perform public.enqueue_github_create_repo(
                    p_class_id,
                    v_github_org,
                    v_course_slug || '-' || v_assignment_slug || '-group-' || public.sanitize_repo_name_component(v_group_name),
                    coalesce(v_template_repo, v_group_source_repo),
                    v_course_slug,
                    '{}'::text[],
                    false,
                    'batch-group-create-' || v_new_group_id::text,
                    p_assignment_id,
                    null::uuid,
                    v_new_group_id,
                    v_latest_sha,
                    v_creation_method,
                    v_group_source_repo,
                    v_branch_protection,
                    null
                );
            end if;

            if v_member_ids is not null and jsonb_array_length(v_member_ids) > 0 then
                for v_member_id in
                    select (value#>>'{}')::uuid from jsonb_array_elements(v_member_ids) as value
                loop
                    update public.submissions
                    set is_active = false
                    where assignment_id = p_assignment_id
                      and profile_id = v_member_id;

                    insert into public.assignment_groups_members
                        (assignment_group_id, profile_id, assignment_id, class_id, added_by)
                    values
                        (v_new_group_id, v_member_id, p_assignment_id, p_class_id, v_caller_profile_id);

                    v_members_added := v_members_added + 1;
                end loop;
            end if;

            v_affected_groups := array_append(v_affected_groups, v_new_group_id);

        exception when others then
            v_errors := array_append(v_errors, jsonb_build_object(
                'group_name', v_group_name,
                'error', SQLERRM
            ));
        end;
    end loop;

    -- Phase 2b: dissolve empty groups (batch-final state after moves + creates)
    for v_empty_gid in
        select ag.id
        from public.assignment_groups ag
        where ag.assignment_id = p_assignment_id
          and ag.class_id = p_class_id
          and not exists (
              select 1 from public.assignment_groups_members agm
              where agm.assignment_group_id = ag.id
          )
    loop
        -- Preserve groups that still have submissions. Their repo holds
        -- graded/active work and is referenced by submissions (repository_id and
        -- repository_check_run_id), so deleting it would violate those FKs and
        -- destroy history. Keep the group, repo, check runs, and submissions
        -- intact; only fully dissolve groups whose repos have no submissions.
        if exists (
            select 1 from public.submissions s
            where s.assignment_group_id = v_empty_gid
        ) or exists (
            select 1
            from public.submissions s
            join public.repositories r on r.id = s.repository_id
            where r.assignment_group_id = v_empty_gid
        ) then
            v_preserved_groups := array_append(v_preserved_groups, v_empty_gid);
            continue;
        end if;

        delete from public.assignment_group_invitations
        where assignment_group_id = v_empty_gid;
        delete from public.assignment_group_join_request
        where assignment_group_id = v_empty_gid;

        for v_repo_record in
            select r.id, r.repository
            from public.repositories r
            where r.assignment_group_id = v_empty_gid
              and r.repository is not null
              and position('/' in r.repository) > 0
        loop
            if v_github_org is not null then
                perform public.enqueue_github_archive_repo(
                    p_class_id,
                    v_github_org,
                    split_part(v_repo_record.repository, '/', 2),
                    'batch-dissolve-' || v_empty_gid::text
                );
            end if;
            delete from public.repository_check_runs where repository_id = v_repo_record.id;
            delete from public.repositories where id = v_repo_record.id;
        end loop;

        delete from public.assignment_groups where id = v_empty_gid;
        v_deleted_groups := array_append(v_deleted_groups, v_empty_gid);
        v_groups_dissolved := v_groups_dissolved + 1;
    end loop;

    -- Phase 3: enqueue ONE permission sync per affected repo
    -- Deduplicate and exclude dissolved + preserved groups.
    -- Enqueue the sync even for repos that aren't GitHub-ready yet: newly-created
    -- group repos are created via enqueue_github_create_repo with an EMPTY
    -- collaborator list, so this sync is the only path that grants member access.
    -- The async worker requeues sync_repo_permissions until is_github_ready=true
    -- (so it can't race create_repo), then applies the real member list. Skipping
    -- not-ready repos here would strand those members without GitHub access.
    for v_repo_record in
        select distinct r.id           as repo_id,
               r.repository,
               r.assignment_group_id,
               r.is_github_ready
        from   unnest(v_affected_groups) as gid(g)
        join   public.repositories r on r.assignment_group_id = gid.g
        where  not (gid.g = any(v_deleted_groups))
          and  not (gid.g = any(v_preserved_groups))
    loop
        begin
            declare
                v_usernames text[];
            begin
                select coalesce(array_remove(array_agg(u.github_username), null), '{}')
                into v_usernames
                from public.assignment_groups_members agm
                join public.user_roles ur on ur.private_profile_id = agm.profile_id
                join public.users u on u.user_id = ur.user_id
                where agm.assignment_group_id = v_repo_record.assignment_group_id
                  and ur.class_id = p_class_id
                  and ur.role = 'student'
                  and ur.github_org_confirmed = true
                  and u.github_username is not null
                  and u.github_username != '';

                if v_repo_record.repository is not null and position('/' in v_repo_record.repository) > 0 then
                    perform public.enqueue_github_sync_repo_permissions(
                        p_class_id,
                        v_github_org,
                        split_part(v_repo_record.repository, '/', 2),
                        v_course_slug,
                        coalesce(v_usernames, '{}'),
                        'batch-publish-' || p_assignment_id::text || '-g' || v_repo_record.assignment_group_id::text
                    );
                    v_syncs_enqueued := v_syncs_enqueued + 1;
                end if;
            end;
        exception when others then
            v_errors := array_append(v_errors, jsonb_build_object(
                'repository_id', v_repo_record.repo_id,
                'error', SQLERRM
            ));
        end;
    end loop;

    return jsonb_build_object(
        'groups_created',   v_groups_created,
        'members_added',    v_members_added,
        'members_moved',    v_members_moved,
        'groups_dissolved', v_groups_dissolved,
        'syncs_enqueued',   v_syncs_enqueued,
        'errors',           to_jsonb(v_errors)
    );
end;
$$;

revoke all on function public.publish_assignment_group_changes(bigint, bigint, jsonb, jsonb) from public;
grant execute on function public.publish_assignment_group_changes(bigint, bigint, jsonb, jsonb) to authenticated;
