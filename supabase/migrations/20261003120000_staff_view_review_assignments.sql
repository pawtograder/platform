-- Let course staff see every review assignment in their class.
--
-- Until now a grader could read only their own review_assignments rows (the
-- "Assignees can view their own review assignments" policy). The submission page
-- therefore had no way to tell one grader, or show an instructor's grader view, that a
-- submission was already assigned to someone else: the old "Assigned to" line could
-- only ever describe the viewer's own assignment.
--
-- Staff (graders and instructors) get SELECT on review_assignments and
-- review_assignment_rubric_parts for their class. Instructors already had this through
-- their ALL policies; the new policies add graders. This is read-only: who may UPDATE
-- (complete) a review assignment is unchanged -- a grader still completes only their
-- own, and instructors keep their existing ALL policy.

CREATE POLICY "Staff can view review assignments in their class"
ON public.review_assignments
FOR SELECT
TO authenticated
USING (public.authorizeforclassgrader(class_id));

CREATE POLICY "Staff can view review assignment rubric parts in their class"
ON public.review_assignment_rubric_parts
FOR SELECT
TO authenticated
USING (public.authorizeforclassgrader(class_id));
