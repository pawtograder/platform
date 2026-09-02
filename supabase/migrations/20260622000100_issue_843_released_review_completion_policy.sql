-- Issue 843:
-- - Graders/TAs can still complete a released review if it is currently incomplete.
-- - Graders/TAs cannot mutate a review once it is both released and completed.
-- - Instructors can always mark reviews complete/incomplete.

DROP POLICY IF EXISTS "instructors and gradersa all, self for not-complete review assi" ON public.submission_reviews;
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
);
