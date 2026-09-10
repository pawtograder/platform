-- Stop the org-join permission sync from queueing work for archived assignments.
--
-- `sync_repo_permissions_for_student` fires from the user_roles trigger on the
-- github_org_confirmed false->true transition, and enqueues one sync per repository row the
-- student owns in that class. It has never filtered on the assignment: an archived assignment's
-- rows are still selected, still enqueued, and — if the instructor deleted the GitHub repos when
-- they abandoned the assignment — still 404.
--
-- What that cost in production (2026-09-09, neu-cs2100): sp26 assignments hw6 and lab6 were
-- replaced mid-term by hw6-real / lab6-real and their repos deleted by hand, leaving 192 rows
-- pointing at repos that no longer exist. Every student whose sp26 enrollment got re-confirmed
-- queued two doomed syncs, and each one burned the 93-second 404 retry ladder in
-- syncRepoPermissions and then opened the `neu-cs2100:sync_repo_permissions` circuit — throttling
-- that method for every other class in the org.
--
-- Archiving an assignment is the instructor's own signal that it is over. Honour it here: no repo
-- of an archived assignment needs its collaborators reconciled, whether or not the repo still
-- exists. The GitHubWrapper/worker change that ships with this migration handles the repos that
-- are missing for other reasons (deleted from a LIVE assignment, or left behind by an out-of-band
-- rename); this one keeps the queue from filling with work that was never worth doing.
--
-- Body is otherwise verbatim from 20260108100000_sync_repo_permissions_on_org_join.sql.
create or replace function public.sync_repo_permissions_for_student(
  p_user_id uuid,
  p_class_id integer
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_github_username text;
  v_course_slug text;
  v_github_org text;
  v_repo_record record;
  v_github_usernames text[];
  v_repo_name text;
  v_org_name text;
begin
  if p_user_id is null then
    raise warning 'sync_repo_permissions_for_student called with NULL user_id, skipping';
    return;
  end if;

  -- Get the user's GitHub username
  select github_username into v_github_username
  from public.users
  where user_id = p_user_id;

  if v_github_username is null or v_github_username = '' then
    raise warning 'User % has no GitHub username, skipping repo permission sync', p_user_id;
    return;
  end if;

  -- Get class information
  select slug, github_org into v_course_slug, v_github_org
  from public.classes
  where id = p_class_id;

  if v_github_org is null or v_github_org = '' then
    raise warning 'Class % has no GitHub org configured, skipping repo permission sync', p_class_id;
    return;
  end if;

  -- Get the user's profile for this class
  declare
    v_profile_id uuid;
  begin
    select private_profile_id into v_profile_id
    from public.user_roles
    where user_id = p_user_id
      and class_id = p_class_id
      and role = 'student';

    if v_profile_id is null then
      raise warning 'No profile found for user % in class %, skipping', p_user_id, p_class_id;
      return;
    end if;

    -- Sync permissions for individual repos belonging to this student
    for v_repo_record in
      select r.repository
      from public.repositories r
      join public.assignments a on a.id = r.assignment_id
      where r.profile_id = v_profile_id
        and r.class_id = p_class_id
        and a.archived_at is null
        and r.repository is not null
        and r.repository != ''
        and position('/' in r.repository) > 0
    loop
      v_org_name := split_part(v_repo_record.repository, '/', 1);
      v_repo_name := split_part(v_repo_record.repository, '/', 2);

      perform public.enqueue_github_sync_repo_permissions(
        p_class_id::bigint,
        v_org_name,
        v_repo_name,
        v_course_slug,
        array[v_github_username],
        'org-join-sync-' || p_user_id::text
      );
    end loop;

    -- Sync permissions for group repos the student is a member of
    for v_repo_record in
      select r.repository, r.assignment_group_id
      from public.assignment_groups_members agm
      join public.assignment_groups ag on ag.id = agm.assignment_group_id
      join public.repositories r on r.assignment_group_id = ag.id
      join public.assignments a on a.id = r.assignment_id
      where agm.profile_id = v_profile_id
        and r.class_id = p_class_id
        and a.archived_at is null
        and r.repository is not null
        and r.repository != ''
        and position('/' in r.repository) > 0
    loop
      v_org_name := split_part(v_repo_record.repository, '/', 1);
      v_repo_name := split_part(v_repo_record.repository, '/', 2);

      -- Get all group members' GitHub usernames
      select array_remove(array_agg(u.github_username), null)
      into v_github_usernames
      from public.assignment_groups_members agm
      join public.user_roles ur on ur.private_profile_id = agm.profile_id
      join public.users u on u.user_id = ur.user_id
      where agm.assignment_group_id = v_repo_record.assignment_group_id
        and ur.class_id = p_class_id
        and ur.role = 'student'
        and ur.github_org_confirmed = true
        and u.github_username is not null;

      if v_github_usernames is not null and array_length(v_github_usernames, 1) > 0 then
        perform public.enqueue_github_sync_repo_permissions(
          p_class_id::bigint,
          v_org_name,
          v_repo_name,
          v_course_slug,
          v_github_usernames,
          'org-join-sync-group-' || p_user_id::text
        );
      end if;
    end loop;
  end;
end;
$$;

-- Unchanged from the original definition; restated because CREATE OR REPLACE does not reset them
-- and a future reader should not have to go back two migrations to see what may call this.
revoke all on function public.sync_repo_permissions_for_student(uuid, integer) from public;
grant execute on function public.sync_repo_permissions_for_student(uuid, integer) to postgres;
grant execute on function public.sync_repo_permissions_for_student(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- The creation path needs the same exclusion, or archival is only half honoured.
-- ---------------------------------------------------------------------------
-- `sync_github_teams_on_role_change` fires BOTH functions on the same
-- github_org_confirmed false->true transition: create_repos_for_student first, then the permission
-- sync above (20260728010000_include_admin_in_staff_github_team_sync.sql:82-93). Filtering only
-- the rows that already exist therefore leaves a gap — for a released-but-archived assignment
-- whose repository row was deleted or never created, an org confirmation still enqueues a
-- create_repo job and manufactures fresh work for an assignment the instructor has retired. It
-- would then be a brand-new repo that nothing wants, and the permission-sync filter above would
-- (correctly) never touch it again.
--
-- Body is otherwise verbatim from the live definition, itself last set by
-- 20260530120200_assignment-repo-config.sql; the only change is the added `a.archived_at is null`
-- predicate in the assignment loop.
-- (generated from pg_get_functiondef; see the note above)
CREATE OR REPLACE FUNCTION public.create_repos_for_student(user_id uuid, class_id integer DEFAULT NULL::integer, p_force boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      if not exists (
        select 1 from public.user_privileges up
        where up.user_id = auth.uid()
          and (up.role = 'admin' or (up.class_id = v_class_id::bigint and up.role = 'instructor'))
      ) then
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
      and ur.private_profile_id is not null                  -- safety check for NULL profiles
      and ur.disabled = false                                -- skip disabled/dropped students
      and (v_class_id is null or c.id = v_class_id)
      and c.github_org is not null and c.github_org <> ''    -- skip classes with no GitHub org configured
      and a.release_date is not null and a.release_date <= now()  -- only create repos for released assignments
      and a.archived_at is null                              -- an archived assignment is over; do not create repos for it
      and a.repo_mode not in ('none', 'no_submission')
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
$function$;
