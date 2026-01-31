-- RPC function to submit AI help feedback
-- Validates user is instructor/grader in the class before inserting

CREATE OR REPLACE FUNCTION public.submit_ai_help_feedback(
    p_class_id INTEGER,
    p_context_type TEXT,
    p_resource_id INTEGER,
    p_rating TEXT,
    p_comment TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_feedback_id UUID;
BEGIN
    -- Get the current user
    v_user_id := auth.uid();

    IF v_user_id IS NULL THEN
        RETURN json_build_object('error', 'Unauthorized');
    END IF;

    -- Validate context_type
    IF p_context_type NOT IN ('help_request', 'discussion_thread') THEN
        RETURN json_build_object('error', 'Invalid context_type');
    END IF;

    -- Validate rating
    IF p_rating NOT IN ('thumbs_up', 'thumbs_down') THEN
        RETURN json_build_object('error', 'Invalid rating');
    END IF;

    -- Validate comment length
    IF p_comment IS NOT NULL AND length(p_comment) > 2000 THEN
        RETURN json_build_object('error', 'Comment too long (max 2000 characters)');
    END IF;

    -- Check if user is instructor or grader in this class
    IF NOT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = v_user_id
          AND class_id = p_class_id
          AND disabled = false
          AND role IN ('instructor', 'grader')
    ) THEN
        RETURN json_build_object('error', 'Feedback is only available to instructors and graders');
    END IF;

    -- Validate resource belongs to the class
    IF p_context_type = 'help_request' THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.help_requests
            WHERE id = p_resource_id AND class_id = p_class_id
        ) THEN
            RETURN json_build_object('error', 'Help request not found in this class');
        END IF;
    ELSIF p_context_type = 'discussion_thread' THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.discussion_threads
            WHERE id = p_resource_id AND class_id = p_class_id
        ) THEN
            RETURN json_build_object('error', 'Discussion thread not found in this class');
        END IF;
    END IF;

    -- Insert feedback (with exception handling)
    BEGIN
        INSERT INTO public.ai_help_feedback (
        user_id,
        class_id,
        context_type,
        resource_id,
        rating,
        comment
    ) VALUES (
        v_user_id,
        p_class_id,
        p_context_type,
        p_resource_id,
        p_rating,
        NULLIF(trim(p_comment), '')
    )
    RETURNING id INTO v_feedback_id;
    EXCEPTION WHEN OTHERS THEN
        RETURN json_build_object('error', 'Failed to save feedback');
    END;

    RETURN json_build_object(
        'success', true,
        'feedback_id', v_feedback_id,
        'message', 'Thank you for your feedback!'
    );
END;
$$;

-- Grant execute to authenticated users (auth check is inside the function)
GRANT EXECUTE ON FUNCTION public.submit_ai_help_feedback TO authenticated;
