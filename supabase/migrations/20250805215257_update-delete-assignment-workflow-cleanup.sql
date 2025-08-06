-- Migration to update delete_assignment_with_all_data function
-- to also delete workflow_events and workflow_run_error records that reference repository_id
-- before deleting repositories

-- Drop the existing function
DROP FUNCTION IF EXISTS public.delete_assignment_with_all_data(bigint, bigint);

-- Recreate the function with workflow cleanup
CREATE OR REPLACE FUNCTION public.delete_assignment_with_all_data(
    p_assignment_id bigint,
    p_class_id bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_assignment_title text;
    v_assignment_group_ids bigint[];
    v_gradebook_column_id bigint;
    v_result jsonb;
BEGIN
    -- This function can only be called by the postgres service role
    -- Authorization is handled by the calling application
    
    -- Check if assignment exists and belongs to the specified class
    SELECT title INTO v_assignment_title
    FROM public.assignments
    WHERE id = p_assignment_id AND class_id = p_class_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Assignment not found or does not belong to this class'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;
    
    -- Check for released submission reviews (safety check)
    IF EXISTS (
        SELECT 1 FROM public.submission_reviews sr
        JOIN public.submissions s ON sr.submission_id = s.id
        WHERE s.assignment_id = p_assignment_id AND sr.released = true
    ) THEN
        RAISE EXCEPTION 'Cannot delete assignment: This assignment has released submission reviews. Delete cannot proceed.'
            USING ERRCODE = 'check_violation';
    END IF;
    
    -- Get assignment group IDs for this assignment
    SELECT array_agg(id) INTO v_assignment_group_ids
    FROM public.assignment_groups
    WHERE assignment_id = p_assignment_id;
    
    -- Get the gradebook column ID for this assignment
    SELECT gradebook_column_id INTO v_gradebook_column_id
    FROM public.assignments
    WHERE id = p_assignment_id;
    
    -- Start transaction
    BEGIN
        -- Remove gradebook column dependencies first (if this assignment has a gradebook column)
        IF v_gradebook_column_id IS NOT NULL THEN
            UPDATE public.gradebook_columns
            SET dependencies = array_remove(dependencies, v_gradebook_column_id)
            WHERE class_id = p_class_id 
              AND id != v_gradebook_column_id
              AND dependencies IS NOT NULL;
        END IF;
        
        -- Delete in order to respect foreign key constraints
        
        -- Delete submission-related data that requires joins (in order of dependencies)
        
        -- Delete submission regrade request comments
        DELETE FROM public.submission_regrade_request_comments srrc
        USING public.submission_regrade_requests srr
        WHERE srrc.submission_regrade_request_id = srr.id AND srr.assignment_id = p_assignment_id;
        
        -- Handle circular FK constraints: clear regrade_request_id references first
        UPDATE public.submission_comments 
        SET regrade_request_id = NULL 
        WHERE regrade_request_id IN (
            SELECT id FROM public.submission_regrade_requests WHERE assignment_id = p_assignment_id
        );
        
        UPDATE public.submission_file_comments 
        SET regrade_request_id = NULL 
        WHERE regrade_request_id IN (
            SELECT id FROM public.submission_regrade_requests WHERE assignment_id = p_assignment_id
        );
        
        UPDATE public.submission_artifact_comments 
        SET regrade_request_id = NULL 
        WHERE regrade_request_id IN (
            SELECT id FROM public.submission_regrade_requests WHERE assignment_id = p_assignment_id
        );
        
        -- Delete submission regrade requests (now safe after clearing circular FK)
        DELETE FROM public.submission_regrade_requests WHERE assignment_id = p_assignment_id;
        
        -- Delete submission artifact comments first (before submission artifacts)
        DELETE FROM public.submission_artifact_comments sac
        USING public.submission_artifacts sa
        JOIN public.submissions s ON sa.submission_id = s.id
        WHERE sac.submission_artifact_id = sa.id AND s.assignment_id = p_assignment_id;
        
        -- Delete submission artifacts (before submission files due to FK constraint)
        DELETE FROM public.submission_artifacts sa
        USING public.submissions s
        WHERE sa.submission_id = s.id AND s.assignment_id = p_assignment_id;
        
        -- Delete submission file comments
        DELETE FROM public.submission_file_comments sfc
        USING public.submission_files sf
        JOIN public.submissions s ON sf.submission_id = s.id
        WHERE sfc.submission_file_id = sf.id AND s.assignment_id = p_assignment_id;
        
        -- Delete submission files
        DELETE FROM public.submission_files sf
        USING public.submissions s
        WHERE sf.submission_id = s.id AND s.assignment_id = p_assignment_id;
        
        -- Delete submission comments (only those that don't reference regrade requests)
        DELETE FROM public.submission_comments sc
        USING public.submissions s
        WHERE sc.submission_id = s.id AND s.assignment_id = p_assignment_id
          AND sc.regrade_request_id IS NULL;
        
        -- Delete grader result test output first (before grader result tests)
        DELETE FROM public.grader_result_test_output grto
        USING public.grader_result_tests grt
        JOIN public.grader_results gr ON grt.grader_result_id = gr.id
        JOIN public.submissions s ON gr.submission_id = s.id
        WHERE grto.grader_result_test_id = grt.id AND s.assignment_id = p_assignment_id;
        
        -- Delete grader result tests (before grader results)
        DELETE FROM public.grader_result_tests grt
        USING public.grader_results gr
        JOIN public.submissions s ON gr.submission_id = s.id
        WHERE grt.grader_result_id = gr.id AND s.assignment_id = p_assignment_id;
        
        -- Delete grader result output (before grader results)
        DELETE FROM public.grader_result_output gro
        USING public.grader_results gr
        JOIN public.submissions s ON gr.submission_id = s.id
        WHERE gro.grader_result_id = gr.id AND s.assignment_id = p_assignment_id;
        
        -- Delete grader results
        DELETE FROM public.grader_results gr
        USING public.submissions s
        WHERE gr.submission_id = s.id AND s.assignment_id = p_assignment_id;
        
        -- Clear grading_review_id references before deleting submission reviews
        UPDATE public.submissions 
        SET grading_review_id = NULL 
        WHERE assignment_id = p_assignment_id AND grading_review_id IS NOT NULL;
        
        -- Delete review assignments (before submission reviews due to FK constraint)
        DELETE FROM public.review_assignments WHERE assignment_id = p_assignment_id;
        
        -- Delete submission reviews
        DELETE FROM public.submission_reviews sr
        USING public.submissions s
        WHERE sr.submission_id = s.id AND s.assignment_id = p_assignment_id;
        
        -- Delete submissions
        DELETE FROM public.submissions WHERE assignment_id = p_assignment_id;
        
        -- Delete repository check runs (before repositories due to FK constraint)
        DELETE FROM public.repository_check_runs rcr
        USING public.repositories r
        WHERE rcr.repository_id = r.id AND r.assignment_id = p_assignment_id;
        
        -- Delete workflow events that reference repositories for this assignment
        DELETE FROM public.workflow_events we
        USING public.repositories r
        WHERE we.repository_id = r.id AND r.assignment_id = p_assignment_id;
        
        -- Delete workflow run errors that reference repositories for this assignment
        DELETE FROM public.workflow_run_error wre
        USING public.repositories r
        WHERE wre.repository_id = r.id AND r.assignment_id = p_assignment_id;
        
        -- Delete repositories
        DELETE FROM public.repositories WHERE assignment_id = p_assignment_id;
        
        -- Delete assignment group members
        DELETE FROM public.assignment_groups_members WHERE assignment_id = p_assignment_id;
        
        -- Delete assignment group invitations for this assignment's groups
        IF v_assignment_group_ids IS NOT NULL AND array_length(v_assignment_group_ids, 1) > 0 THEN
            DELETE FROM public.assignment_group_invitations 
            WHERE assignment_group_id = ANY(v_assignment_group_ids);
        END IF;
        
        -- Delete assignment group join requests
        DELETE FROM public.assignment_group_join_request WHERE assignment_id = p_assignment_id;
        
        -- Delete assignment groups
        DELETE FROM public.assignment_groups WHERE assignment_id = p_assignment_id;
        
        -- Delete due date exceptions
        DELETE FROM public.assignment_due_date_exceptions WHERE assignment_id = p_assignment_id;
        
        -- Clear rubric references in assignments before deleting rubrics
        UPDATE public.assignments 
        SET grading_rubric_id = NULL,
            meta_grading_rubric_id = NULL,
            self_review_rubric_id = NULL
        WHERE id = p_assignment_id AND (
            grading_rubric_id IS NOT NULL OR 
            meta_grading_rubric_id IS NOT NULL OR 
            self_review_rubric_id IS NOT NULL
        );
        
        -- Delete rubric-related data (in dependency order)
        -- Delete rubric checks
        DELETE FROM public.rubric_checks rc
        USING public.rubric_criteria rcrit
        JOIN public.rubric_parts rp ON rcrit.rubric_part_id = rp.id
        JOIN public.rubrics r ON rp.rubric_id = r.id
        WHERE rc.rubric_criteria_id = rcrit.id AND r.assignment_id = p_assignment_id;
        
        -- Delete rubric criteria
        DELETE FROM public.rubric_criteria rcrit
        USING public.rubric_parts rp
        JOIN public.rubrics r ON rp.rubric_id = r.id
        WHERE rcrit.rubric_part_id = rp.id AND r.assignment_id = p_assignment_id;
        
        -- Delete rubric parts
        DELETE FROM public.rubric_parts rp
        USING public.rubrics r
        WHERE rp.rubric_id = r.id AND r.assignment_id = p_assignment_id;
        
        -- Delete rubrics
        DELETE FROM public.rubrics WHERE assignment_id = p_assignment_id;
        
        -- Delete assignment handout commits (before assignment due to FK constraint)
        DELETE FROM public.assignment_handout_commits WHERE assignment_id = p_assignment_id;
        
        -- Delete autograder commits (before autograder due to FK constraint)
        DELETE FROM public.autograder_commits ac
        USING public.autograder a
        WHERE ac.autograder_id = a.id AND a.id = p_assignment_id;
        
        -- Delete autograder regression tests (before autograder due to FK constraint)
        DELETE FROM public.autograder_regression_test art
        USING public.autograder a
        WHERE art.autograder_id = a.id AND a.id = p_assignment_id;
        
        -- Delete autograder if exists
        DELETE FROM public.autograder WHERE id = p_assignment_id;
        
        -- Delete gradebook column (using the assignment's gradebook_column_id)
        DELETE FROM public.gradebook_columns 
        WHERE id = (SELECT gradebook_column_id FROM public.assignments WHERE id = p_assignment_id);
        
        -- Finally, delete the assignment itself
        DELETE FROM public.assignments 
        WHERE id = p_assignment_id AND class_id = p_class_id;
        
        -- Return success result
        v_result := jsonb_build_object(
            'success', true,
            'message', format('Assignment "%s" has been successfully deleted along with all related data.', v_assignment_title),
            'assignment_id', p_assignment_id,
            'class_id', p_class_id
        );
        
        RETURN v_result;
        
    EXCEPTION
        WHEN OTHERS THEN
            -- Rollback transaction
            RAISE;
    END;
END;
$function$;

-- Grant execute permission only to postgres role (service role)
GRANT EXECUTE ON FUNCTION public.delete_assignment_with_all_data(bigint, bigint) TO postgres;

-- Add comment for documentation
COMMENT ON FUNCTION public.delete_assignment_with_all_data(bigint, bigint) IS 'Deletes an assignment and all its associated data. Performs safety checks and handles all related tables in the correct order. Now includes cleanup of workflow_events and workflow_run_error records. Only callable by postgres service role.';

-- Update the assignment repo creation trigger function to handle template repo addition
-- Drop the existing function
DROP FUNCTION IF EXISTS public.check_assignment_for_repo_creation();

-- Recreate the function with improved logic for template repo changes
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
    
  -- Handle UPDATE: check if release date changed from future/recent to past OR template repo was added
  ELSIF TG_OP = 'UPDATE' THEN
    -- Case 1: Release date changed and now qualifies for repo creation
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
    
    -- Case 2: Template repo was added to an already released assignment
    IF NEW.release_date IS NOT NULL 
       AND NEW.release_date AT TIME ZONE 'UTC' <= now_time_utc - INTERVAL '1 minute'
       AND NEW.template_repo IS NOT NULL
       AND NEW.template_repo != ''
       AND (OLD.template_repo IS NULL OR OLD.template_repo = '')
       AND NEW.release_date = OLD.release_date THEN
      
      should_create_repos := true;
      RAISE NOTICE 'Assignment updated with template repo added to already released assignment: assignment_id=%, class_id=%, release_date=% (UTC: %), old_template_repo=%, new_template_repo=%', 
        NEW.id, NEW.class_id, NEW.release_date, NEW.release_date AT TIME ZONE 'UTC',
        OLD.template_repo, NEW.template_repo;
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

-- Add comment for documentation
COMMENT ON FUNCTION public.check_assignment_for_repo_creation() IS 'Trigger function that creates repos for assignments when they are released or when a template repo is added to an already released assignment. Handles both release date changes and template repo additions.'; 