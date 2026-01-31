-- Create AI help feedback table for collecting TA feedback on AI assistance
CREATE TABLE IF NOT EXISTS public.ai_help_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    class_id INTEGER NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
    context_type TEXT NOT NULL CHECK (context_type IN ('help_request', 'discussion_thread')),
    resource_id INTEGER NOT NULL,
    rating TEXT NOT NULL CHECK (rating IN ('thumbs_up', 'thumbs_down')),
    comment TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for querying feedback by class
CREATE INDEX idx_ai_help_feedback_class_id ON public.ai_help_feedback(class_id);

-- Index for querying feedback by user
CREATE INDEX idx_ai_help_feedback_user_id ON public.ai_help_feedback(user_id);

-- Index for querying feedback by resource
CREATE INDEX idx_ai_help_feedback_resource ON public.ai_help_feedback(context_type, resource_id);

-- Enable RLS
ALTER TABLE public.ai_help_feedback ENABLE ROW LEVEL SECURITY;

-- Policy: Users can insert their own feedback
CREATE POLICY "Users can insert their own feedback"
    ON public.ai_help_feedback
    FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

-- Policy: Users can view their own feedback
CREATE POLICY "Users can view their own feedback"
    ON public.ai_help_feedback
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- Policy: Instructors and graders can view all feedback in their classes
CREATE POLICY "Staff can view class feedback"
    ON public.ai_help_feedback
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = auth.uid()
            AND ur.class_id = ai_help_feedback.class_id
            AND ur.role IN ('instructor', 'grader')
            AND ur.disabled = false
        )
    );

-- Comment on table
COMMENT ON TABLE public.ai_help_feedback IS 'Stores TA feedback on AI assistance experience';
COMMENT ON COLUMN public.ai_help_feedback.context_type IS 'Type of context: help_request or discussion_thread';
COMMENT ON COLUMN public.ai_help_feedback.resource_id IS 'ID of the help request or discussion thread';
COMMENT ON COLUMN public.ai_help_feedback.rating IS 'Thumbs up or thumbs down rating';
COMMENT ON COLUMN public.ai_help_feedback.comment IS 'Optional freeform feedback comment';
