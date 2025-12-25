-- Add discussion notification preference to notification_preferences table
-- This allows users to control how they receive discussion board email notifications

-- First, check if the enum type exists, create it if not
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'discussion_notification_type') THEN
        CREATE TYPE public.discussion_notification_type AS ENUM ('immediate', 'digest', 'disabled');
    END IF;
END $$;

-- Add discussion_notification column to notification_preferences
ALTER TABLE public.notification_preferences 
ADD COLUMN IF NOT EXISTS discussion_notification public.discussion_notification_type NOT NULL DEFAULT 'immediate';

-- Update the discussion_threads_notification trigger function to:
-- 1. Notify topic followers for NEW posts (not replies)
-- 2. Notify thread watchers for replies (existing behavior)
-- 3. Add notification_reason and topic_id to notification body

CREATE OR REPLACE FUNCTION public.discussion_threads_notification() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO public
    AS $$
declare
   body jsonb;
   subject jsonb;
   style text;
   root_subject text;
   reply_author_name text;
   current_user_id uuid;
   is_new_post boolean;
   thread_topic_id bigint;
   notification_reason text;
BEGIN
   CASE TG_OP
   WHEN 'INSERT' THEN
    -- Set root to its own ID if there is no root specified
      if NEW.root is null then
         update discussion_threads set root = id where id = NEW.id;
         NEW.root = NEW.id;
         root_subject = NEW.subject;
      else
        SELECT discussion_threads.subject from discussion_threads into root_subject WHERE id=NEW.root; 
      end if;
      
      -- Determine if this is a new post (root = id) or a reply
      is_new_post := (NEW.root = NEW.id);
      
      -- Get the topic_id for this thread
      SELECT topic_id INTO thread_topic_id FROM discussion_threads WHERE id = NEW.root;
      
      SELECT name into reply_author_name from profiles where id=NEW.author; 

   -- Get current user ID, handling null case
      current_user_id := auth.uid();

   -- Build notification body with appropriate action and reason
      if is_new_post then
        -- New post: notify topic followers
        notification_reason := 'topic_follow';
        body := jsonb_build_object(
           'type', 'discussion_thread',
           'action', 'new_post',
           'new_comment_number', NEW.ordinal,
           'new_comment_id', NEW.id,
           'root_thread_id', NEW.root,
           'reply_author_profile_id', NEW.author,
           'teaser', left(NEW.body, 40),
           'thread_name', root_subject,
           'reply_author_name', reply_author_name,
           'topic_id', thread_topic_id,
           'notification_reason', notification_reason
        );
      else
        -- Reply: notify thread watchers
        notification_reason := 'thread_watch';
        body := jsonb_build_object(
           'type', 'discussion_thread',
           'action', 'reply',
           'new_comment_number', NEW.ordinal,
           'new_comment_id', NEW.id,
           'root_thread_id', NEW.root,
           'reply_author_profile_id', NEW.author,
           'teaser', left(NEW.body, 40),
           'thread_name', root_subject,
           'reply_author_name', reply_author_name,
           'topic_id', thread_topic_id,
           'notification_reason', notification_reason
        );
      end if;
      
      subject := '{}';
      style := 'info';
      
      -- Only send notifications if we have a current user
      if current_user_id is not null then
        if is_new_post then
          -- For new posts: notify users who follow the topic (and don't have notifications disabled)
          -- Follow logic: if topic has default_follow=true, user follows unless override with following=false
          --                if topic has default_follow=false, user follows only if override with following=true
          INSERT INTO notifications (class_id, subject, body, style, user_id)
          SELECT DISTINCT
            NEW.class_id, 
            subject, 
            body, 
            style, 
            ur.user_id
          FROM user_roles ur
          JOIN discussion_topics dt ON dt.id = thread_topic_id AND dt.class_id = NEW.class_id
          LEFT JOIN discussion_topic_followers dtf ON dtf.user_id = ur.user_id 
            AND dtf.topic_id = thread_topic_id 
            AND dtf.class_id = NEW.class_id
          WHERE ur.class_id = NEW.class_id
            AND ur.user_id != current_user_id
            -- User follows if: (default_follow=true AND no override OR override with following=true)
            --                OR (default_follow=false AND override with following=true)
            AND (
              (dt.default_follow = true AND (dtf.id IS NULL OR dtf.following = true))
              OR (dt.default_follow = false AND dtf.following = true)
            )
            -- Check notification preferences - only send if not disabled
            AND NOT EXISTS (
              SELECT 1 FROM notification_preferences np
              WHERE np.user_id = ur.user_id
                AND np.class_id = NEW.class_id
                AND np.discussion_notification = 'disabled'
            );
        else
          -- For replies: notify thread watchers (existing behavior)
          INSERT INTO notifications (class_id, subject, body, style, user_id)
          SELECT NEW.class_id, subject, body, style, user_id 
          FROM discussion_thread_watchers
          WHERE discussion_thread_root_id = NEW.root 
            AND enabled = true 
            AND user_id != current_user_id
            -- Check notification preferences - only send if not disabled
            AND NOT EXISTS (
              SELECT 1 FROM notification_preferences np
              WHERE np.user_id = discussion_thread_watchers.user_id
                AND np.class_id = NEW.class_id
                AND np.discussion_notification = 'disabled'
            );
        end if;
      end if;

   -- Set watch if there is not one already and we have a current user
      if current_user_id is not null then
        INSERT INTO discussion_thread_watchers (class_id, discussion_thread_root_id, user_id, enabled) 
        VALUES (NEW.class_id, NEW.root, current_user_id, true)
        ON CONFLICT (user_id, discussion_thread_root_id) DO NOTHING;
      end if;

      -- Mark as unread for everyone in the class, excluding the current user if one exists
      if current_user_id is not null then
        INSERT INTO discussion_thread_read_status (user_id, discussion_thread_id, discussion_thread_root_id) 
        select user_id, NEW.id as discussion_thread_id, NEW.root as discussion_thread_root_id 
        from user_roles 
        where class_id = NEW.class_id and user_id != current_user_id;

        INSERT INTO discussion_thread_read_status (user_id, discussion_thread_id, discussion_thread_root_id, read_at) 
        select user_id, NEW.id as discussion_thread_id, NEW.root as discussion_thread_root_id, NEW.created_at as read_at
        from user_roles 
        where class_id = NEW.class_id and user_id = current_user_id;
      else
        -- If no current user (seeding context), mark as unread for all users in the class
        INSERT INTO discussion_thread_read_status (user_id, discussion_thread_id, discussion_thread_root_id) 
        select user_id, NEW.id as discussion_thread_id, NEW.root as discussion_thread_root_id 
        from user_roles 
        where class_id = NEW.class_id;
      end if;
      
   ELSE
      RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
   END CASE;
   
   RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.discussion_threads_notification() IS 
'Updated to notify topic followers for new posts and thread watchers for replies. Includes notification_reason and topic_id in notification body for email footer generation.';

-- Create table to store discussion digest items for hourly batching
-- Items are accumulated here until they're ready to be sent (hourly)

CREATE TABLE IF NOT EXISTS public.discussion_digest_items (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  class_id bigint NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
  thread_id bigint NOT NULL,
  thread_name text NOT NULL,
  author_name text NOT NULL,
  teaser text,
  thread_url text,
  topic_id bigint,
  notification_reason text, -- 'topic_follow' or 'thread_watch'
  action text, -- 'new_post' or 'reply'
  msg_id bigint, -- Original queue message ID for tracking
  CONSTRAINT discussion_digest_items_user_class_thread_unique UNIQUE (user_id, class_id, thread_id, created_at)
);

-- Index for efficient querying by user/class and time
CREATE INDEX IF NOT EXISTS idx_discussion_digest_items_user_class_created 
  ON public.discussion_digest_items(user_id, class_id, created_at);

-- Index for finding items ready to send (older than 1 hour)
CREATE INDEX IF NOT EXISTS idx_discussion_digest_items_created_at 
  ON public.discussion_digest_items(created_at);

-- Track last digest send time per user/class
CREATE TABLE IF NOT EXISTS public.discussion_digest_send_times (
  user_id uuid NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  class_id bigint NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
  last_sent_at timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY (user_id, class_id)
);

-- Grant permissions
GRANT ALL ON TABLE public.discussion_digest_items TO service_role;
GRANT ALL ON TABLE public.discussion_digest_send_times TO service_role;

