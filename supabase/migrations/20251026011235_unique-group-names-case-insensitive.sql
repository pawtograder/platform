-- Create a unique index on assignment_groups for case-insensitive name and assignment_id
-- This prevents creating groups like "Group A" and "group a" for the same assignment
CREATE UNIQUE INDEX IF NOT EXISTS unique_assignment_groups_name_assignment_id 
ON public.assignment_groups (LOWER(name), assignment_id);

