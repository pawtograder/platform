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
    end if;

    -- NEW: If student role is reactivated (disabled changes from true to false)
    if NEW.role = 'student' and 
       OLD.disabled = true and 
       NEW.disabled = false then
      perform public.sync_student_github_team(NEW.class_id, NEW.user_id);
    end if;

    -- Consolidated repo creation logic: create repos if any of these conditions are true:
    -- 1. Role changed to student AND github_org_confirmed is true
    -- 2. Role is student AND github_org_confirmed changed to true
    -- 3. Student role was reactivated AND github_org_confirmed is true
    declare
      should_create_repos boolean := false;
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

      if should_create_repos then
        perform public.create_repos_for_student(NEW.user_id, NEW.class_id);
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
