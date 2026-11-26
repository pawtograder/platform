-- #1010: granting due date extensions follows the grant_extensions capability.
--
-- Why: granting, editing and deleting a student's extension (assignment_due_date_exceptions) and a
-- student's class-wide extension (student_deadline_extensions) were decided by "is this user a grader
-- or instructor in the class". An instructor had no way to keep a custom role out of extensions while
-- letting other graders grant them. Now one capability decides, in the database and on the screen.
--
-- What:
--   1. New capability grant_extensions. Every grader and instructor can grant extensions today, so
--      it goes on the default instructor role, the default grader role and every existing custom
--      role (a custom role is a copy of the grader role made earlier, so it wouldn't pick up a
--      capability added to the grader role now). seed_default_class_roles() puts it on the default
--      grader role of new classes.
--   2. assignment_due_date_exceptions:
--      - INSERT: the staff branch checks grant_extensions in the row's class instead of the
--        grader/instructor role, and still requires creator_id to be the caller's own profile in
--        that class. It also checks that the assignment, the student and the group are in that
--        class, so grant_extensions in one class can't write another class's extension under its
--        own class_id. The student branch (late tokens, authorize_to_create_own_due_date_extension)
--        is unchanged.
--      - UPDATE: only staff with grant_extensions in the row's class can update an extension, and
--        only one they created, as before, with the same class checks before and after. No screen
--        updates these rows: the app creates and deletes them.
--      - DELETE: needs grant_extensions in the row's class.
--   3. student_deadline_extensions: writing needs grant_extensions in the row's class. Adding and
--      editing also need the student to be in that class, before and after the edit, since the
--      insert trigger extends every assignment in the class for that student. Reading stays with
--      every grader and instructor of the class, and students still read their own.
--   4. extend_review_assignments_on_due_date_exception (the trigger that moves a student's review
--      assignment due dates by a new extension) runs as SECURITY DEFINER with search_path ''
--      (#1411). It ran as the caller, and only instructors can update review_assignments, so when a
--      grader granted an extension the review due dates didn't move. It only runs from the AFTER
--      INSERT trigger on assignment_due_date_exceptions, so on an insert RLS already allowed. The
--      logic is unchanged; table names are schema-qualified for the empty search_path.
--
-- Who gains or loses: instructors, default graders and existing custom roles hold grant_extensions,
-- so nothing they can do changes. A custom role an instructor turns it off for loses granting,
-- deleting and editing extensions. Students keep using late tokens and finishing early, and can't
-- update an extension. Admins hold nothing new. Whoever grants an extension, the student's review
-- assignment due dates now move with it, as they did when an instructor granted it.
--
-- Not changed: gift_tokens_to_student and update_class_late_tokens_per_student (instructor-only),
-- apply_late_token_extension (service role), the SELECT policy on assignment_due_date_exceptions, the
-- policy letting students give themselves negative exceptions, and the triggers that create
-- extensions from student_deadline_extensions and for new assignments.
--
-- seed_default_class_roles() is re-created in full with the same body as
-- 20261126150300_regrades_by_capability.sql. Its grader list is the one every #1010 migration that
-- redefines it writes (moderate_discussion, grade_submissions, handle_regrades, grant_extensions,
-- help_students, manage_flashcards, run_polls); only the names that are capabilities yet join.
--
-- Number: this was 20261122150200 until 2026-11-23, then 20261123040200, and then 20261123180200,
-- each time right after #1408's and #1409's migrations. On 2026-11-24 #1299 and #1300 put
-- 20261124130000 and 20261124130100 on staging, and those moved to 20261124150200 and
-- 20261124150300 and this one to 20261124150400. On 2026-11-25 #1297 put its own 20261124150200
-- on staging and #1432 and #1433 put 20261125120000 and 20261125120100 there, so those moved to
-- 20261126150200 and 20261126150300, after every migration on staging and in every open PR (the
-- newest is #1434's 20261126120000). This one stays right after both, so it also runs after
-- #1299's, #1300's, #1301's and #1429's migrations, which redefine seed_default_class_roles() too.
--
-- Safe to run again: the inserts skip rows that exist, CREATE OR REPLACE gives the same function,
-- and each policy is dropped first.

-- ---------------------------------------------------------------------------
-- 1. The capability, on the default instructor and grader roles and on every custom role
-- ---------------------------------------------------------------------------

INSERT INTO public.capabilities (name, description)
VALUES ('grant_extensions', 'Grant, edit and delete due date extensions for students')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_capabilities (role_id, capability)
SELECT cr.id, 'grant_extensions'
FROM public.class_roles cr
WHERE cr.default_for IN ('instructor', 'grader') OR cr.default_for IS NULL
ON CONFLICT DO NOTHING;

-- The same function as 20261126150200_grading_and_release_by_capability.sql and
-- 20261126150300_regrades_by_capability.sql: the grader list there already names grant_extensions,
-- which joins now that it exists. Instructors get it from the CROSS JOIN.
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

  -- What the default grader role can do today, for new classes (#1010). One list for every #1010
  -- migration that redefines this function, so whichever runs last keeps the others' grants. A
  -- name joins only once its capability exists, so the list can name capabilities other open PRs
  -- add (grade_submissions, handle_regrades and grant_extensions are #1408-#1410's,
  -- moderate_discussion is #1429's and help_students is #1301's). Each of those PRs also gives
  -- its capability to existing grader roles.
  INSERT INTO public.role_capabilities (role_id, capability)
  SELECT cr.id, c.name
  FROM public.class_roles cr
  JOIN public.capabilities c ON c.name IN (
    'moderate_discussion', 'grade_submissions', 'handle_regrades', 'grant_extensions',
    'help_students', 'manage_flashcards', 'run_polls'
  )
  WHERE cr.class_id = p_class_id AND cr.default_for = 'grader'
  ON CONFLICT DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_default_class_roles(bigint) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. assignment_due_date_exceptions
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Graders and instructors insert" ON public.assignment_due_date_exceptions;
DROP POLICY IF EXISTS "graders/instructors" ON public.assignment_due_date_exceptions;
DROP POLICY IF EXISTS "graders and instructors delete" ON public.assignment_due_date_exceptions;
DROP POLICY IF EXISTS "Extension granters and students using late tokens can add" ON public.assignment_due_date_exceptions;
DROP POLICY IF EXISTS "Extension granters can edit extensions they created" ON public.assignment_due_date_exceptions;
DROP POLICY IF EXISTS "Extension granters can delete extensions" ON public.assignment_due_date_exceptions;

-- The staff branches check grant_extensions in the row's class_id, so they also check that the
-- assignment, the student and the group are in that class. Otherwise grant_extensions in class A
-- would let someone write an extension for a class B assignment or student by labelling it class A
-- (and the review due date trigger would then move class B's review assignments).
CREATE POLICY "Extension granters and students using late tokens can add" ON public.assignment_due_date_exceptions
  FOR INSERT TO authenticated
  WITH CHECK (
    (
      class_id IN (SELECT public.user_class_ids_with_capability('grant_extensions'))
      AND EXISTS (
        SELECT 1 FROM public.user_privileges up
        WHERE up.user_id = auth.uid()
          AND up.class_id = assignment_due_date_exceptions.class_id
          AND (up.public_profile_id = assignment_due_date_exceptions.creator_id
               OR up.private_profile_id = assignment_due_date_exceptions.creator_id)
      )
      AND EXISTS (
        SELECT 1 FROM public.assignments a
        WHERE a.id = assignment_due_date_exceptions.assignment_id
          AND a.class_id = assignment_due_date_exceptions.class_id
      )
      AND (
        student_id IS NULL
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = assignment_due_date_exceptions.student_id
            AND p.class_id = assignment_due_date_exceptions.class_id
        )
      )
      AND (
        assignment_group_id IS NULL
        OR EXISTS (
          SELECT 1 FROM public.assignment_groups ag
          WHERE ag.id = assignment_due_date_exceptions.assignment_group_id
            AND ag.class_id = assignment_due_date_exceptions.class_id
        )
      )
    )
    OR public.authorize_to_create_own_due_date_extension(
      student_id, assignment_group_id, assignment_id, class_id, creator_id, hours, tokens_consumed
    )
  );

CREATE POLICY "Extension granters can edit extensions they created" ON public.assignment_due_date_exceptions
  FOR UPDATE TO authenticated
  USING (
    class_id IN (SELECT public.user_class_ids_with_capability('grant_extensions'))
    AND EXISTS (
      SELECT 1 FROM public.user_privileges up
      WHERE up.user_id = auth.uid()
        AND up.class_id = assignment_due_date_exceptions.class_id
        AND (up.public_profile_id = assignment_due_date_exceptions.creator_id
             OR up.private_profile_id = assignment_due_date_exceptions.creator_id)
    )
    AND EXISTS (
      SELECT 1 FROM public.assignments a
      WHERE a.id = assignment_due_date_exceptions.assignment_id
        AND a.class_id = assignment_due_date_exceptions.class_id
    )
    AND (
      student_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = assignment_due_date_exceptions.student_id
          AND p.class_id = assignment_due_date_exceptions.class_id
      )
    )
    AND (
      assignment_group_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.assignment_groups ag
        WHERE ag.id = assignment_due_date_exceptions.assignment_group_id
          AND ag.class_id = assignment_due_date_exceptions.class_id
      )
    )
  )
  WITH CHECK (
    class_id IN (SELECT public.user_class_ids_with_capability('grant_extensions'))
    AND EXISTS (
      SELECT 1 FROM public.user_privileges up
      WHERE up.user_id = auth.uid()
        AND up.class_id = assignment_due_date_exceptions.class_id
        AND (up.public_profile_id = assignment_due_date_exceptions.creator_id
             OR up.private_profile_id = assignment_due_date_exceptions.creator_id)
    )
    AND EXISTS (
      SELECT 1 FROM public.assignments a
      WHERE a.id = assignment_due_date_exceptions.assignment_id
        AND a.class_id = assignment_due_date_exceptions.class_id
    )
    AND (
      student_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = assignment_due_date_exceptions.student_id
          AND p.class_id = assignment_due_date_exceptions.class_id
      )
    )
    AND (
      assignment_group_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.assignment_groups ag
        WHERE ag.id = assignment_due_date_exceptions.assignment_group_id
          AND ag.class_id = assignment_due_date_exceptions.class_id
      )
    )
  );

CREATE POLICY "Extension granters can delete extensions" ON public.assignment_due_date_exceptions
  FOR DELETE TO authenticated
  USING (class_id IN (SELECT public.user_class_ids_with_capability('grant_extensions')));

-- ---------------------------------------------------------------------------
-- 3. student_deadline_extensions
-- ---------------------------------------------------------------------------

-- The old policy was FOR ALL, so it also let staff read. Reading isn't gated on grant_extensions.
-- Adding and editing also check that the student is in the row's class. The insert trigger
-- (create_assignment_exceptions_from_extension) writes an extension for every assignment in that
-- class for that student, with full database access, so grant_extensions in class A must not
-- reach a class B student's profile by labelling the row class A.
DROP POLICY IF EXISTS "Course staff can CRUD" ON public.student_deadline_extensions;
DROP POLICY IF EXISTS "Course staff can read class-wide extensions" ON public.student_deadline_extensions;
DROP POLICY IF EXISTS "Extension granters can add class-wide extensions" ON public.student_deadline_extensions;
DROP POLICY IF EXISTS "Extension granters can edit class-wide extensions" ON public.student_deadline_extensions;
DROP POLICY IF EXISTS "Extension granters can delete class-wide extensions" ON public.student_deadline_extensions;

CREATE POLICY "Course staff can read class-wide extensions" ON public.student_deadline_extensions
  FOR SELECT TO authenticated
  USING (
    class_id IN (
      SELECT up.class_id FROM public.user_privileges up
      WHERE up.user_id = auth.uid() AND up.role IN ('instructor', 'grader')
    )
  );

CREATE POLICY "Extension granters can add class-wide extensions" ON public.student_deadline_extensions
  FOR INSERT TO authenticated
  WITH CHECK (
    class_id IN (SELECT public.user_class_ids_with_capability('grant_extensions'))
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = student_deadline_extensions.student_id
        AND p.class_id = student_deadline_extensions.class_id
    )
  );

CREATE POLICY "Extension granters can edit class-wide extensions" ON public.student_deadline_extensions
  FOR UPDATE TO authenticated
  USING (
    class_id IN (SELECT public.user_class_ids_with_capability('grant_extensions'))
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = student_deadline_extensions.student_id
        AND p.class_id = student_deadline_extensions.class_id
    )
  )
  WITH CHECK (
    class_id IN (SELECT public.user_class_ids_with_capability('grant_extensions'))
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = student_deadline_extensions.student_id
        AND p.class_id = student_deadline_extensions.class_id
    )
  );

CREATE POLICY "Extension granters can delete class-wide extensions" ON public.student_deadline_extensions
  FOR DELETE TO authenticated
  USING (class_id IN (SELECT public.user_class_ids_with_capability('grant_extensions')));

-- ---------------------------------------------------------------------------
-- 4. Review assignment due dates move with an extension, whoever grants it (#1411)
-- ---------------------------------------------------------------------------

-- The body from 20260504120000_fix_extend_review_assignments_trigger_search_path.sql, with table
-- names schema-qualified for the empty search_path.
CREATE OR REPLACE FUNCTION public.extend_review_assignments_on_due_date_exception()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    extension_interval INTERVAL;
    affected_student_ids UUID[];
BEGIN
    IF COALESCE(NEW.hours, 0) < 0 OR COALESCE(NEW.minutes, 0) < 0 THEN
        RETURN NEW;
    END IF;

    IF COALESCE(NEW.hours, 0) = 0 AND COALESCE(NEW.minutes, 0) = 0 THEN
        RETURN NEW;
    END IF;

    extension_interval := make_interval(hours => COALESCE(NEW.hours, 0), mins => COALESCE(NEW.minutes, 0));

    IF NEW.student_id IS NOT NULL THEN
        affected_student_ids := ARRAY[NEW.student_id];
    ELSIF NEW.assignment_group_id IS NOT NULL THEN
        SELECT ARRAY_AGG(profile_id) INTO affected_student_ids
        FROM public.assignment_groups_members
        WHERE assignment_group_id = NEW.assignment_group_id;
    ELSE
        RETURN NEW;
    END IF;

    UPDATE public.review_assignments
    SET due_date = due_date + extension_interval
    WHERE assignment_id = NEW.assignment_id
      AND assignee_profile_id = ANY(affected_student_ids);

    RETURN NEW;
END;
$$;

-- Only the trigger runs it. CREATE OR REPLACE keeps the old EXECUTE grants, so take them away.
REVOKE ALL ON FUNCTION public.extend_review_assignments_on_due_date_exception() FROM PUBLIC, anon, authenticated;
