-- Migration: Add RPCs for bulk releasing/unreleasing grading reviews for an assignment

-- Function to release all grading reviews for an assignment
CREATE OR REPLACE FUNCTION "public"."release_all_grading_reviews_for_assignment"("assignment_id" bigint)
RETURNS integer
LANGUAGE "plpgsql" 
SECURITY INVOKER
AS $$
DECLARE
    affected_rows integer;
BEGIN
    -- Validate that the assignment exists
    IF NOT EXISTS (SELECT 1 FROM public.assignments WHERE id = assignment_id) THEN
        RAISE EXCEPTION 'Assignment with id % does not exist', assignment_id
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Update submission_reviews to released=true for all submissions of this assignment
    UPDATE public.submission_reviews 
    SET released = true
    FROM public.submissions s
    WHERE submission_reviews.submission_id = s.id
    AND s.assignment_id = release_all_grading_reviews_for_assignment.assignment_id
    AND s.is_active = true;
    
    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    
    RETURN affected_rows;
END;
$$;

-- Function to unrelease all grading reviews for an assignment  
CREATE OR REPLACE FUNCTION "public"."unrelease_all_grading_reviews_for_assignment"("assignment_id" bigint)
RETURNS integer
LANGUAGE "plpgsql"
SECURITY INVOKER
AS $$
DECLARE
    affected_rows integer;
BEGIN
    -- Validate that the assignment exists
    IF NOT EXISTS (SELECT 1 FROM public.assignments WHERE id = assignment_id) THEN
        RAISE EXCEPTION 'Assignment with id % does not exist', assignment_id
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Update submission_reviews to released=false for all submissions of this assignment
    UPDATE public.submission_reviews 
    SET released = false
    FROM public.submissions s
    WHERE submission_reviews.submission_id = s.id
    AND s.assignment_id = unrelease_all_grading_reviews_for_assignment.assignment_id;
    
    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    
    RETURN affected_rows;
END;
$$;

-- Grant execute permissions to authenticated users (adjust as needed based on your RLS policies)
GRANT EXECUTE ON FUNCTION "public"."release_all_grading_reviews_for_assignment"(bigint) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."unrelease_all_grading_reviews_for_assignment"(bigint) TO "authenticated";
