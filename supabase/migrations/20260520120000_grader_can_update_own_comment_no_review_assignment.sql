-- TA-reported bug: a class_grader who is NOT the assignee on a submission_review (e.g.
-- the only TA in a class with no formal review_assignment row) can't delete their own
-- submission_*_comments. The frontend optimistically removes the comment locally and
-- then issues an `UPDATE ... SET deleted_at = now()` (soft delete). RLS blocks the
-- UPDATE — PostgREST returns 0 rows but no error — so the local-cache removal sticks
-- briefly, then the row "rubber-bands" back on the next refetch or realtime sync.
--
-- The previous policy required `authorize_for_submission_review_comment_writable`,
-- which checks for an explicit review_assignment. Relax that branch: a grader who
-- authored the comment should be able to update their own row on any unreleased
-- review, regardless of whether they're the formally-assigned reviewer. The student
-- branch (no class_grader role) keeps its tighter check (`completed_at IS NULL`).
--
-- Repeats the policy for submission_comments, submission_file_comments, and
-- submission_artifact_comments to keep the three tables aligned.

DROP POLICY IF EXISTS "Instructors always; others only own comment if review not released"
  ON public.submission_comments;
DROP POLICY IF EXISTS "Instructors always; others only own comment if review not released"
  ON public.submission_file_comments;
DROP POLICY IF EXISTS "Instructors always; others only own comment if review not released"
  ON public.submission_artifact_comments;

CREATE POLICY "Instructors always; others only own comment if review not released"
ON public.submission_comments
AS PERMISSIVE
FOR UPDATE
TO public
USING (
  public.authorizeforclassinstructor(class_id)
  OR (
    public.authorizeforprofile(author)
    AND (
      submission_review_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.submission_reviews sr
        WHERE sr.id = submission_comments.submission_review_id
          AND sr.released = false
          AND (
            public.authorizeforclassgrader(class_id)
            OR sr.completed_at IS NULL
          )
      )
    )
  )
)
WITH CHECK (
  public.authorizeforclassinstructor(class_id)
  OR (
    public.authorizeforprofile(author)
    AND (
      submission_review_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.submission_reviews sr
        WHERE sr.id = submission_comments.submission_review_id
          AND sr.released = false
          AND (
            public.authorizeforclassgrader(class_id)
            OR sr.completed_at IS NULL
          )
      )
    )
  )
);

CREATE POLICY "Instructors always; others only own comment if review not released"
ON public.submission_file_comments
AS PERMISSIVE
FOR UPDATE
TO public
USING (
  public.authorizeforclassinstructor(class_id)
  OR (
    public.authorizeforprofile(author)
    AND (
      submission_review_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.submission_reviews sr
        WHERE sr.id = submission_file_comments.submission_review_id
          AND sr.released = false
          AND (
            public.authorizeforclassgrader(class_id)
            OR sr.completed_at IS NULL
          )
      )
    )
  )
)
WITH CHECK (
  public.authorizeforclassinstructor(class_id)
  OR (
    public.authorizeforprofile(author)
    AND (
      submission_review_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.submission_reviews sr
        WHERE sr.id = submission_file_comments.submission_review_id
          AND sr.released = false
          AND (
            public.authorizeforclassgrader(class_id)
            OR sr.completed_at IS NULL
          )
      )
    )
  )
);

CREATE POLICY "Instructors always; others only own comment if review not released"
ON public.submission_artifact_comments
AS PERMISSIVE
FOR UPDATE
TO public
USING (
  public.authorizeforclassinstructor(class_id)
  OR (
    public.authorizeforprofile(author)
    AND (
      submission_review_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.submission_reviews sr
        WHERE sr.id = submission_artifact_comments.submission_review_id
          AND sr.released = false
          AND (
            public.authorizeforclassgrader(class_id)
            OR sr.completed_at IS NULL
          )
      )
    )
  )
)
WITH CHECK (
  public.authorizeforclassinstructor(class_id)
  OR (
    public.authorizeforprofile(author)
    AND (
      submission_review_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.submission_reviews sr
        WHERE sr.id = submission_artifact_comments.submission_review_id
          AND sr.released = false
          AND (
            public.authorizeforclassgrader(class_id)
            OR sr.completed_at IS NULL
          )
      )
    )
  )
);

COMMENT ON POLICY "Instructors always; others only own comment if review not released" ON public.submission_comments IS
  'Instructors may update any comment. Graders may update their own rows on any unreleased review in their class (no review_assignment requirement). Students may update their own rows while the review is unreleased and not completed. NULL submission_review_id keeps prior behavior for non-review comments.';
COMMENT ON POLICY "Instructors always; others only own comment if review not released" ON public.submission_file_comments IS
  'Instructors may update any comment. Graders may update their own rows on any unreleased review in their class (no review_assignment requirement). Students may update their own rows while the review is unreleased and not completed. NULL submission_review_id keeps prior behavior for non-review comments.';
COMMENT ON POLICY "Instructors always; others only own comment if review not released" ON public.submission_artifact_comments IS
  'Instructors may update any comment. Graders may update their own rows on any unreleased review in their class (no review_assignment requirement). Students may update their own rows while the review is unreleased and not completed. NULL submission_review_id keeps prior behavior for non-review comments.';
