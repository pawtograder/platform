-- Fix race condition: when a student joins the org, sync permissions for all their existing repos
-- Previously, only new repos were created but existing repos were not re-synced

-- Function to sync permissions for all existing repos a student should have access to
create or replace function public.sync_repo_permissions_for_student(
  p_user_id uuid,
  p_class_id integer
)
returns void
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
      where r.profile_id = v_profile_id
        and r.class_id = p_class_id
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
      where agm.profile_id = v_profile_id
        and r.class_id = p_class_id
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

-- Lock down the function
revoke all on function public.sync_repo_permissions_for_student(uuid, integer) from public;
grant execute on function public.sync_repo_permissions_for_student(uuid, integer) to postgres;
grant execute on function public.sync_repo_permissions_for_student(uuid, integer) to service_role;

-- Update the trigger function to also sync existing repo permissions when github_org_confirmed changes to true
CREATE OR REPLACE FUNCTION "public"."sync_github_teams_on_role_change"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  -- Handle INSERT: new role added
  if TG_OP = 'INSERT' then
    if NEW.role in ('instructor', 'grader') then
      perform public.sync_staff_github_team(NEW.class_id, NEW.user_id);
    elsif NEW.role = 'student' then
      perform public.sync_student_github_team(NEW.class_id, NEW.user_id);
      -- Also create repos for the student if github_org_confirmed is true
      if NEW.github_org_confirmed = true then
        perform public.create_repos_for_student(NEW.user_id, NEW.class_id);
      end if;
    end if;
    return NEW;
  end if;

  -- Handle UPDATE: role changed or github_org_confirmed changed
  if TG_OP = 'UPDATE' then
    -- If role changed to/from staff role or between staff roles
    if (OLD.role not in ('instructor', 'grader') and NEW.role in ('instructor', 'grader')) or
       (OLD.role in ('instructor', 'grader') and NEW.role not in ('instructor', 'grader')) or
       (OLD.role in ('instructor', 'grader') and NEW.role in ('instructor', 'grader') and OLD.role != NEW.role) then
      perform public.sync_staff_github_team(NEW.class_id, NEW.user_id);
    end if;

    -- If role changed to/from student role
    if (OLD.role != 'student' and NEW.role = 'student') or
       (OLD.role = 'student' and NEW.role != 'student') then
      perform public.sync_student_github_team(NEW.class_id, NEW.user_id);
    end if;

    -- NEW: If student role is reactivated or deactivated
    if NEW.role = 'student' and 
       OLD.disabled != NEW.disabled then
      perform public.sync_student_github_team(NEW.class_id, NEW.user_id);
    end if;

    -- Consolidated repo creation and permission sync logic
    declare
      should_create_repos boolean := false;
      should_sync_permissions boolean := false;
    begin
      should_create_repos := (
        NEW.role = 'student' and NEW.github_org_confirmed = true and (
          -- Condition 1: Role changed to student
          (OLD.role != 'student' and NEW.role = 'student') or
          -- Condition 2: github_org_confirmed changed to true for existing student
          (OLD.github_org_confirmed is distinct from NEW.github_org_confirmed) or
          -- Condition 3: Student role was reactivated
          (OLD.disabled = true and NEW.disabled = false)
        )
      );

      -- Also sync existing repo permissions when github_org_confirmed changes to true
      -- This handles the race condition where repos were created before the student joined the org
      should_sync_permissions := (
        NEW.role = 'student' and 
        NEW.github_org_confirmed = true and 
        (OLD.github_org_confirmed is distinct from NEW.github_org_confirmed)
      );

      if should_create_repos then
        perform public.create_repos_for_student(NEW.user_id, NEW.class_id);
      end if;

      if should_sync_permissions then
        perform public.sync_repo_permissions_for_student(NEW.user_id, NEW.class_id);
      end if;
    end;

    return NEW;
  end if;

  -- Handle DELETE: role removed
  if TG_OP = 'DELETE' then
    if OLD.role in ('instructor', 'grader') then
      perform public.sync_staff_github_team(OLD.class_id, OLD.user_id);
    elsif OLD.role = 'student' then
      perform public.sync_student_github_team(OLD.class_id, OLD.user_id);
    end if;
    return OLD;
  end if;

  return null;
end;
$$;
