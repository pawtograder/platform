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
-- Only the staff-branch role predicates change; the student branches already key off `!= 'student'`,
-- which correctly treats admin as non-student, so they are unchanged.
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
