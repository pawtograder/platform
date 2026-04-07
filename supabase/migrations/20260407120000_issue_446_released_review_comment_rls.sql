-- Issue #446: After a submission review is released to students, only instructors may
-- update (edit / soft-delete via deleted_at) grading comments tied to that review.
-- Graders and students may still edit their own comments while the review is unreleased.

DROP POLICY IF EXISTS "Instructors update all, graders and students update only before com" ON public.submission_comments;
DROP POLICY IF EXISTS "Instructors update all, graders and students update only before com" ON public.submission_file_comments;
DROP POLICY IF EXISTS "Instructors update all, graders and students update only before com" ON public.submission_artifact_comments;

DROP POLICY IF EXISTS "Instructors can update all, graders and students only own comments with restrictions" ON public.submission_comments;
DROP POLICY IF EXISTS "Instructors can update all, graders and students only own comments with restrictions" ON public.submission_file_comments;
DROP POLICY IF EXISTS "Instructors can update all, graders and students only own comments with restrictions" ON public.submission_artifact_comments;

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
            public.authorize_for_submission_review_writable(submission_comments.submission_review_id)
            OR (
              public.authorizeforclass(class_id)
              AND sr.completed_at IS NULL
            )
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
            public.authorize_for_submission_review_writable(submission_comments.submission_review_id)
            OR (
              public.authorizeforclass(class_id)
              AND sr.completed_at IS NULL
            )
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
            public.authorize_for_submission_review_writable(submission_file_comments.submission_review_id)
            OR (
              public.authorizeforclass(class_id)
              AND sr.completed_at IS NULL
            )
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
            public.authorize_for_submission_review_writable(submission_file_comments.submission_review_id)
            OR (
              public.authorizeforclass(class_id)
              AND sr.completed_at IS NULL
            )
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
            public.authorize_for_submission_review_writable(submission_artifact_comments.submission_review_id)
            OR (
              public.authorizeforclass(class_id)
              AND sr.completed_at IS NULL
            )
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
            public.authorize_for_submission_review_writable(submission_artifact_comments.submission_review_id)
            OR (
              public.authorizeforclass(class_id)
              AND sr.completed_at IS NULL
            )
          )
      )
    )
  )
);

COMMENT ON POLICY "Instructors always; others only own comment if review not released" ON public.submission_comments IS
  'Instructors may update any comment. Other roles may update only rows they authored, and only while the linked submission review is not released (or there is no linked review).';
COMMENT ON POLICY "Instructors always; others only own comment if review not released" ON public.submission_file_comments IS
  'Instructors may update any comment. Other roles may update only rows they authored, and only while the linked submission review is not released (or there is no linked review).';
COMMENT ON POLICY "Instructors always; others only own comment if review not released" ON public.submission_artifact_comments IS
  'Instructors may update any comment. Other roles may update only rows they authored, and only while the linked submission review is not released (or there is no linked review).';
