-- Stop the org-join permission sync from queueing work for a repo in another GitHub org.
--
-- `sync_repo_permissions_for_student` enqueues one sync per repository row the student owns in
-- the class, taking the org straight off the row: `split_part(r.repository, '/', 1)`. Nothing has
-- ever required that org to be the CLASS's org. It has to be. The GitHub App is installed per
-- organization, so getOctoKit cannot mint a token for a repo in an org the class does not own,
-- and the sync is not merely likely to fail, it can never succeed. Retrying it is pure cost.
--
-- WHAT THAT COST IN PRODUCTION (2026-09-11). E2E tests have been leaving repository rows in the
-- production database that name a placeholder org: 10,613 rows under `not-actually` across 89
-- `pawtograder-playground` classes, plus 42 under `autograder-dev` and 2 under `e2e`. At 01:23
-- the new github-membership-reconciler (20260909140000) confirmed one fixture user's org
-- membership in playground classes 572 and 573. That github_org_confirmed false->true transition
-- fired this function, which duly enqueued a sync for every repository row the user owned,
-- including rows shaped like `not-actually/repository-e2e-2026-05-28#n9z6--4`.
--
-- Thirty-two of those dead-lettered at retry_count 5 between 01:25:54 and 01:38:57, each having
-- burned the full retry ladder first, and together they opened the
-- `not-actually:sync_repo_permissions` circuit breaker until 09:30. The worker then did the right
-- thing with four more and deferred them to vt = 09:30 to wait the breaker out, which would have
-- held pawtograder_queue_oldest_message_seconds above the 1200s PawtograderQueueOldestMessageAging
-- threshold for eight hours overnight. They were archived by hand.
--
-- WHY THE CLASS-LEVEL FIX WAS NOT ENOUGH. Those fixture classes have since been taken out of the
-- reconciler's invite window by backdating their end_date, so the reconciler will not confirm
-- anyone there again. But the reconciler was never the only trigger for this cascade. A student
-- pressing "Sync GitHub Account" and a membership webhook both flip the same column on the same
-- rows, and the 10,613 rows are still there. The filter belongs next to the enqueue, where every
-- trigger passes through, rather than in the one caller that happened to expose it.
--
-- WHY THERE IS NO NULL BRANCH. A class with no github_org never reaches either loop: the function
-- already returns early, with a warning, when v_github_org is null or empty. By the time the
-- predicate below is evaluated v_github_org is a non-empty org name, so comparing against it
-- changes nothing for those classes. They enqueue no syncs today and will enqueue none after this.
--
-- Both loops get the filter. A group repo in a foreign org is exactly as unsyncable as an
-- individual one, and the group loop reads its org from the same column.
--
-- Body is otherwise verbatim from 20260909170000_org_join_sync_skips_archived_assignments.sql;
-- the only change is the added split_part predicate in each of the two loops.
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
        and split_part(r.repository, '/', 1) = v_github_org
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
        and split_part(r.repository, '/', 1) = v_github_org
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
