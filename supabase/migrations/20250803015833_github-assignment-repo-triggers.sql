-- Function to create repos for a student when their GitHub identity changes or they get a new role
CREATE OR REPLACE FUNCTION public.create_repos_for_student(user_id uuid, class_id integer DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
  -- Check if user_id is NULL
  IF user_id IS NULL THEN
    RAISE WARNING 'create_repos_for_student called with NULL user_id, skipping';
    RETURN;
  END IF;

  RAISE NOTICE 'Creating repos for student with user_id: %, class_id: %', user_id, class_id;
  
  PERFORM public.call_edge_function_internal(
    '/functions/v1/autograder-create-repos-for-student', 
    'POST', 
    '{"Content-type":"application/json","x-supabase-webhook-source":"autograder-create-repos-for-student"}'::jsonb, 
    jsonb_build_object('user_id', user_id, 'class_id', class_id), 
    5000,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL
  );

END;
$function$;

-- Secure the function: only allow postgres (trigger context) to execute it
REVOKE EXECUTE ON FUNCTION public.create_repos_for_student(uuid, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_repos_for_student(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_repos_for_student(uuid, integer) TO postgres;

-- Update the existing trigger function for user_roles changes to also create repos for students
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
      -- Also create repos for the student if github_org_confirmed is true
      IF NEW.github_org_confirmed = true THEN
        PERFORM public.create_repos_for_student(NEW.user_id, NEW.class_id);
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- Handle UPDATE: role changed or github_org_confirmed changed
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
      -- Also create repos when role changes to student and github_org_confirmed is true
      IF NEW.role = 'student' AND NEW.github_org_confirmed = true THEN
        PERFORM public.create_repos_for_student(NEW.user_id, NEW.class_id);
      END IF;
    END IF;
    
    -- If github_org_confirmed changed to true for a student
    IF NEW.role = 'student' AND 
       (OLD.github_org_confirmed IS DISTINCT FROM NEW.github_org_confirmed) AND 
       NEW.github_org_confirmed = true THEN
      PERFORM public.create_repos_for_student(NEW.user_id, NEW.class_id);
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

-- Note: The existing triggers will automatically use the updated functions above
-- No new triggers need to be created since we're updating the existing ones 

-- Function to create all repos for an assignment when its release date has passed
CREATE OR REPLACE FUNCTION public.create_all_repos_for_assignment(course_id bigint, assignment_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
  -- Check if parameters are NULL
  IF course_id IS NULL OR assignment_id IS NULL THEN
    RAISE WARNING 'create_all_repos_for_assignment called with NULL parameters, skipping';
    RETURN;
  END IF;

  RAISE NOTICE 'Creating all repos for assignment with course_id: %, assignment_id: %', course_id, assignment_id;
  
  PERFORM public.call_edge_function_internal(
    '/functions/v1/assignment-create-all-repos', 
    'POST', 
    '{"Content-type":"application/json","x-supabase-webhook-source":"assignment-create-all-repos"}'::jsonb, 
    jsonb_build_object('courseId', course_id, 'assignmentId', assignment_id), 
    10000, -- Longer timeout since this creates multiple repos
    NULL,
    NULL,
    NULL,
    NULL,
    NULL
  );

END;
$function$;

-- Secure the function: only allow postgres (cron job) to execute it
REVOKE EXECUTE ON FUNCTION public.create_all_repos_for_assignment(bigint, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_all_repos_for_assignment(bigint, bigint) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_all_repos_for_assignment(bigint, bigint) TO postgres;

-- Function to check for assignments that just passed their release date
CREATE OR REPLACE FUNCTION public.check_assignment_release_dates()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  assignment_record RECORD;
  now_time_utc timestamp with time zone;
BEGIN
  -- Get current time in UTC for consistent timezone handling
  now_time_utc := NOW() AT TIME ZONE 'UTC';
  
  RAISE NOTICE 'Checking for assignments that just passed their release date at % (UTC)', now_time_utc;
  
  -- Find assignments that have a release_date that just passed (within the last minute)
  -- Use explicit timezone conversion to UTC for consistent comparison
  FOR assignment_record IN
    SELECT 
      a.id as assignment_id,
      a.class_id as course_id,
      a.release_date,
      c.time_zone,
      c.slug as class_slug,
      a.slug as assignment_slug
    FROM assignments a
    JOIN classes c ON a.class_id = c.id
    WHERE a.release_date IS NOT NULL
      AND a.release_date AT TIME ZONE 'UTC' <= now_time_utc
      AND a.release_date AT TIME ZONE 'UTC' > now_time_utc - INTERVAL '1 minute'
      AND a.template_repo IS NOT NULL
      AND a.template_repo != ''
  LOOP
    RAISE NOTICE 'Found assignment that just passed release date: % (class: %, assignment: %, release_date UTC: %)', 
      assignment_record.assignment_id, 
      assignment_record.class_slug, 
      assignment_record.assignment_slug,
      assignment_record.release_date AT TIME ZONE 'UTC';
    
    -- Call the edge function to create all repos for this assignment
    PERFORM public.create_all_repos_for_assignment(
      assignment_record.course_id, 
      assignment_record.assignment_id
    );
  END LOOP;
  
  RAISE NOTICE 'Finished checking assignment release dates';
END;
$function$;

-- Secure the function: only allow postgres (cron job) to execute it
REVOKE EXECUTE ON FUNCTION public.check_assignment_release_dates() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_assignment_release_dates() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.check_assignment_release_dates() TO postgres;

-- Trigger function to check if assignments need repos created (INSERT/UPDATE)
CREATE OR REPLACE FUNCTION public.check_assignment_for_repo_creation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  now_time_utc timestamp with time zone;
  should_create_repos boolean := false;
BEGIN
  -- Get current time in UTC for consistent timezone handling
  now_time_utc := NOW() AT TIME ZONE 'UTC';
  
  -- Handle INSERT: check if assignment has past release date
  IF TG_OP = 'INSERT' THEN
    IF NEW.release_date IS NOT NULL 
       AND NEW.release_date AT TIME ZONE 'UTC' <= now_time_utc - INTERVAL '1 minute'
       AND NEW.template_repo IS NOT NULL
       AND NEW.template_repo != '' THEN
      
      should_create_repos := true;
      RAISE NOTICE 'New assignment inserted with past release date: assignment_id=%, class_id=%, release_date=% (UTC: %)', 
        NEW.id, NEW.class_id, NEW.release_date, NEW.release_date AT TIME ZONE 'UTC';
    END IF;
    
  -- Handle UPDATE: check if release date changed from future/recent to past
  ELSIF TG_OP = 'UPDATE' THEN
    -- Check if the release_date changed and now qualifies for repo creation
    IF NEW.release_date IS NOT NULL 
       AND NEW.release_date AT TIME ZONE 'UTC' <= now_time_utc - INTERVAL '1 minute'
       AND NEW.template_repo IS NOT NULL
       AND NEW.template_repo != '' 
       AND NEW.release_date != OLD.release_date THEN
      
      -- Only create repos if the OLD release_date was either:
      -- 1. NULL (no previous release date)
      -- 2. In the future 
      -- 3. Within the last minute (hasn't had repos created yet)
      IF OLD.release_date IS NULL 
         OR OLD.release_date AT TIME ZONE 'UTC' > now_time_utc
         OR OLD.release_date AT TIME ZONE 'UTC' > now_time_utc - INTERVAL '1 minute' THEN
        
        should_create_repos := true;
        RAISE NOTICE 'Assignment updated with past release date: assignment_id=%, class_id=%, old_release_date=% (UTC: %), new_release_date=% (UTC: %)', 
          NEW.id, NEW.class_id, 
          OLD.release_date, OLD.release_date AT TIME ZONE 'UTC',
          NEW.release_date, NEW.release_date AT TIME ZONE 'UTC';
      END IF;
    END IF;
  END IF;

  -- Create repos if needed
  IF should_create_repos THEN
    PERFORM public.create_all_repos_for_assignment(NEW.class_id, NEW.id);
  END IF;

  RETURN NEW;
END;
$function$;

-- Secure the function: only allow postgres (trigger context) to execute it
REVOKE EXECUTE ON FUNCTION public.check_assignment_for_repo_creation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_assignment_for_repo_creation() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.check_assignment_for_repo_creation() TO postgres;

-- Create trigger to check assignments on INSERT and UPDATE
-- Drop both old and new trigger names to ensure clean state
DROP TRIGGER IF EXISTS trigger_check_new_assignment_for_repo_creation ON assignments;
DROP TRIGGER IF EXISTS trigger_check_assignment_for_repo_creation ON assignments;
CREATE TRIGGER trigger_check_assignment_for_repo_creation
  AFTER INSERT OR UPDATE ON assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.check_assignment_for_repo_creation();

-- Schedule the job to run every minute
-- Note: This will replace any existing job with the same name
SELECT cron.schedule(
  'check-assignment-release-dates',
  '* * * * *', -- Every minute
  'SELECT public.check_assignment_release_dates();'
);