-- Add auto-check repos functionality when student role is reactivated
-- This migration updates the sync_github_teams_on_role_change function to also
-- call create_repos_for_student when a student role is reactivated (disabled changes from true to false)

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
      -- Also create repos when role changes to student and github_org_confirmed is true
      if NEW.role = 'student' and NEW.github_org_confirmed = true then
        perform public.create_repos_for_student(NEW.user_id, NEW.class_id);
      end if;
    end if;

    -- If github_org_confirmed changed to true for a student
    if NEW.role = 'student' and 
       (OLD.github_org_confirmed is distinct from NEW.github_org_confirmed) and 
       NEW.github_org_confirmed = true then
      perform public.create_repos_for_student(NEW.user_id, NEW.class_id);
    end if;

    -- NEW: If student role is reactivated (disabled changes from true to false)
    if NEW.role = 'student' and 
       OLD.disabled = true and 
       NEW.disabled = false then
      perform public.sync_student_github_team(NEW.class_id, NEW.user_id);
      -- Create repos for the reactivated student if github_org_confirmed is true
      if NEW.github_org_confirmed = true then
        perform public.create_repos_for_student(NEW.user_id, NEW.class_id);
      end if;
    end if;

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
