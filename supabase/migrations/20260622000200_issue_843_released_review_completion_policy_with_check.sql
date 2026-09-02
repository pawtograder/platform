-- Issue 843 follow-up:
-- The initial policy only defined USING, which Postgres also applies as the
-- UPDATE WITH CHECK expression by default. That accidentally blocked the
-- intended grader transition released+incomplete -> released+complete.

DROP POLICY IF EXISTS "Instructors full; graders limited on released complete reviews" ON public.submission_reviews;

CREATE POLICY "Instructors full; graders limited on released complete reviews"
ON public.submission_reviews
AS permissive
FOR UPDATE
TO public
USING (
  public.authorizeforclassinstructor(class_id)
  OR (
    public.authorizeforclassgrader(class_id)
    AND (released = false OR completed_at IS NULL)
  )
  OR public.authorize_for_submission_review_writable(id)
)
WITH CHECK (
  public.authorizeforclassinstructor(class_id)
  OR (
    public.authorizeforclassgrader(class_id)
    AND (
      released = false
      OR completed_at IS NOT NULL
    )
  )
  OR public.authorize_for_submission_review_writable(id)
);
