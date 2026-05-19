-- Comment RLS: allow graders/instructors to insert/update/delete comments after a
-- submission_review or review_assignment is marked complete. The only hard stop for
-- graders remains release (issue #446). submission_review row updates stay gated by
-- authorize_for_submission_review_writable (completed submission_review).

CREATE OR REPLACE FUNCTION public.authorize_for_submission_review_comment_writable(submission_review_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
    return (
        select exists (
            select 1
            from submission_reviews sr
            left join review_assignments ra
                on ra.submission_review_id = sr.id
            left join user_roles ur on ur.private_profile_id = ra.assignee_profile_id and ur.class_id = sr.class_id
            where sr.id = authorize_for_submission_review_comment_writable.submission_review_id
              and ur.user_id = auth.uid()
        )
    );
end;
$function$;

COMMENT ON FUNCTION public.authorize_for_submission_review_comment_writable(bigint) IS
  'True when the current user has a review_assignment for this submission_review, regardless of submission_review.completed_at. Used by comment INSERT/UPDATE RLS; release restrictions are separate.';

CREATE OR REPLACE FUNCTION public.authorize_for_submission_review_writable(submission_review_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
    -- Only write to a submission review row if there is a review assignment for the user and the review is not done.
    return (
        select exists (
            select 1
            from submission_reviews sr
            left join review_assignments ra
                on ra.submission_review_id = sr.id
            left join user_roles ur on ur.private_profile_id = ra.assignee_profile_id and ur.class_id = sr.class_id
            where sr.id = authorize_for_submission_review_writable.submission_review_id
              and sr.completed_at is null
              and ur.user_id = auth.uid()
        )
    );
end;
$function$;

-- Issue #446 policies: use comment-specific auth for graders so completed reviews still allow comment edits.
DROP POLICY IF EXISTS "Instructors always; others only own comment if review not released" ON public.submission_comments;
DROP POLICY IF EXISTS "Instructors always; others only own comment if review not released" ON public.submission_file_comments;
DROP POLICY IF EXISTS "Instructors always; others only own comment if review not released" ON public.submission_artifact_comments;

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
            public.authorize_for_submission_review_comment_writable(submission_comments.submission_review_id)
            OR (
              NOT public.authorizeforclassgrader(class_id)
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
            public.authorize_for_submission_review_comment_writable(submission_comments.submission_review_id)
            OR (
              NOT public.authorizeforclassgrader(class_id)
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
            public.authorize_for_submission_review_comment_writable(submission_file_comments.submission_review_id)
            OR (
              NOT public.authorizeforclassgrader(class_id)
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
            public.authorize_for_submission_review_comment_writable(submission_file_comments.submission_review_id)
            OR (
              NOT public.authorizeforclassgrader(class_id)
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
            public.authorize_for_submission_review_comment_writable(submission_artifact_comments.submission_review_id)
            OR (
              NOT public.authorizeforclassgrader(class_id)
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
            public.authorize_for_submission_review_comment_writable(submission_artifact_comments.submission_review_id)
            OR (
              NOT public.authorizeforclassgrader(class_id)
              AND sr.completed_at IS NULL
            )
          )
      )
    )
  )
);

COMMENT ON POLICY "Instructors always; others only own comment if review not released" ON public.submission_comments IS
  'Instructors may update any comment. Graders may update only their own rows while the review is unreleased and they have a review assignment (even if the submission_review is complete). Students may update only their own rows while the review is unreleased and not completed. NULL submission_review_id keeps prior behavior for non-review comments.';
COMMENT ON POLICY "Instructors always; others only own comment if review not released" ON public.submission_file_comments IS
  'Instructors may update any comment. Graders may update only their own rows while the review is unreleased and they have a review assignment (even if the submission_review is complete). Students may update only their own rows while the review is unreleased and not completed. NULL submission_review_id keeps prior behavior for non-review comments.';
COMMENT ON POLICY "Instructors always; others only own comment if review not released" ON public.submission_artifact_comments IS
  'Instructors may update any comment. Graders may update only their own rows while the review is unreleased and they have a review assignment (even if the submission_review is complete). Students may update only their own rows while the review is unreleased and not completed. NULL submission_review_id keeps prior behavior for non-review comments.';

-- INSERT policies: keep hard_deadline enforcement after due_date, but do not block
-- inserts solely because the review_assignment was marked completed.

DROP POLICY IF EXISTS "insert for self with deadline check" ON public.submission_comments;
DROP POLICY IF EXISTS "insert for self with deadline check" ON public.submission_file_comments;
DROP POLICY IF EXISTS "insert for self with deadline check" ON public.submission_artifact_comments;

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
                public.authorize_for_submission_review_comment_writable(submission_review_id)
                AND NOT EXISTS (
                    SELECT 1
                    FROM public.review_assignments ra
                    WHERE ra.submission_review_id = submission_comments.submission_review_id
                      AND ra.assignee_profile_id IN (
                          SELECT up.private_profile_id
                          FROM public.user_privileges up
                          WHERE up.user_id = auth.uid()
                      )
                      AND ra.due_date < NOW()
                      AND ra.hard_deadline = true
                )
            )
        )
    );

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
                public.authorize_for_submission_review_comment_writable(submission_review_id)
                AND NOT EXISTS (
                    SELECT 1
                    FROM public.review_assignments ra
                    WHERE ra.submission_review_id = submission_file_comments.submission_review_id
                      AND ra.assignee_profile_id IN (
                          SELECT up.private_profile_id
                          FROM public.user_privileges up
                          WHERE up.user_id = auth.uid()
                      )
                      AND ra.due_date < NOW()
                      AND ra.hard_deadline = true
                )
            )
        )
    );

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
                public.authorize_for_submission_review_comment_writable(submission_review_id)
                AND NOT EXISTS (
                    SELECT 1
                    FROM public.review_assignments ra
                    WHERE ra.submission_review_id = submission_artifact_comments.submission_review_id
                      AND ra.assignee_profile_id IN (
                          SELECT up.private_profile_id
                          FROM public.user_privileges up
                          WHERE up.user_id = auth.uid()
                      )
                      AND ra.due_date < NOW()
                      AND ra.hard_deadline = true
                )
            )
        )
    );
