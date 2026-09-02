-- Include `admin` in GitHub staff-team reconciliation.
--
-- "Staff" for GitHub org/team purposes means every non-student role: admin, instructor, grader.
-- 20260623000000_allow_admin_github_team_sync.sql already widened the authorization guard on
-- sync_staff_github_team so an admin MAY trigger a staff-team sync, but the role-change trigger that
-- actually ENQUEUES the sync still only matched ('instructor','grader') — so a class-scoped `admin`
-- role was never added to (or removed from) the GitHub staff team, and the two ends disagreed.
-- Finish that change here by teaching the trigger that admin is a staff role. (The matching edge
-- functions that build the staff username list / write github_org_confirmed are updated alongside.)
--
-- The staff-branch role predicates now match ('instructor','grader','admin'); the student branches
-- already key off `!= 'student'`, which correctly treats admin as non-student, so they are unchanged.
-- This revision also adds a staff disable/enable branch: previously only student disable/enable
-- resynced the team, so disabling a staff member left them on the GitHub staff team. The desired-
-- member fetchers in the edge functions gain a matching `disabled = false` filter.
CREATE OR REPLACE FUNCTION "public"."sync_github_teams_on_role_change"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  -- Handle INSERT: new role added
  if TG_OP = 'INSERT' then
    if NEW.role in ('instructor', 'grader', 'admin') then
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
    if (OLD.role not in ('instructor', 'grader', 'admin') and NEW.role in ('instructor', 'grader', 'admin')) or
       (OLD.role in ('instructor', 'grader', 'admin') and NEW.role not in ('instructor', 'grader', 'admin')) or
       (OLD.role in ('instructor', 'grader', 'admin') and NEW.role in ('instructor', 'grader', 'admin') and OLD.role != NEW.role) then
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

    -- If a staff role is reactivated or deactivated, resync the staff team so a disabled staff
    -- member is removed from the GitHub staff team (and a re-enabled one is re-added). Previously
    -- only student disable/enable was handled, so disabling a staff member left them on the team.
    if NEW.role in ('instructor', 'grader', 'admin') and
       OLD.disabled != NEW.disabled then
      perform public.sync_staff_github_team(NEW.class_id, NEW.user_id);
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
    if OLD.role in ('instructor', 'grader', 'admin') then
      perform public.sync_staff_github_team(OLD.class_id, OLD.user_id);
    elsif OLD.role = 'student' then
      perform public.sync_student_github_team(OLD.class_id, OLD.user_id);
    end if;
    return OLD;
  end if;

  return null;
end;
$$;

-- Let trigger-initiated syncs skip the caller re-authorization.
--
-- sync_staff/student_github_team re-check auth.uid() so DIRECT RPC callers must be instructor/admin.
-- But this trigger fires AFTER the user_roles mutation has already been authorized (RLS /
-- admin_set_user_role_disabled / the enrollment functions), and the mutation can leave the caller
-- without the very role being checked — e.g. an admin disabling their own last admin role. The
-- post-mutation re-auth then fails and rolls the whole operation back. Skip the re-auth when running
-- inside a trigger (pg_trigger_depth() > 0); direct RPC calls (depth 0) are still authorized as
-- before. This also covers the analogous self-mutation cases on the DELETE / role-change branches.
create or replace function public.sync_staff_github_team(class_id integer, user_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slug text;
  v_org text;
begin
  if class_id is null then
    raise warning 'sync_staff_github_team called with NULL class_id, skipping';
    return;
  end if;
  if auth.uid() is not null
     and pg_trigger_depth() = 0
     and not (public.authorizeforclassinstructor(class_id::bigint) or public.authorize_for_admin()) then
    raise exception 'Access denied: Only instructors or admins can sync staff GitHub team for class %', class_id;
  end if;
  select slug, github_org into v_slug, v_org from public.classes where id = class_id;
  if v_slug is null or v_org is null then
    -- Class isn't GitHub-configured; nothing to sync. Do NOT raise -- this runs
    -- from a user_roles trigger and would otherwise block the enrollment.
    raise warning 'Skipping staff GitHub team sync for class %: missing org/slug', class_id;
    return;
  end if;
  perform public.enqueue_github_sync_staff_team(class_id::bigint, v_org, v_slug, user_id, null);
end;
$$;

create or replace function public.sync_student_github_team(class_id integer, user_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slug text;
  v_org text;
begin
  if class_id is null then
    raise warning 'sync_student_github_team called with NULL class_id, skipping';
    return;
  end if;
  if auth.uid() is not null
     and pg_trigger_depth() = 0
     and not (public.authorizeforclassinstructor(class_id::bigint) or public.authorize_for_admin()) then
    raise exception 'Access denied: Only instructors or admins can sync student GitHub team for class %', class_id;
  end if;
  select slug, github_org into v_slug, v_org from public.classes where id = class_id;
  if v_slug is null or v_org is null then
    raise warning 'Skipping student GitHub team sync for class %: missing org/slug', class_id;
    return;
  end if;
  perform public.enqueue_github_sync_student_team(class_id::bigint, v_org, v_slug, user_id, null);
end;
$$;
