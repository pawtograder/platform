-- #1010, step 4b follow-up: saving New and Edit Assignment follows manage_assignments.
--
-- Why: step 4b shows New Assignment and Edit Assignment from useCapability("manage_assignments"), but
-- saving still required an instructor, so a grader on a custom role with the capability could fill in
-- either form and have it fail at the end. This moves every write those two saves make onto the
-- capability, with the rule in docs/capabilities.md.
--
-- What:
--   * assignments: the FOR ALL "instructors can read and edit in class" policy becomes SELECT and
--     DELETE (instructor-only, the same expression as before) plus INSERT and UPDATE on the capability.
--     The separate read policy for graders and released assignments is unchanged.
--   * assignment_self_review_settings: insert, update and delete on the capability. New creates the
--     settings row before the assignment, and Edit updates it.
--   * autograder: SELECT and UPDATE on the capability. Edit reads grader_repo before turning the
--     autograder on, and github-repo-configure-webhook stores the grader config with the caller's
--     client. INSERT and DELETE stay instructor-only; the row is created by the trigger below.
--   * assignments_grader_config_auto_populate(), the AFTER INSERT trigger that creates the autograder
--     row and the two rubrics: SECURITY DEFINER, so creating an assignment doesn't depend on the
--     caller's write access to those tables. It checks the capability itself, except when there is no
--     signed-in user (service role, seeds), like sync_staff_github_team.
--
-- Every capability is on the default instructor role, so instructors keep exactly what they had, and
-- default graders, students and admins hold no manage_assignments. Rubric, Autograder page, Delete and
-- the other assignment tools are unchanged.

-- assignments ---------------------------------------------------------------

DROP POLICY "instructors can read and edit in class" ON public.assignments;

CREATE POLICY "instructors can read assignments in class"
ON public.assignments
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.user_privileges up
    WHERE up.user_id = auth.uid()
      AND up.class_id = assignments.class_id
      AND up.role = 'instructor'
  )
);

CREATE POLICY "instructors can delete assignments in class"
ON public.assignments
FOR DELETE TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.user_privileges up
    WHERE up.user_id = auth.uid()
      AND up.class_id = assignments.class_id
      AND up.role = 'instructor'
  )
);

CREATE POLICY "assignment managers can create assignments"
ON public.assignments
FOR INSERT TO authenticated
WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('manage_assignments')));

CREATE POLICY "assignment managers can edit assignments"
ON public.assignments
FOR UPDATE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_assignments')))
WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('manage_assignments')));

-- assignment_self_review_settings ------------------------------------------

DROP POLICY "instructors can insert self review settings" ON public.assignment_self_review_settings;
DROP POLICY "instructors can update self review settings" ON public.assignment_self_review_settings;
DROP POLICY "instructors can delete review settings" ON public.assignment_self_review_settings;

CREATE POLICY "assignment managers can create self review settings"
ON public.assignment_self_review_settings
FOR INSERT TO authenticated
WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('manage_assignments')));

CREATE POLICY "assignment managers can edit self review settings"
ON public.assignment_self_review_settings
FOR UPDATE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_assignments')))
WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('manage_assignments')));

CREATE POLICY "assignment managers can delete self review settings"
ON public.assignment_self_review_settings
FOR DELETE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_assignments')));

-- autograder ----------------------------------------------------------------
-- autograder reaches its class through assignments, as the policy it replaces did: its own
-- class_id column is nullable.

DROP POLICY "instructors rw" ON public.autograder;

CREATE POLICY "assignment managers can read the autograder"
ON public.autograder
FOR SELECT TO authenticated
USING (
  (SELECT a.class_id FROM public.assignments a WHERE a.id = autograder.id)
    IN (SELECT public.user_class_ids_with_capability('manage_assignments'))
);

CREATE POLICY "assignment managers can edit the autograder"
ON public.autograder
FOR UPDATE TO authenticated
USING (
  (SELECT a.class_id FROM public.assignments a WHERE a.id = autograder.id)
    IN (SELECT public.user_class_ids_with_capability('manage_assignments'))
)
WITH CHECK (
  (SELECT a.class_id FROM public.assignments a WHERE a.id = autograder.id)
    IN (SELECT public.user_class_ids_with_capability('manage_assignments'))
);

CREATE POLICY "instructors can create the autograder"
ON public.autograder
FOR INSERT TO authenticated
WITH CHECK (public.authorizeforclassinstructor((SELECT a.class_id FROM public.assignments a WHERE a.id = autograder.id)));

CREATE POLICY "instructors can delete the autograder"
ON public.autograder
FOR DELETE TO authenticated
USING (public.authorizeforclassinstructor((SELECT a.class_id FROM public.assignments a WHERE a.id = autograder.id)));

-- assignments_grader_config_auto_populate -----------------------------------

CREATE OR REPLACE FUNCTION public.assignments_grader_config_auto_populate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  rubric_id int;
  self_rubric_id int;
BEGIN
  -- The INSERT policy on assignments already requires the capability. This repeats the check because
  -- the function now writes as its owner.
  IF auth.uid() IS NOT NULL
     AND NEW.class_id NOT IN (SELECT public.user_class_ids_with_capability('manage_assignments')) THEN
    RAISE EXCEPTION 'manage_assignments is required to create an assignment in class %', NEW.class_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.autograder (id, class_id, max_submissions_count, max_submissions_period_secs)
  VALUES (NEW.id, NEW.class_id, 5, 86400);
  INSERT INTO public.rubrics (name, class_id, assignment_id, review_round)
  VALUES ('Grading Rubric', NEW.class_id, NEW.id, 'grading-review') RETURNING id INTO rubric_id;
  INSERT INTO public.rubrics (name, class_id, assignment_id, review_round)
  VALUES ('Self-Review Rubric', NEW.class_id, NEW.id, 'self-review') RETURNING id INTO self_rubric_id;
  UPDATE public.assignments SET grading_rubric_id = rubric_id WHERE id = NEW.id;
  UPDATE public.assignments SET self_review_rubric_id = self_rubric_id WHERE id = NEW.id;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.assignments_grader_config_auto_populate() FROM PUBLIC, anon, authenticated;
