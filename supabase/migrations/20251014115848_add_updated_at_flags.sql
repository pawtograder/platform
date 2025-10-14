-- Add updated_at columns to tables that need them for auto-refetch behavior
-- These tables are frequently updated but were missing updated_at tracking

-- 1. notifications table (viewed_at changes frequently)
ALTER TABLE public.notifications 
ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now() NOT NULL;

-- Create index for better query performance
CREATE INDEX IF NOT EXISTS idx_notifications_updated_at ON public.notifications(updated_at DESC);

-- Add trigger to automatically update updated_at on both insert and update
CREATE TRIGGER set_updated_at_on_notifications
  BEFORE INSERT OR UPDATE ON public.notifications
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- 2. discussion_topics table
ALTER TABLE public.discussion_topics 
ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now() NOT NULL;

CREATE INDEX IF NOT EXISTS idx_discussion_topics_updated_at ON public.discussion_topics(updated_at DESC);

CREATE TRIGGER set_updated_at_on_discussion_topics
  BEFORE INSERT OR UPDATE ON public.discussion_topics
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- 3. discussion_thread_likes table
ALTER TABLE public.discussion_thread_likes 
ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now() NOT NULL;

CREATE INDEX IF NOT EXISTS idx_discussion_thread_likes_updated_at ON public.discussion_thread_likes(updated_at DESC);

CREATE TRIGGER set_updated_at_on_discussion_thread_likes
  BEFORE INSERT OR UPDATE ON public.discussion_thread_likes
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- 4. assignments table (many fields update: title, dates, settings, etc.)
ALTER TABLE public.assignments 
ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now() NOT NULL;

CREATE INDEX IF NOT EXISTS idx_assignments_updated_at ON public.assignments(updated_at DESC);

CREATE TRIGGER set_updated_at_on_assignments
  BEFORE INSERT OR UPDATE ON public.assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- Comments for documentation
COMMENT ON COLUMN public.notifications.updated_at IS 'Timestamp of last update. Used for auto-refetch detection in TableController.';
COMMENT ON COLUMN public.discussion_topics.updated_at IS 'Timestamp of last update. Used for auto-refetch detection in TableController.';
COMMENT ON COLUMN public.discussion_thread_likes.updated_at IS 'Timestamp of last update. Used for auto-refetch detection in TableController.';
COMMENT ON COLUMN public.assignments.updated_at IS 'Timestamp of last update. Used for auto-refetch detection in TableController.';

