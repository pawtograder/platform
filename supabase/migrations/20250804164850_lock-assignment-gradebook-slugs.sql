-- Migration to lock slug fields on assignments and gradebook_columns tables
-- This prevents updates to the slug column after insertion, while still allowing inserts

-- Create a reusable trigger function to prevent slug updates
CREATE OR REPLACE FUNCTION public.prevent_slug_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
    -- Only check for updates (not inserts)
    IF TG_OP = 'UPDATE' THEN
        -- Check if slug is being changed
        IF OLD.slug IS DISTINCT FROM NEW.slug THEN
            RAISE EXCEPTION 'Updates to the slug column are not allowed once set. Table: %, Old slug: %, New slug: %', 
                TG_TABLE_NAME, OLD.slug, NEW.slug
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    
    RETURN NEW;
END;
$function$;

-- Create trigger for assignments table
CREATE TRIGGER prevent_assignments_slug_update
    BEFORE UPDATE ON public.assignments
    FOR EACH ROW
    EXECUTE FUNCTION public.prevent_slug_update();

-- Create trigger for gradebook_columns table  
CREATE TRIGGER prevent_gradebook_columns_slug_update
    BEFORE UPDATE ON public.gradebook_columns
    FOR EACH ROW
    EXECUTE FUNCTION public.prevent_slug_update();

-- Add comments for documentation
COMMENT ON FUNCTION public.prevent_slug_update() IS 'Prevents updates to slug columns after insertion. Used by triggers on assignments and gradebook_columns tables.';
COMMENT ON TRIGGER prevent_assignments_slug_update ON public.assignments IS 'Prevents updates to the slug column after insertion';
COMMENT ON TRIGGER prevent_gradebook_columns_slug_update ON public.gradebook_columns IS 'Prevents updates to the slug column after insertion';

-- Create RPC function to delete assignment and all associated data
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
REVOKE EXECUTE ON FUNCTION public.delete_assignment_with_all_data(bigint, bigint) FROM authenticated;
-- Grant execute permission only to postgres role (service role)
GRANT EXECUTE ON FUNCTION public.delete_assignment_with_all_data(bigint, bigint) TO postgres;

-- Add comment for documentation
COMMENT ON FUNCTION public.delete_assignment_with_all_data(bigint, bigint) IS 'Deletes an assignment and all its associated data. Performs safety checks and handles all related tables in the correct order. Only callable by postgres service role.';
