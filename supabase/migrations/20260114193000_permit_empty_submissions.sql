-- Allow instructors to prohibit empty submissions (matching handout)

ALTER TABLE IF EXISTS public.assignments
  ADD COLUMN IF NOT EXISTS permit_empty_submissions boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.assignments.permit_empty_submissions IS
  'If false, submissions that match the handout (starter) files are rejected.';

