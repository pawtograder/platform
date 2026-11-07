-- #1010, step 5: seeing and deleting review assignments follow manage_review_assignments.
--
-- Why: Manage Review Assignments shows its delete controls from useCapability(
-- "manage_review_assignments") (step 4a), but the database still decided with "is this user an
-- instructor in the class". This moves the check onto the capability tables, so the page and the
-- database answer from the same place.
--
-- What: "Instructors can manage review assignments" was one FOR ALL policy. It becomes:
--   * SELECT and DELETE: the capability check from docs/capabilities.md. SELECT moves too because
--     Postgres only deletes rows the user can also see: with SELECT left instructor-only, a grader
--     on a custom role with manage_review_assignments could delete only their own assignments.
--   * INSERT and UPDATE: instructor-only, with the same expression as before (inlined in
--     20250917002948_optimize-submission-rls.sql).
--
-- Every capability is on the default instructor role, so instructors keep exactly what they had,
-- and default graders, students and admins hold no manage_review_assignments, so they don't gain
-- anything. Only a grader on a custom role that has the capability can now see and delete the
-- class's review assignments.
--
-- Not changed: "Assignees can view their own review assignments", "Assignees can mark their review
-- assignments as completed", the review_assignment_rubric_parts cascade and its policy, and the
-- SECURITY DEFINER functions clear_unfinished_review_assignments, bulk_assign_reviews and
-- bulk_update_review_assignment_due_dates, which keep their own checks.

DROP POLICY "Instructors can manage review assignments" ON public.review_assignments;

CREATE POLICY "Review assignment managers can view review assignments"
ON public.review_assignments
FOR SELECT TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_review_assignments')));

CREATE POLICY "Review assignment managers can delete review assignments"
ON public.review_assignments
FOR DELETE TO authenticated
USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_review_assignments')));

CREATE POLICY "Instructors can create review assignments"
ON public.review_assignments
FOR INSERT TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.user_privileges up
    WHERE up.user_id = auth.uid()
      AND up.class_id = review_assignments.class_id
      AND up.role = 'instructor'
  )
);

CREATE POLICY "Instructors can update review assignments"
ON public.review_assignments
FOR UPDATE TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.user_privileges up
    WHERE up.user_id = auth.uid()
      AND up.class_id = review_assignments.class_id
      AND up.role = 'instructor'
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.user_privileges up
    WHERE up.user_id = auth.uid()
      AND up.class_id = review_assignments.class_id
      AND up.role = 'instructor'
  )
);
