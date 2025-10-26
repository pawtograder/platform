-- Add hard_deadline column to review_assignments
ALTER TABLE public.review_assignments 
ADD COLUMN hard_deadline boolean DEFAULT false NOT NULL;

-- Create function to automatically set hard_deadline for self-review assignments
CREATE OR REPLACE FUNCTION public.set_hard_deadline_for_self_review()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Check if this review assignment's rubric is for self-review
    IF EXISTS (
        SELECT 1 FROM public.rubrics r
        WHERE r.id = NEW.rubric_id 
        AND r.review_round = 'self-review'
    ) THEN
        NEW.hard_deadline := true;
    END IF;
    
    RETURN NEW;
END;
$$;

-- Create trigger to set hard_deadline on review_assignments insert/update
CREATE TRIGGER trigger_set_hard_deadline_for_self_review
    BEFORE INSERT OR UPDATE OF rubric_id ON public.review_assignments
    FOR EACH ROW
    EXECUTE FUNCTION public.set_hard_deadline_for_self_review();

-- Update existing self-review assignments to have hard_deadline = true
UPDATE public.review_assignments ra
SET hard_deadline = true
FROM public.rubrics r
WHERE ra.rubric_id = r.id 
AND r.review_round = 'self-review';

-- Drop existing INSERT policies for submission comments
DROP POLICY IF EXISTS "insert for self" ON public.submission_comments;
DROP POLICY IF EXISTS "can only insert comments as self, for own files (instructors an" ON public.submission_file_comments;
DROP POLICY IF EXISTS "insert for self" ON public.submission_artifact_comments;

-- Create new INSERT policy for submission_comments with hard deadline check
CREATE POLICY "insert for self with deadline check" ON public.submission_comments
    FOR INSERT
    WITH CHECK (
        public.authorizeforprofile(author) 
        AND (
            public.authorizeforclassgrader(class_id) 
            OR (
                (submission_review_id IS NULL) 
                AND public.authorize_for_submission(submission_id)
            )
            OR (
                public.authorize_for_submission_review_writable(submission_review_id)
                AND NOT EXISTS (
                    SELECT 1 
                    FROM public.review_assignments ra
                    WHERE ra.submission_review_id = submission_comments.submission_review_id
                    AND ra.assignee_profile_id IN (
                        SELECT up.private_profile_id 
                        FROM public.user_privileges up 
                        WHERE up.user_id = auth.uid()
                    )
                    AND (
                        ra.completed_at IS NOT NULL
                        OR (ra.due_date < NOW() AND ra.hard_deadline = true)
                    )
                )
            )
        )
    );

-- Create new INSERT policy for submission_file_comments with hard deadline check
CREATE POLICY "insert for self with deadline check" ON public.submission_file_comments
    FOR INSERT
    WITH CHECK (
        public.authorizeforprofile(author) 
        AND (
            public.authorizeforclassgrader(class_id) 
            OR (
                (submission_review_id IS NULL) 
                AND public.authorize_for_submission(submission_id)
            )
            OR (
                public.authorize_for_submission_review_writable(submission_review_id)
                AND NOT EXISTS (
                    SELECT 1 
                    FROM public.review_assignments ra
                    WHERE ra.submission_review_id = submission_file_comments.submission_review_id
                    AND ra.assignee_profile_id IN (
                        SELECT up.private_profile_id 
                        FROM public.user_privileges up 
                        WHERE up.user_id = auth.uid()
                    )
                    AND (
                        ra.completed_at IS NOT NULL
                        OR (ra.due_date < NOW() AND ra.hard_deadline = true)
                    )
                )
            )
        )
    );

-- Create new INSERT policy for submission_artifact_comments with hard deadline check
CREATE POLICY "insert for self with deadline check" ON public.submission_artifact_comments
    FOR INSERT
    WITH CHECK (
        public.authorizeforprofile(author) 
        AND (
            public.authorizeforclassgrader(class_id) 
            OR (
                (submission_review_id IS NULL) 
                AND public.authorize_for_submission(submission_id)
            )
            OR (
                public.authorize_for_submission_review_writable(submission_review_id)
                AND NOT EXISTS (
                    SELECT 1 
                    FROM public.review_assignments ra
                    WHERE ra.submission_review_id = submission_artifact_comments.submission_review_id
                    AND ra.assignee_profile_id IN (
                        SELECT up.private_profile_id 
                        FROM public.user_privileges up 
                        WHERE up.user_id = auth.uid()
                    )
                    AND (
                        ra.completed_at IS NOT NULL
                        OR (ra.due_date < NOW() AND ra.hard_deadline = true)
                    )
                )
            )
        )
    );

-- Add comments for documentation
COMMENT ON COLUMN public.review_assignments.hard_deadline IS 'When true, students cannot add comments after the due_date passes. Automatically set to true for self-review assignments.';
COMMENT ON FUNCTION public.set_hard_deadline_for_self_review() IS 'Automatically sets hard_deadline to true for review assignments with self-review rubrics.';

