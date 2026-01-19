-- Migration: Add discussion_karma column to profiles and trigger to update it
-- This tracks the total number of likes received by a user's discussion posts

-- Add discussion_karma column to profiles table
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS discussion_karma bigint NOT NULL DEFAULT 0;

-- Create index on discussion_karma for leaderboard queries
CREATE INDEX IF NOT EXISTS idx_profiles_discussion_karma 
ON public.profiles(discussion_karma DESC);

-- Create function to update discussion karma when likes are added/removed
CREATE OR REPLACE FUNCTION public.update_discussion_karma()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    thread_author_id uuid;
BEGIN
    -- Get the author of the thread that was liked/unliked
    IF TG_OP = 'INSERT' THEN
        SELECT author INTO thread_author_id
        FROM public.discussion_threads
        WHERE id = NEW.discussion_thread;
        
        IF thread_author_id IS NOT NULL THEN
            UPDATE public.profiles
            SET discussion_karma = discussion_karma + 1
            WHERE id = thread_author_id;
        END IF;
        
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        SELECT author INTO thread_author_id
        FROM public.discussion_threads
        WHERE id = OLD.discussion_thread;
        
        IF thread_author_id IS NOT NULL THEN
            UPDATE public.profiles
            SET discussion_karma = GREATEST(0, discussion_karma - 1)
            WHERE id = thread_author_id;
        END IF;
        
        RETURN OLD;
    ELSE
        RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
    END IF;
END;
$$;

COMMENT ON FUNCTION public.update_discussion_karma() IS 
'Updates discussion_karma on profiles when discussion_thread_likes are added or removed. Increments on INSERT, decrements on DELETE.';

-- Create trigger on discussion_thread_likes to update karma
DROP TRIGGER IF EXISTS update_discussion_karma_trigger ON public.discussion_thread_likes;
CREATE TRIGGER update_discussion_karma_trigger
    AFTER INSERT OR DELETE
    ON public.discussion_thread_likes
    FOR EACH ROW
    EXECUTE FUNCTION public.update_discussion_karma();

COMMENT ON TRIGGER update_discussion_karma_trigger ON public.discussion_thread_likes IS
'Automatically updates the author''s discussion_karma when their posts are liked or unliked.';

-- Backfill existing karma for all profiles
-- This calculates karma from existing likes
UPDATE public.profiles p
SET discussion_karma = COALESCE((
    SELECT COUNT(*)
    FROM public.discussion_thread_likes dtl
    INNER JOIN public.discussion_threads dt ON dt.id = dtl.discussion_thread
    WHERE dt.author = p.id
), 0);
