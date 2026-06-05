-- Advisory "suggested due date": an earlier, recommended target date shown to students.
-- It is purely informational and changes no enforcement. The existing due_date keeps its
-- exact meaning as the hard deadline (submissions accepted up to due_date + per-student
-- extensions). suggested_due_date is never consulted by submission enforcement, late
-- tokens, lab scheduling, or any view.

ALTER TABLE IF EXISTS public.assignments
  ADD COLUMN IF NOT EXISTS suggested_due_date timestamptz;

COMMENT ON COLUMN public.assignments.suggested_due_date IS
  'Optional advisory target date shown to students, on or before due_date. Display-only: never affects submission enforcement, late tokens, or lab scheduling. due_date remains the hard deadline.';

ALTER TABLE public.assignments
  ADD CONSTRAINT assignments_suggested_due_date_before_due
  CHECK (suggested_due_date IS NULL OR suggested_due_date <= due_date);
