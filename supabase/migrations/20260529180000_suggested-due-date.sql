-- Add an advisory "suggested due date" to assignments.
--
-- This is a purely informational, earlier target date shown to students alongside
-- the real deadline. It is NEVER consulted by submission enforcement, late tokens,
-- lab scheduling, or any view: `due_date` keeps its exact current meaning as the
-- hard deadline (submissions are accepted up to `due_date` + per-student
-- extensions, enforced in the autograder-create-submission edge function).
--
-- Use case: standards/mastery grading where students see a recommended target date
-- (suggested_due_date) but may keep resubmitting until a later hard deadline
-- (due_date), with the TA regrading roughly weekly.

ALTER TABLE public.assignments
  ADD COLUMN suggested_due_date timestamptz;

-- When set, the suggested date must not be after the hard deadline.
ALTER TABLE public.assignments
  ADD CONSTRAINT assignments_suggested_due_date_before_due
  CHECK (suggested_due_date IS NULL OR suggested_due_date <= due_date);

COMMENT ON COLUMN public.assignments.suggested_due_date IS
  'Optional advisory/recommended target date shown to students. Display-only: does not affect submission enforcement, late tokens, or due-date calculations. Must be <= due_date when set.';
