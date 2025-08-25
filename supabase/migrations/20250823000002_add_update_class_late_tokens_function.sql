-- Create a SECURITY DEFINER function to allow instructors to update late_tokens_per_student
-- This function uses authorizeforinstructor to ensure proper permissions

CREATE OR REPLACE FUNCTION public.update_class_late_tokens_per_student(
    p_class_id bigint,
    p_late_tokens_per_student integer
) 
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    -- Check if the current user is authorized as an instructor for this class
    IF NOT public.authorizeforclassinstructor(p_class_id) THEN
        RAISE EXCEPTION 'Access denied: You must be an instructor to update class late token settings'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    
    -- Validate that late_tokens_per_student is non-negative
    IF p_late_tokens_per_student < 0 THEN
        RAISE EXCEPTION 'Late tokens per student must be non-negative'
            USING ERRCODE = 'check_violation';
    END IF;
    
    -- Update the late_tokens_per_student for the class
    UPDATE public.classes 
    SET 
        late_tokens_per_student = p_late_tokens_per_student
    WHERE id = p_class_id;
    
    -- Check if the update actually affected any rows
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Class not found or could not be updated'
            USING ERRCODE = 'no_data_found';
    END IF;
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION public.update_class_late_tokens_per_student(bigint, integer) TO authenticated;

-- Add a comment to document the function
COMMENT ON FUNCTION public.update_class_late_tokens_per_student(bigint, integer) IS 
'Allows instructors to update the late_tokens_per_student setting for their class. Uses SECURITY DEFINER with authorizeforinstructor check.';
