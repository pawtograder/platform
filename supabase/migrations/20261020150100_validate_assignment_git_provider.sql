-- Separate transaction so the column migration releases ACCESS EXCLUSIVE before scanning.
ALTER TABLE public.assignments VALIDATE CONSTRAINT assignments_git_provider_check;
