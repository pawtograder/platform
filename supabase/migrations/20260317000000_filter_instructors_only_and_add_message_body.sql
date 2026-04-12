-- Fix email digest privacy leak: filter instructors_only threads from student notifications,
-- add full message body to notifications, and clean up existing leaked data.
--
-- 1. Update discussion_threads_notification: filter students for instructors_only threads,
--    add message_body to notification body
-- 2. Add body column to discussion_digest_items
-- 3. Delete notifications and digest items that students shouldn't see

-- Step 1a: Update discussion_threads_notification - add instructors_only filter for topic followers
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
           'message_body', left(NEW.body, 1000),
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
           'message_body', left(NEW.body, 1000),
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
          -- For instructors_only threads: only notify instructors and graders, not students
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
            -- For instructors_only threads: only notify staff (instructors and graders)
            AND (
              (NOT COALESCE((SELECT dt2.instructors_only FROM discussion_threads dt2 WHERE dt2.id = NEW.root), false))
              OR (ur.role IN ('instructor', 'grader'))
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
          -- For instructors_only threads: only notify staff (instructor, grader), not students
          INSERT INTO notifications (class_id, subject, body, style, user_id)
          SELECT NEW.class_id, subject, body, style, discussion_thread_watchers.user_id
          FROM discussion_thread_watchers
          WHERE discussion_thread_root_id = NEW.root
            AND enabled = true
            AND user_id != current_user_id
            -- For instructors_only threads: only notify staff
            AND (
              (NOT COALESCE((SELECT dt.instructors_only FROM discussion_threads dt WHERE dt.id = NEW.root), false))
              OR EXISTS (
                SELECT 1 FROM user_roles ur
                WHERE ur.user_id = discussion_thread_watchers.user_id
                  AND ur.class_id = NEW.class_id
                  AND ur.role IN ('instructor', 'grader')
                  AND ur.disabled = false
              )
            )
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
'Updated to notify topic followers for new posts and thread watchers for replies. Filters out students for instructors_only threads. Includes notification_reason, topic_id, and message_body in notification body.';

-- Step 2: Add body column to discussion_digest_items
ALTER TABLE public.discussion_digest_items
ADD COLUMN IF NOT EXISTS body text;

-- Step 3: Delete existing notifications that students shouldn't see
DELETE FROM public.notifications n
WHERE n.body->>'type' = 'discussion_thread'
  AND (n.body->>'root_thread_id') IS NOT NULL
  AND (n.body->>'root_thread_id') ~ '^[0-9]+$'
  AND EXISTS (
    SELECT 1 FROM public.discussion_threads dt
    WHERE dt.id = (n.body->>'root_thread_id')::bigint
      AND dt.instructors_only = true
  )
  AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = n.user_id
      AND ur.class_id = n.class_id
      AND ur.role = 'student'
      AND ur.disabled = false
  );

-- Step 4: Delete existing discussion_digest_items that students shouldn't see
DELETE FROM public.discussion_digest_items ddi
WHERE EXISTS (
  SELECT 1 FROM public.discussion_threads dt
  WHERE dt.id = ddi.thread_id
    AND dt.instructors_only = true
)
AND EXISTS (
  SELECT 1 FROM public.user_roles ur
  WHERE ur.user_id = ddi.user_id
    AND ur.class_id = ddi.class_id
    AND ur.role = 'student'
    AND ur.disabled = false
);
