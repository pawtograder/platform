-- Add handout_url field to assignments table
-- This field stores a URL to the assignment handout/instructions document
-- which can be provided to AI agents for context when helping students

ALTER TABLE public.assignments ADD COLUMN handout_url TEXT;

-- Add a comment to document the column
COMMENT ON COLUMN public.assignments.handout_url IS 'URL to the assignment handout or instructions document, used for providing context to AI assistants helping students';
