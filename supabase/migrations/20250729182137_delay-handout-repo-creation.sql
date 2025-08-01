CREATE OR REPLACE FUNCTION public.assignments_grader_config_auto_populate()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
    declare 
    rubric_id int;
    self_rubric_id int;
    begin
  
  INSERT INTO autograder (id, class_id, max_submissions_count, max_submissions_period_secs) VALUES (NEW.id, NEW.class_id, 5, 86400);
  INSERT INTO rubrics (name, class_id, assignment_id, review_round) VALUES ('Grading Rubric', NEW.class_id, NEW.id, 'grading-review') RETURNING id into rubric_id;
  INSERT INTO rubrics (name, class_id, assignment_id, review_round) VALUES ('Self-Review Rubric', NEW.class_id, NEW.id, 'self-review') RETURNING id into self_rubric_id;
  UPDATE assignments set grading_rubric_id=rubric_id WHERE id=NEW.id;
  UPDATE assignments set self_review_rubric_id=self_rubric_id WHERE id=NEW.id;
  RETURN NULL;
end;$function$
;

-- Function to sync staff GitHub team when staff roles or GitHub usernames change
CREATE OR REPLACE FUNCTION public.sync_staff_github_team(class_id integer)
RETURNS void
LANGUAGE plpgsql
AS $function$
BEGIN
  -- Check if class_id is NULL
  IF class_id IS NULL THEN
    RAISE WARNING 'sync_staff_github_team called with NULL class_id, skipping';
    RETURN;
  END IF;

  -- Authorization check: only instructors can manually call this function
  -- Note: This check is bypassed when called from triggers (system context)
  IF auth.uid() IS NOT NULL AND NOT public.authorizeforclassinstructor(class_id::bigint) THEN
    RAISE EXCEPTION 'Access denied: Only instructors can sync staff GitHub team for class %', class_id;
  END IF;

  RAISE NOTICE 'Syncing staff GitHub team for class_id: %', class_id;
  
  PERFORM public.call_edge_function_internal(
    '/functions/v1/autograder-sync-staff-team', 
    'POST', 
    '{"Content-type":"application/json","x-supabase-webhook-source":"autograder-sync-staff-team"}'::jsonb, 
    jsonb_build_object('course_id', class_id), 
    5000,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL
  );

END;
$function$;

-- Function to sync student GitHub team when student roles or GitHub usernames change
CREATE OR REPLACE FUNCTION public.sync_student_github_team(class_id integer)
RETURNS void
LANGUAGE plpgsql
AS $function$
BEGIN
  -- Check if class_id is NULL
  IF class_id IS NULL THEN
    RAISE WARNING 'sync_student_github_team called with NULL class_id, skipping';
    RETURN;
  END IF;

  -- Authorization check: only instructors can manually call this function
  -- Note: This check is bypassed when called from triggers (system context)
  IF auth.uid() IS NOT NULL AND NOT public.authorizeforclassinstructor(class_id::bigint) THEN
    RAISE EXCEPTION 'Access denied: Only instructors can sync student GitHub team for class %', class_id;
  END IF;

  RAISE NOTICE 'Syncing student GitHub team for class_id: %', class_id;
  
  PERFORM public.call_edge_function_internal(
    '/functions/v1/autograder-sync-student-team', 
    'POST', 
    '{"Content-type":"application/json","x-supabase-webhook-source":"autograder-sync-student-team"}'::jsonb, 
    jsonb_build_object('course_id', class_id), 
    5000,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL
  );

END;
$function$;

-- Secure the functions: revoke public access and grant to authenticated users only
REVOKE EXECUTE ON FUNCTION public.sync_staff_github_team(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_staff_github_team(integer) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.sync_student_github_team(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_student_github_team(integer) TO authenticated;

-- Trigger function for user_roles changes
CREATE OR REPLACE FUNCTION public.sync_github_teams_on_role_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
  -- Handle INSERT: new role added
  IF TG_OP = 'INSERT' THEN
    IF NEW.role IN ('instructor', 'grader') THEN
      PERFORM public.sync_staff_github_team(NEW.class_id);
    ELSIF NEW.role = 'student' THEN
      PERFORM public.sync_student_github_team(NEW.class_id);
    END IF;
    RETURN NEW;
  END IF;

  -- Handle UPDATE: role changed
  IF TG_OP = 'UPDATE' THEN
    -- If role changed to/from staff role or between staff roles
    IF (OLD.role NOT IN ('instructor', 'grader') AND NEW.role IN ('instructor', 'grader')) OR
       (OLD.role IN ('instructor', 'grader') AND NEW.role NOT IN ('instructor', 'grader')) OR
       (OLD.role IN ('instructor', 'grader') AND NEW.role IN ('instructor', 'grader') AND OLD.role != NEW.role) THEN
      PERFORM public.sync_staff_github_team(NEW.class_id);
    END IF;
    
    -- If role changed to/from student role
    IF (OLD.role != 'student' AND NEW.role = 'student') OR
       (OLD.role = 'student' AND NEW.role != 'student') THEN
      PERFORM public.sync_student_github_team(NEW.class_id);
    END IF;
    
    RETURN NEW;
  END IF;

  -- Handle DELETE: role removed
  IF TG_OP = 'DELETE' THEN
    IF OLD.role IN ('instructor', 'grader') THEN
      PERFORM public.sync_staff_github_team(OLD.class_id);
    ELSIF OLD.role = 'student' THEN
      PERFORM public.sync_student_github_team(OLD.class_id);
    END IF;
    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$function$;

-- Trigger function for github_username changes on users with any roles
CREATE OR REPLACE FUNCTION public.sync_github_teams_on_github_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  affected_class_id integer;
  affected_role text;
BEGIN
  -- Only trigger if github_username actually changed
  IF TG_OP = 'UPDATE' AND (OLD.github_username IS DISTINCT FROM NEW.github_username) THEN
    -- Find all classes where this user has any role and sync appropriate teams
    FOR affected_class_id, affected_role IN
      SELECT ur.class_id, ur.role
      FROM public.user_roles ur 
      WHERE ur.user_id = NEW.user_id
    LOOP
      IF affected_role IN ('instructor', 'grader') THEN
        PERFORM public.sync_staff_github_team(affected_class_id);
      ELSIF affected_role = 'student' THEN
        PERFORM public.sync_student_github_team(affected_class_id);
      END IF;
    END LOOP;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$function$;

-- Create trigger on user_roles table for role changes
CREATE OR REPLACE TRIGGER sync_github_teams_on_user_roles_change
  AFTER INSERT OR UPDATE OR DELETE ON public.user_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_github_teams_on_role_change();

-- Add github_org_confirmed column to user_roles table
ALTER TABLE public.user_roles ADD COLUMN github_org_confirmed boolean DEFAULT false;

-- Add invitation_date column to user_roles table
ALTER TABLE public.user_roles ADD COLUMN invitation_date timestamp with time zone;

-- Create trigger on users table for github_username changes
CREATE OR REPLACE TRIGGER sync_github_teams_on_users_github_change
  AFTER UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_github_teams_on_github_change();