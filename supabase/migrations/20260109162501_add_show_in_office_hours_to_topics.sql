-- Add show_in_office_hours flag to discussion_topics table
-- This allows instructors to flag topics that should appear in the office hours pre-help browser

ALTER TABLE public.discussion_topics 
  ADD COLUMN show_in_office_hours boolean NOT NULL DEFAULT false;

-- Add comment for clarity
COMMENT ON COLUMN public.discussion_topics.show_in_office_hours IS 'If true, this topic will appear in the office hours discussion browser before students create help requests';
