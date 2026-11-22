-- #1010: grading follows grade_submissions, and releasing grades and changing a released grade
-- follow release_grades.
--
-- Why: who could grade, release and change a released grade was decided by app role in three
-- places that disagreed. The screens let only instructors release, but the submission_reviews
-- UPDATE policy let any grader release a completed review and unrelease an incomplete one, directly
-- or through the release RPCs (they are SECURITY INVOKER). The screens lock a TA's marks once a
-- review is released, but the comment INSERT policy let any grader add a comment or rubric check to
-- a released review. And an instructor had no way to let a TA fix a released grade, which CS2100
-- needs for redos (#1353).
--
-- What:
--   1. Two capabilities:
--        grade_submissions  on the default instructor and grader roles and every existing custom
--                           role (graders could all grade before), and on the grader role of new
--                           classes through seed_default_class_roles();
--        release_grades     on the default instructor role only.
--   2. submission_reviews UPDATE: release_grades replaces the instructor check, grade_submissions
--      replaces the grader check (still only on a review that is unreleased or incomplete, #843).
--      The assignee branch is unchanged.
--   3. A BEFORE UPDATE OF released trigger refuses a change of `released` by a signed-in user
--      without release_grades. RLS can't compare old and new values, so the policy alone would
--      either keep the grader release path open or break #843 (a grader completing a released,
--      incomplete review). The trigger only checks statements run as the `authenticated` role:
--      SECURITY DEFINER functions (the quiz autograder, the release cascade) and the service role
--      are not affected, while the SECURITY INVOKER release RPCs are.
--   4. Comment INSERT on submission_comments, submission_file_comments and
--      submission_artifact_comments: the role branch becomes "release_grades, or grade_submissions
--      on no review or an unreleased review of the same class". The non-review branch
--      (authorize_for_submission) and the assignee branch with its hard-deadline check are copied
--      unchanged from 20260417120000.
--   5. Comment UPDATE (edit, soft delete) on the same three tables: release_grades replaces the
--      instructor check, and grade_submissions replaces the grader check inside the unreleased
--      branch. The rest is copied unchanged from 20260520120000.
--   6. check_grading_completion_eligibility and complete_eligible_grading_reviews (Finalize
--      Grading) check grade_submissions instead of authorizeforclassgrader. Each is the body from
--      20260303140000 with only that check changed.
--
-- Who gains or loses:
--   * Instructors hold both capabilities, so nothing changes for them.
--   * Default graders and Head TAs keep grading as before, but can no longer release or unrelease
--     (through a direct update or the release RPCs), and can no longer add a comment or rubric
--     check to a released review. The screens already hid both from graders.
--   * A grader on a custom role with release_grades turned on can release and unrelease grades
--     (including Release all and Unrelease all) and change a released grade the way an instructor
--     can: edit any review, and add, edit or delete any comment or rubric check.
--   * A custom role with grade_submissions turned off can't grade, except a review they are
--     assigned to (the assignee branches are unchanged).
--   * Students are unchanged: self-review and their own submission comments use the assignee and
--     non-review branches.
--
-- Not changed: the regrade request functions, the assignee branches and the review_assignments
-- policies, the release RPCs' bodies (they follow the policy and the trigger), the
-- submissionreviewreleasecascade trigger, and the SELECT policies.
--
-- Safe to run again: the inserts skip rows that exist, policies are dropped before they are
-- created, and CREATE OR REPLACE gives the same functions.

-- ---------------------------------------------------------------------------
-- 1. The capabilities
-- ---------------------------------------------------------------------------

INSERT INTO public.capabilities (name, description)
VALUES
  (
    'grade_submissions',
    'Grade submissions before grades are released: apply rubric checks, add and edit your own comments, mark reviews complete and use Finalize Grading'
  ),
  (
    'release_grades',
    'Release and unrelease grades, and change a released grade: edit any review, and add, edit or delete any comment or rubric check'
  )
ON CONFLICT (name) DO NOTHING;

-- Every grader could grade before, so every default grader role and every custom role (a copy of
-- the grader role made before this capability existed) gets it, as well as the instructor role.
INSERT INTO public.role_capabilities (role_id, capability)
SELECT cr.id, 'grade_submissions'
FROM public.class_roles cr
WHERE cr.default_for IN ('instructor', 'grader') OR cr.default_for IS NULL
ON CONFLICT DO NOTHING;

INSERT INTO public.role_capabilities (role_id, capability)
SELECT cr.id, 'release_grades'
FROM public.class_roles cr
WHERE cr.default_for = 'instructor'
ON CONFLICT DO NOTHING;

-- New classes: the instructor role gets every capability through the CROSS JOIN, and the grader
-- role now gets grade_submissions. The body from 20261027120000 plus the second INSERT.
CREATE OR REPLACE FUNCTION public.seed_default_class_roles(p_class_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  INSERT INTO public.class_roles (class_id, name, default_for)
  VALUES
    (p_class_id, 'instructor', 'instructor'),
    (p_class_id, 'grader', 'grader'),
    (p_class_id, 'student', 'student'),
    (p_class_id, 'admin', 'admin')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.role_capabilities (role_id, capability)
  SELECT cr.id, c.name
  FROM public.class_roles cr
  CROSS JOIN public.capabilities c
  WHERE cr.class_id = p_class_id AND cr.default_for = 'instructor'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.role_capabilities (role_id, capability)
  SELECT cr.id, 'grade_submissions'
  FROM public.class_roles cr
  WHERE cr.class_id = p_class_id AND cr.default_for = 'grader'
  ON CONFLICT DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_default_class_roles(bigint) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. submission_reviews UPDATE
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Instructors full; graders limited on released complete reviews" ON public.submission_reviews;
DROP POLICY IF EXISTS "Release managers full; graders limited on released complete reviews" ON public.submission_reviews;

CREATE POLICY "Release managers full; graders limited on released complete reviews"
ON public.submission_reviews
AS PERMISSIVE
FOR UPDATE
TO authenticated
USING (
  class_id IN (SELECT public.user_class_ids_with_capability('release_grades'))
  OR (
    class_id IN (SELECT public.user_class_ids_with_capability('grade_submissions'))
    AND (released = false OR completed_at IS NULL)
  )
  OR public.authorize_for_submission_review_writable(id)
)
WITH CHECK (
  class_id IN (SELECT public.user_class_ids_with_capability('release_grades'))
  OR (
    class_id IN (SELECT public.user_class_ids_with_capability('grade_submissions'))
    AND (released = false OR completed_at IS NOT NULL)
  )
  OR public.authorize_for_submission_review_writable(id)
);

COMMENT ON POLICY "Release managers full; graders limited on released complete reviews" ON public.submission_reviews IS
  'release_grades: any review in the class. grade_submissions: a review that is unreleased or incomplete (#843: a grader may complete a released, incomplete review). Assignee: while the review is incomplete. Changing released also needs release_grades (trigger submission_reviews_release_needs_capability).';

-- ---------------------------------------------------------------------------
-- 3. Changing `released` needs release_grades
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.submission_reviews_release_needs_capability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $$
BEGIN
  -- Only statements run by a signed-in user. SECURITY DEFINER functions run as their owner and the
  -- service role as service_role, so neither reaches the capability check.
  IF current_user = 'authenticated' AND NEW.released IS DISTINCT FROM OLD.released THEN
    IF NEW.class_id NOT IN (SELECT public.user_class_ids_with_capability('release_grades')) THEN
      RAISE EXCEPTION 'Releasing or unreleasing grades needs the release_grades capability in this class'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.submission_reviews_release_needs_capability() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS submission_reviews_release_needs_capability ON public.submission_reviews;
CREATE TRIGGER submission_reviews_release_needs_capability
BEFORE UPDATE OF released ON public.submission_reviews
FOR EACH ROW EXECUTE FUNCTION public.submission_reviews_release_needs_capability();

-- ---------------------------------------------------------------------------
-- 4. Comment INSERT
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "insert for self with deadline check" ON public.submission_comments;
DROP POLICY IF EXISTS "insert for self with deadline check" ON public.submission_file_comments;
DROP POLICY IF EXISTS "insert for self with deadline check" ON public.submission_artifact_comments;

CREATE POLICY "insert for self with deadline check" ON public.submission_comments
    FOR INSERT
    TO authenticated
    WITH CHECK (
        public.authorizeforprofile(author)
        AND (
            class_id IN (SELECT public.user_class_ids_with_capability('release_grades'))
            OR (
                class_id IN (SELECT public.user_class_ids_with_capability('grade_submissions'))
                AND (
                    submission_review_id IS NULL
                    OR EXISTS (
                        SELECT 1
                        FROM public.submission_reviews sr
                        WHERE sr.id = submission_comments.submission_review_id
                          AND sr.class_id = submission_comments.class_id
                          AND sr.released = false
                    )
                )
            )
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
    TO authenticated
    WITH CHECK (
        public.authorizeforprofile(author)
        AND (
            class_id IN (SELECT public.user_class_ids_with_capability('release_grades'))
            OR (
                class_id IN (SELECT public.user_class_ids_with_capability('grade_submissions'))
                AND (
                    submission_review_id IS NULL
                    OR EXISTS (
                        SELECT 1
                        FROM public.submission_reviews sr
                        WHERE sr.id = submission_file_comments.submission_review_id
                          AND sr.class_id = submission_file_comments.class_id
                          AND sr.released = false
                    )
                )
            )
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
    TO authenticated
    WITH CHECK (
        public.authorizeforprofile(author)
        AND (
            class_id IN (SELECT public.user_class_ids_with_capability('release_grades'))
            OR (
                class_id IN (SELECT public.user_class_ids_with_capability('grade_submissions'))
                AND (
                    submission_review_id IS NULL
                    OR EXISTS (
                        SELECT 1
                        FROM public.submission_reviews sr
                        WHERE sr.id = submission_artifact_comments.submission_review_id
                          AND sr.class_id = submission_artifact_comments.class_id
                          AND sr.released = false
                    )
                )
            )
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

-- ---------------------------------------------------------------------------
-- 5. Comment UPDATE (edit, soft delete)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Instructors always; others only own comment if review not released" ON public.submission_comments;
DROP POLICY IF EXISTS "Instructors always; others only own comment if review not released" ON public.submission_file_comments;
DROP POLICY IF EXISTS "Instructors always; others only own comment if review not released" ON public.submission_artifact_comments;
DROP POLICY IF EXISTS "Release managers always; others only own comment if review not released" ON public.submission_comments;
DROP POLICY IF EXISTS "Release managers always; others only own comment if review not released" ON public.submission_file_comments;
DROP POLICY IF EXISTS "Release managers always; others only own comment if review not released" ON public.submission_artifact_comments;

CREATE POLICY "Release managers always; others only own comment if review not released"
ON public.submission_comments
AS PERMISSIVE
FOR UPDATE
TO authenticated
USING (
  class_id IN (SELECT public.user_class_ids_with_capability('release_grades'))
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
            submission_comments.class_id IN (SELECT public.user_class_ids_with_capability('grade_submissions'))
            OR sr.completed_at IS NULL
          )
      )
    )
  )
)
WITH CHECK (
  class_id IN (SELECT public.user_class_ids_with_capability('release_grades'))
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
            submission_comments.class_id IN (SELECT public.user_class_ids_with_capability('grade_submissions'))
            OR sr.completed_at IS NULL
          )
      )
    )
  )
);

CREATE POLICY "Release managers always; others only own comment if review not released"
ON public.submission_file_comments
AS PERMISSIVE
FOR UPDATE
TO authenticated
USING (
  class_id IN (SELECT public.user_class_ids_with_capability('release_grades'))
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
            submission_file_comments.class_id IN (SELECT public.user_class_ids_with_capability('grade_submissions'))
            OR sr.completed_at IS NULL
          )
      )
    )
  )
)
WITH CHECK (
  class_id IN (SELECT public.user_class_ids_with_capability('release_grades'))
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
            submission_file_comments.class_id IN (SELECT public.user_class_ids_with_capability('grade_submissions'))
            OR sr.completed_at IS NULL
          )
      )
    )
  )
);

CREATE POLICY "Release managers always; others only own comment if review not released"
ON public.submission_artifact_comments
AS PERMISSIVE
FOR UPDATE
TO authenticated
USING (
  class_id IN (SELECT public.user_class_ids_with_capability('release_grades'))
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
            submission_artifact_comments.class_id IN (SELECT public.user_class_ids_with_capability('grade_submissions'))
            OR sr.completed_at IS NULL
          )
      )
    )
  )
)
WITH CHECK (
  class_id IN (SELECT public.user_class_ids_with_capability('release_grades'))
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
            submission_artifact_comments.class_id IN (SELECT public.user_class_ids_with_capability('grade_submissions'))
            OR sr.completed_at IS NULL
          )
      )
    )
  )
);

COMMENT ON POLICY "Release managers always; others only own comment if review not released" ON public.submission_comments IS
  'release_grades: any comment in the class, released or not. grade_submissions: own rows on an unreleased review. Students: own rows while the review is unreleased and not completed. NULL submission_review_id keeps prior behavior for non-review comments.';
COMMENT ON POLICY "Release managers always; others only own comment if review not released" ON public.submission_file_comments IS
  'release_grades: any comment in the class, released or not. grade_submissions: own rows on an unreleased review. Students: own rows while the review is unreleased and not completed. NULL submission_review_id keeps prior behavior for non-review comments.';
COMMENT ON POLICY "Release managers always; others only own comment if review not released" ON public.submission_artifact_comments IS
  'release_grades: any comment in the class, released or not. grade_submissions: own rows on an unreleased review. Students: own rows while the review is unreleased and not completed. NULL submission_review_id keeps prior behavior for non-review comments.';

-- ---------------------------------------------------------------------------
-- 6. Finalize Grading
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.check_grading_completion_eligibility(p_assignment_id bigint)
RETURNS TABLE (
  total_incomplete bigint,
  completable bigint,
  missing_required_checks bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_class_id bigint;
  v_total bigint := 0;
  v_completable bigint := 0;
  v_missing bigint := 0;
  v_sr_id bigint;
BEGIN
  SELECT a.class_id INTO v_class_id FROM public.assignments a WHERE a.id = p_assignment_id;
  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'Assignment % does not exist', p_assignment_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- #1010: grade_submissions in the assignment's own class (loaded above, not passed in).
  IF v_class_id NOT IN (SELECT public.user_class_ids_with_capability('grade_submissions')) THEN
    RAISE EXCEPTION 'Access denied: insufficient permissions for assignment %', p_assignment_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Only grading reviews (s.grading_review_id = sr.id), not self-review or other rubric types.
  -- Only active submissions from non-dropped students (individual or group with enrolled member).
  FOR v_sr_id IN
    SELECT sr.id
    FROM public.submission_reviews sr
    INNER JOIN public.submissions s ON s.id = sr.submission_id AND s.grading_review_id = sr.id
    WHERE s.assignment_id = p_assignment_id
      AND s.is_active = true
      AND (sr.completed_at IS NULL OR sr.completed_by IS NULL)
      AND (
        (s.profile_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.user_roles ur
          WHERE ur.class_id = v_class_id
            AND ur.role = 'student'::public.app_role
            AND ur.disabled = false
            AND ur.private_profile_id = s.profile_id
        ))
        OR
        (s.assignment_group_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.assignment_groups_members agm
          INNER JOIN public.user_roles ur
            ON ur.private_profile_id = agm.profile_id
            AND ur.class_id = v_class_id
            AND ur.role = 'student'::public.app_role
            AND ur.disabled = false
          WHERE agm.assignment_group_id = s.assignment_group_id
            AND agm.assignment_id = s.assignment_id
        ))
      )
  LOOP
    v_total := v_total + 1;
    IF public._submission_review_is_completable(v_sr_id) THEN
      v_completable := v_completable + 1;
    ELSE
      v_missing := v_missing + 1;
    END IF;
  END LOOP;

  total_incomplete := v_total;
  completable := v_completable;
  missing_required_checks := v_missing;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_eligible_grading_reviews(p_assignment_id bigint)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_class_id bigint;
  v_profile_id uuid;
  affected_rows integer;
BEGIN
  SELECT a.class_id INTO v_class_id FROM public.assignments a WHERE a.id = p_assignment_id;
  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'Assignment % does not exist', p_assignment_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- #1010: grade_submissions in the assignment's own class (loaded above, not passed in).
  IF v_class_id NOT IN (SELECT public.user_class_ids_with_capability('grade_submissions')) THEN
    RAISE EXCEPTION 'Access denied: insufficient permissions for assignment %', p_assignment_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- completed_by must reference profiles(id); get current user's private_profile_id for this class
  SELECT ur.private_profile_id INTO v_profile_id
  FROM public.user_roles ur
  WHERE ur.user_id = auth.uid()
    AND ur.class_id = v_class_id
    AND ur.role IN ('instructor', 'grader')
  LIMIT 1;
  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION 'Could not resolve profile for current user in class %', v_class_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Only grading reviews (s.grading_review_id = sr.id), not self-review or other rubric types.
  -- Only active submissions from non-dropped students (individual or group with enrolled member).
  UPDATE public.submission_reviews sr
  SET completed_at = now(),
      completed_by = v_profile_id
  FROM public.submissions s
  WHERE s.id = sr.submission_id
    AND s.grading_review_id = sr.id
    AND s.assignment_id = p_assignment_id
    AND s.is_active = true
    AND (sr.completed_at IS NULL OR sr.completed_by IS NULL)
    AND public._submission_review_is_completable(sr.id)
    AND (
      (s.profile_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.class_id = v_class_id
          AND ur.role = 'student'::public.app_role
          AND ur.disabled = false
          AND ur.private_profile_id = s.profile_id
      ))
      OR
      (s.assignment_group_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.assignment_groups_members agm
        INNER JOIN public.user_roles ur
          ON ur.private_profile_id = agm.profile_id
          AND ur.class_id = v_class_id
          AND ur.role = 'student'::public.app_role
          AND ur.disabled = false
        WHERE agm.assignment_group_id = s.assignment_group_id
          AND agm.assignment_id = s.assignment_id
      ))
    );

  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  RETURN affected_rows;
END;
$$;

-- Grants as left by 20261015120000_lock_down_security_definer_functions.sql (CREATE OR REPLACE keeps
-- them; restated so a fresh reader sees them here).
REVOKE ALL ON FUNCTION public.check_grading_completion_eligibility(bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.complete_eligible_grading_reviews(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_grading_completion_eligibility(bigint) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_eligible_grading_reviews(bigint) TO authenticated, service_role;
