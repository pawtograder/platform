-- Add additional context types for AI help feedback
-- Supports: help_request, discussion_thread, test_failure, build_error, test_insights

-- Drop existing constraint
ALTER TABLE public.ai_help_feedback
DROP CONSTRAINT IF EXISTS ai_help_feedback_context_type_check;

-- Add new constraint with additional context types
ALTER TABLE public.ai_help_feedback
ADD CONSTRAINT ai_help_feedback_context_type_check
CHECK (context_type IN ('help_request', 'discussion_thread', 'test_failure', 'build_error', 'test_insights'));

-- Update the RPC function to support new context types
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

    -- Validate context_type (expanded list)
    IF p_context_type NOT IN ('help_request', 'discussion_thread', 'test_failure', 'build_error', 'test_insights') THEN
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

    -- For help_request and discussion_thread, validate resource belongs to the class
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
    ELSIF p_context_type IN ('test_failure', 'build_error') THEN
        -- For test failures and build errors, resource_id is the submission_id
        IF NOT EXISTS (
            SELECT 1 FROM public.submissions
            WHERE id = p_resource_id AND class_id = p_class_id
        ) THEN
            RETURN json_build_object('error', 'Submission not found in this class');
        END IF;
    END IF;
    -- test_insights doesn't require specific resource validation (assignment-level)

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

-- Update comments
COMMENT ON COLUMN public.ai_help_feedback.context_type IS 'Type of context: help_request, discussion_thread, test_failure, build_error, or test_insights';
COMMENT ON COLUMN public.ai_help_feedback.resource_id IS 'ID of the resource (help request, discussion thread, submission, or assignment)';
