-- Add grader_pseudonymous_mode column to assignments table
-- When enabled, graders' comments will be recorded using their public profile ID (pseudonym)
-- instead of their private profile ID (real identity)

ALTER TABLE public.assignments 
ADD COLUMN IF NOT EXISTS grader_pseudonymous_mode boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.assignments.grader_pseudonymous_mode IS 
'When true, grading comments will use the grader''s public profile (pseudonym) instead of their private profile (real name). Students will see the pseudonym, while staff can see both.';
