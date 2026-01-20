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
    -- Get the normalized author of the thread that was liked/unliked
    -- Normalize anonymous/public authors to private profile using user_roles mapping
    IF TG_OP = 'INSERT' THEN
        SELECT COALESCE(ur.private_profile_id, dt.author) INTO thread_author_id
        FROM public.discussion_threads dt
        LEFT JOIN public.user_roles ur ON dt.author = ur.public_profile_id
            AND dt.class_id = ur.class_id
            AND ur.disabled = false
        WHERE dt.id = NEW.discussion_thread;
        
        IF thread_author_id IS NOT NULL THEN
            UPDATE public.profiles
            SET discussion_karma = discussion_karma + 1
            WHERE id = thread_author_id;
        END IF;
        
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        SELECT COALESCE(ur.private_profile_id, dt.author) INTO thread_author_id
        FROM public.discussion_threads dt
        LEFT JOIN public.user_roles ur ON dt.author = ur.public_profile_id
            AND dt.class_id = ur.class_id
            AND ur.disabled = false
        WHERE dt.id = OLD.discussion_thread;
        
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
-- This calculates karma from existing likes, normalizing anonymous/public authors to private profiles
UPDATE public.profiles p
SET discussion_karma = COALESCE((
    SELECT COUNT(*)
    FROM public.discussion_thread_likes dtl
    INNER JOIN public.discussion_threads dt ON dt.id = dtl.discussion_thread
    LEFT JOIN public.user_roles ur ON dt.author = ur.public_profile_id
        AND dt.class_id = ur.class_id
        AND ur.disabled = false
    WHERE COALESCE(ur.private_profile_id, dt.author) = p.id
), 0);

-- Create RPC function to get discussion engagement metrics for a class
-- This computes all engagement data server-side for scalability
CREATE OR REPLACE FUNCTION public.get_discussion_engagement(p_class_id bigint)
RETURNS TABLE (
  profile_id uuid,
  name text,
  discussion_karma bigint,
  total_posts bigint,
  total_replies bigint,
  likes_received bigint,
  likes_given bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_is_authorized boolean;
BEGIN
  -- Authorization guard: verify caller is instructor or grader for this class
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.class_id = p_class_id
      AND ur.user_id = auth.uid()
      AND ur.role IN ('instructor', 'grader')
      AND ur.disabled = false
  ) INTO v_is_authorized;

  IF NOT v_is_authorized THEN
    RAISE EXCEPTION 'Access denied: Instructor or grader role required for this class'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  WITH profile_mapping AS (
    -- Map public profile IDs to private profile IDs
    SELECT ur.public_profile_id, ur.private_profile_id
    FROM public.user_roles ur
    WHERE ur.class_id = p_class_id AND ur.disabled = false
  ),
  thread_counts AS (
    -- Count posts and replies per normalized author
    SELECT 
      COALESCE(pm.private_profile_id, dt.author) AS author_id,
      COUNT(*) FILTER (WHERE dt.parent IS NULL) AS posts,
      COUNT(*) FILTER (WHERE dt.parent IS NOT NULL) AS replies
    FROM public.discussion_threads dt
    LEFT JOIN profile_mapping pm ON pm.public_profile_id = dt.author
    WHERE dt.class_id = p_class_id AND dt.draft = false
    GROUP BY COALESCE(pm.private_profile_id, dt.author)
  ),
  likes_given_counts AS (
    -- Count likes given per normalized creator
    SELECT 
      COALESCE(pm.private_profile_id, dtl.creator) AS giver_id,
      COUNT(*) AS given_count
    FROM public.discussion_thread_likes dtl
    INNER JOIN public.discussion_threads dt ON dt.id = dtl.discussion_thread
    LEFT JOIN profile_mapping pm ON pm.public_profile_id = dtl.creator
    WHERE dt.class_id = p_class_id
    GROUP BY COALESCE(pm.private_profile_id, dtl.creator)
  )
  SELECT 
    p.id AS profile_id,
    p.name,
    p.discussion_karma,
    COALESCE(tc.posts, 0)::bigint AS total_posts,
    COALESCE(tc.replies, 0)::bigint AS total_replies,
    p.discussion_karma AS likes_received,
    COALESCE(lg.given_count, 0)::bigint AS likes_given
  FROM public.profiles p
  LEFT JOIN thread_counts tc ON tc.author_id = p.id
  LEFT JOIN likes_given_counts lg ON lg.giver_id = p.id
  WHERE p.class_id = p_class_id AND p.is_private_profile = true
  ORDER BY p.discussion_karma DESC;
END;
$$;

COMMENT ON FUNCTION public.get_discussion_engagement(bigint) IS 
'Returns discussion engagement metrics (posts, replies, likes) for all students in a class. Computes all aggregation server-side for scalability.';
