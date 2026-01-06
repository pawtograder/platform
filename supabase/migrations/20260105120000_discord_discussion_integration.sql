-- Discord Discussion Forum Integration
-- Adds Discord integration for discussion forums, mirroring help request/regrade request pattern

-- 1. Add 'discussion_thread' to discord_resource_type enum
ALTER TYPE public.discord_resource_type ADD VALUE IF NOT EXISTS 'discussion_thread';

-- 2. Add 'forum' to discord_channel_type enum
ALTER TYPE public.discord_channel_type ADD VALUE IF NOT EXISTS 'forum';

-- 3. Add discord_channel_id to discussion_topics
ALTER TABLE public.discussion_topics
ADD COLUMN IF NOT EXISTS discord_channel_id TEXT;

-- 4. Create enum for discussion Discord notification preferences
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'discussion_discord_notification_type') THEN
        CREATE TYPE public.discussion_discord_notification_type AS ENUM ('all', 'followed_only', 'none');
    END IF;
END $$;

-- 5. Add discussion_discord_notification column to notification_preferences
ALTER TABLE public.notification_preferences 
ADD COLUMN IF NOT EXISTS discussion_discord_notification public.discussion_discord_notification_type NOT NULL DEFAULT 'all';

-- 6. Create trigger function to enqueue Discord messages for discussion threads
CREATE OR REPLACE FUNCTION public.enqueue_discord_discussion_thread_message(p_thread_id bigint, p_action text DEFAULT 'created'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_thread RECORD;
  v_topic RECORD;
  v_class RECORD;
  v_author_name text;
  v_message_content text;
  v_embed jsonb;
  v_status_color integer;
  v_type_emoji text;
  v_type_label text;
  v_answered_text text;
  v_existing_message_id text;
BEGIN
  -- Get thread details
  SELECT 
    dt.id,
    dt.class_id,
    dt.topic_id,
    dt.subject,
    dt.body,
    dt.is_question,
    dt.answer,
    dt.author,
    dt.instructors_only,
    dt.likes_count,
    dt.children_count,
    dt.created_at
  INTO v_thread
  FROM public.discussion_threads dt
  WHERE dt.id = p_thread_id
    AND dt.root IS NULL  -- Only root threads
    AND dt.draft = false; -- Only published threads

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Skip instructors_only threads (staff-only discussions shouldn't go to Discord)
  IF v_thread.instructors_only THEN
    RETURN;
  END IF;

  -- Get topic details including discord_channel_id
  SELECT 
    dtp.id,
    dtp.topic,
    dtp.discord_channel_id
  INTO v_topic
  FROM public.discussion_topics dtp
  WHERE dtp.id = v_thread.topic_id;

  IF NOT FOUND OR v_topic.discord_channel_id IS NULL THEN
    -- Topic not linked to Discord channel
    RETURN;
  END IF;

  -- Get class Discord info
  SELECT c.discord_server_id, c.slug, c.name
  INTO v_class
  FROM public.classes c
  WHERE c.id = v_thread.class_id;

  -- Skip if no Discord server configured
  IF v_class.discord_server_id IS NULL THEN
    RETURN;
  END IF;

  -- Get author name (use public profile name, or 'Anonymous' if not available)
  SELECT COALESCE(p.name, 'Anonymous')
  INTO v_author_name
  FROM public.profiles p
  WHERE p.id = v_thread.author;

  IF v_author_name IS NULL THEN
    v_author_name := 'Anonymous';
  END IF;

  -- Determine type emoji and label
  IF v_thread.is_question THEN
    v_type_emoji := '❓';
    v_type_label := 'Question';
  ELSE
    v_type_emoji := '📝';
    v_type_label := 'Note';
  END IF;

  -- Determine status color
  -- Blue for notes, orange for unanswered questions, green for answered questions
  IF NOT v_thread.is_question THEN
    v_status_color := 3447003; -- Blue
  ELSIF v_thread.answer IS NOT NULL THEN
    v_status_color := 3066993; -- Green (answered)
  ELSE
    v_status_color := 15105570; -- Orange (unanswered question)
  END IF;

  -- Build answered status text
  IF v_thread.is_question THEN
    IF v_thread.answer IS NOT NULL THEN
      v_answered_text := '✅ Answered';
    ELSE
      v_answered_text := '⏳ Awaiting Answer';
    END IF;
  ELSE
    v_answered_text := NULL;
  END IF;

  -- Build message content
  IF p_action = 'created' THEN
    v_message_content := format('**New %s in %s**', v_type_label, v_topic.topic);
  ELSIF p_action = 'answered' THEN
    v_message_content := format('**%s Answered in %s**', v_type_label, v_topic.topic);
  ELSIF p_action = 'updated' THEN
    v_message_content := format('**%s Updated in %s**', v_type_label, v_topic.topic);
  ELSE
    v_message_content := format('**%s %s in %s**', v_type_label, UPPER(p_action), v_topic.topic);
  END IF;

  -- Build embed
  v_embed := jsonb_build_object(
    'title', format('%s %s', v_type_emoji, v_thread.subject),
    'description', LEFT(COALESCE(v_thread.body, 'No content'), 500),
    'color', v_status_color,
    'fields', jsonb_build_array(
      jsonb_build_object('name', 'Author', 'value', v_author_name, 'inline', true),
      jsonb_build_object('name', 'Type', 'value', format('%s %s', v_type_emoji, v_type_label), 'inline', true)
    ),
    'footer', jsonb_build_object('text', format('Thread #%s | Topic: %s', v_thread.id, v_topic.topic)),
    'timestamp', v_thread.created_at::text
  );

  -- Add answered status for questions
  IF v_answered_text IS NOT NULL THEN
    v_embed := jsonb_set(
      v_embed,
      '{fields}',
      (v_embed->'fields') || jsonb_build_object(
        'name', 'Status', 
        'value', v_answered_text, 
        'inline', true
      )
    );
  END IF;

  -- Add stats field
  v_embed := jsonb_set(
    v_embed,
    '{fields}',
    (v_embed->'fields') || jsonb_build_object(
      'name', 'Stats', 
      'value', format('💬 %s replies | ❤️ %s likes', COALESCE(v_thread.children_count, 0), COALESCE(v_thread.likes_count, 0)), 
      'inline', false
    )
  );

  -- Check if message already exists (for updates)
  SELECT dm.discord_message_id
  INTO v_existing_message_id
  FROM public.discord_messages dm
  WHERE dm.class_id = v_thread.class_id
    AND dm.resource_type = 'discussion_thread'
    AND dm.resource_id = p_thread_id;

  IF v_existing_message_id IS NOT NULL THEN
    -- Update existing message
    PERFORM pgmq_public.send(
      queue_name := 'discord_async_calls',
      message := jsonb_build_object(
        'method', 'update_message',
        'args', jsonb_build_object(
          'channel_id', v_topic.discord_channel_id,
          'message_id', v_existing_message_id,
          'content', v_message_content,
          'embeds', jsonb_build_array(v_embed)
        ),
        'class_id', v_thread.class_id,
        'resource_type', 'discussion_thread',
        'resource_id', p_thread_id
      )
    );
    RETURN;
  END IF;

  -- Send new message (only if no existing message was found)
  PERFORM pgmq_public.send(
    queue_name := 'discord_async_calls',
    message := jsonb_build_object(
      'method', 'send_message',
      'args', jsonb_build_object(
        'channel_id', v_topic.discord_channel_id,
        'content', v_message_content,
        'embeds', jsonb_build_array(v_embed)
      ),
      'class_id', v_thread.class_id,
      'resource_type', 'discussion_thread',
      'resource_id', p_thread_id
    )
  );
END;
$function$;

-- 7. Create trigger for new root threads (INSERT)
CREATE OR REPLACE FUNCTION public.discussion_thread_discord_insert_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Only trigger for root threads (not replies) that are not drafts
  IF NEW.root IS NULL AND NEW.draft = false THEN
    PERFORM public.enqueue_discord_discussion_thread_message(NEW.id, 'created');
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS discussion_thread_discord_insert ON public.discussion_threads;
CREATE TRIGGER discussion_thread_discord_insert
  AFTER INSERT ON public.discussion_threads
  FOR EACH ROW
  EXECUTE FUNCTION public.discussion_thread_discord_insert_trigger();

-- 8. Create trigger for answer status changes (UPDATE)
CREATE OR REPLACE FUNCTION public.discussion_thread_discord_answer_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Only trigger for root threads when answer status changes
  IF NEW.root IS NULL AND OLD.answer IS DISTINCT FROM NEW.answer THEN
    IF NEW.answer IS NOT NULL THEN
      PERFORM public.enqueue_discord_discussion_thread_message(NEW.id, 'answered');
    ELSE
      -- Answer was removed (unmarked)
      PERFORM public.enqueue_discord_discussion_thread_message(NEW.id, 'updated');
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS discussion_thread_discord_answer_update ON public.discussion_threads;
CREATE TRIGGER discussion_thread_discord_answer_update
  AFTER UPDATE ON public.discussion_threads
  FOR EACH ROW
  WHEN (OLD.answer IS DISTINCT FROM NEW.answer)
  EXECUTE FUNCTION public.discussion_thread_discord_answer_trigger();

-- 9. Create trigger for draft -> published transition
CREATE OR REPLACE FUNCTION public.discussion_thread_discord_publish_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Trigger when a root thread goes from draft to published
  IF NEW.root IS NULL AND OLD.draft = true AND NEW.draft = false THEN
    PERFORM public.enqueue_discord_discussion_thread_message(NEW.id, 'created');
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS discussion_thread_discord_publish ON public.discussion_threads;
CREATE TRIGGER discussion_thread_discord_publish
  AFTER UPDATE ON public.discussion_threads
  FOR EACH ROW
  WHEN (OLD.draft = true AND NEW.draft = false)
  EXECUTE FUNCTION public.discussion_thread_discord_publish_trigger();

-- 10. Grant execute permissions
REVOKE ALL ON FUNCTION public.enqueue_discord_discussion_thread_message(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_discord_discussion_thread_message(bigint, text) TO service_role;

-- 11. Add index for efficient Discord channel lookup on topics
CREATE INDEX IF NOT EXISTS idx_discussion_topics_discord_channel 
  ON public.discussion_topics (discord_channel_id) 
  WHERE discord_channel_id IS NOT NULL;

-- 12. Index for finding threads with Discord messages for stats updates
-- Note: Partial index with WHERE resource_type = 'discussion_thread' cannot be created
-- in the same transaction as ADD VALUE. The existing idx_discord_messages_class_resource
-- index on (class_id, resource_type, resource_id) will be used instead.

-- 13. Schedule hourly cron job for Discord discussion stats update
-- Note: This requires the pg_cron extension and net extension to be enabled
-- The cron job calls the edge function every hour to refresh stats in Discord messages
DO $$
BEGIN
  -- Check if cron extension is available and unschedule if job exists
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('discord-discussion-stats-update');
    EXCEPTION WHEN OTHERS THEN
      -- Job doesn't exist, continue
      NULL;
    END;
  END IF;
END $$;

DO $body$
DECLARE
  v_supabase_url text;
  v_edge_function_secret text;
BEGIN
  -- Check if cron and net extensions are available
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') 
     AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    
    -- Get Supabase URL from vault
    SELECT decrypted_secret INTO v_supabase_url
    FROM vault.decrypted_secrets 
    WHERE name = 'supabase_project_url';
    
    -- Get edge function secret from vault
    SELECT decrypted_secret INTO v_edge_function_secret
    FROM vault.decrypted_secrets
    WHERE name = 'edge-function-secret';
    
    IF v_supabase_url IS NOT NULL AND v_supabase_url != 'null' 
       AND v_edge_function_secret IS NOT NULL AND v_edge_function_secret != 'null' THEN
      -- Schedule the cron job to run every hour at minute 30
      PERFORM cron.schedule(
        'discord-discussion-stats-update',
        '30 * * * *',  -- Every hour at :30
        format(
          $sql$SELECT net.http_post(
            url := '%s/functions/v1/discord-discussion-stats-update',
            headers := jsonb_build_object(
              'Content-Type', 'application/json',
              'x-edge-function-secret', '%s'
            ),
            body := '{}'::jsonb
          )$sql$,
          v_supabase_url,
          v_edge_function_secret
        )
      );
      RAISE NOTICE 'Scheduled discord-discussion-stats-update cron job';
    ELSE
      RAISE NOTICE 'Skipping cron job scheduling: missing vault secrets (supabase_project_url or edge-function-secret)';
    END IF;
  ELSE
    RAISE NOTICE 'Skipping cron job scheduling: pg_cron or pg_net extension not available';
  END IF;
END $body$;

