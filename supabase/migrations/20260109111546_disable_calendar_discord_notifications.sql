-- Disable Discord notifications in calendar sync system
-- This migration modifies process_calendar_announcements to skip Discord message sending
-- while still marking events as announced (updating timestamps)

CREATE OR REPLACE FUNCTION public.process_calendar_announcements()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_now timestamptz := NOW();
  v_messages jsonb[] := '{}';
  v_event RECORD;
  v_channel_id text;
  v_message jsonb;
  v_has_multiple_queues boolean;
  v_queue_name text;
  v_display_name text;
  v_date_str text;
  v_time_str text;
  v_emoji text;
  v_action text;
  v_changed_ids bigint[] := '{}';
  v_started_ids bigint[] := '{}';
  v_ended_ids bigint[] := '{}';
  v_processed_count int := 0;
BEGIN
  -- 1. Process schedule change announcements (new/changed events not yet announced)
  -- Discord notifications disabled - only mark events as announced
  FOR v_event IN
    SELECT 
      ce.id,
      ce.class_id,
      ce.calendar_type,
      ce.title,
      ce.start_time,
      ce.end_time,
      ce.organizer_name,
      ce.queue_name,
      dc.discord_channel_id,
      c.time_zone
    FROM public.calendar_events ce
    INNER JOIN public.classes c ON c.id = ce.class_id AND c.discord_server_id IS NOT NULL
    LEFT JOIN public.discord_channels dc ON dc.class_id = ce.class_id AND dc.channel_type = 'scheduling'
    WHERE ce.change_announced_at IS NULL
      AND ce.end_time >= v_now
    LIMIT 500
  LOOP
    -- Discord notifications disabled - skip message creation
    -- IF v_event.discord_channel_id IS NOT NULL THEN
    --   v_date_str := to_char(v_event.start_time AT TIME ZONE v_event.time_zone, 'Dy, Mon DD');
    --   v_time_str := to_char(v_event.start_time AT TIME ZONE v_event.time_zone, 'HH12:MI AM') || ' - ' || 
    --                to_char(v_event.end_time AT TIME ZONE v_event.time_zone, 'HH12:MI AM');
    --   
    --   v_message := jsonb_build_object(
    --     'method', 'send_message',
    --     'args', jsonb_build_object(
    --       'channel_id', v_event.discord_channel_id,
    --       'content', '📅 **' || v_event.title || '** has been added to the schedule',
    --       'embeds', jsonb_build_array(jsonb_build_object(
    --         'description', '📆 ' || v_date_str || E'\n⏰ ' || v_time_str,
    --         'color', 65280 -- green
    --       ))
    --     ),
    --     'class_id', v_event.class_id
    --   );
    --   v_messages := array_append(v_messages, v_message);
    -- END IF;
    v_changed_ids := array_append(v_changed_ids, v_event.id);
  END LOOP;

  -- 2. Process start announcements (office hours and events that have started)
  -- Discord notifications disabled - only mark events as announced
  FOR v_event IN
    SELECT 
      ce.id,
      ce.class_id,
      ce.calendar_type,
      ce.title,
      ce.organizer_name,
      ce.queue_name,
      c.discord_server_id,
      -- Get office hours channel (match by queue name if multiple queues)
      CASE 
        WHEN ce.calendar_type = 'office_hours' THEN (
          SELECT dc.discord_channel_id 
          FROM public.discord_channels dc
          LEFT JOIN public.help_queues hq ON hq.id = dc.resource_id AND dc.channel_type = 'office_hours'
          WHERE dc.class_id = ce.class_id 
            AND dc.channel_type = 'office_hours'
            AND (ce.queue_name IS NULL OR hq.name ILIKE ce.queue_name OR dc.resource_id IS NULL)
          LIMIT 1
        )
        ELSE (
          SELECT dc.discord_channel_id 
          FROM public.discord_channels dc
          WHERE dc.class_id = ce.class_id AND dc.channel_type = 'operations'
          LIMIT 1
        )
      END as discord_channel_id,
      (SELECT COUNT(*) > 1 FROM public.help_queues WHERE class_id = ce.class_id) as has_multiple_queues
    FROM public.calendar_events ce
    INNER JOIN public.classes c ON c.id = ce.class_id AND c.discord_server_id IS NOT NULL
    WHERE ce.start_announced_at IS NULL
      AND ce.start_time <= v_now
    LIMIT 500
  LOOP
    -- Discord notifications disabled - skip message creation
    -- IF v_event.discord_channel_id IS NOT NULL THEN
    --   IF v_event.calendar_type = 'office_hours' THEN
    --     v_display_name := COALESCE(v_event.organizer_name, v_event.title);
    --     IF v_event.has_multiple_queues AND v_event.queue_name IS NOT NULL THEN
    --       v_display_name := v_display_name || ' (' || v_event.queue_name || ')';
    --     END IF;
    --     v_message := jsonb_build_object(
    --       'method', 'send_message',
    --       'args', jsonb_build_object(
    --         'channel_id', v_event.discord_channel_id,
    --         'content', '🟢 **' || v_display_name || '** is now on duty'
    --       ),
    --       'class_id', v_event.class_id
    --     );
    --   ELSE
    --     v_message := jsonb_build_object(
    --       'method', 'send_message',
    --       'args', jsonb_build_object(
    --         'channel_id', v_event.discord_channel_id,
    --         'content', '🚀 **' || v_event.title || '** is starting now'
    --       ),
    --       'class_id', v_event.class_id
    --     );
    --   END IF;
    --   v_messages := array_append(v_messages, v_message);
    -- END IF;
    v_started_ids := array_append(v_started_ids, v_event.id);
  END LOOP;

  -- 3. Process end announcements (office hours and events that have ended)
  -- Discord notifications disabled - only mark events as announced
  FOR v_event IN
    SELECT 
      ce.id,
      ce.class_id,
      ce.calendar_type,
      ce.title,
      ce.organizer_name,
      ce.queue_name,
      c.discord_server_id,
      CASE 
        WHEN ce.calendar_type = 'office_hours' THEN (
          SELECT dc.discord_channel_id 
          FROM public.discord_channels dc
          LEFT JOIN public.help_queues hq ON hq.id = dc.resource_id AND dc.channel_type = 'office_hours'
          WHERE dc.class_id = ce.class_id 
            AND dc.channel_type = 'office_hours'
            AND (ce.queue_name IS NULL OR hq.name ILIKE ce.queue_name OR dc.resource_id IS NULL)
          LIMIT 1
        )
        ELSE (
          SELECT dc.discord_channel_id 
          FROM public.discord_channels dc
          WHERE dc.class_id = ce.class_id AND dc.channel_type = 'operations'
          LIMIT 1
        )
      END as discord_channel_id,
      (SELECT COUNT(*) > 1 FROM public.help_queues WHERE class_id = ce.class_id) as has_multiple_queues
    FROM public.calendar_events ce
    INNER JOIN public.classes c ON c.id = ce.class_id AND c.discord_server_id IS NOT NULL
    WHERE ce.end_announced_at IS NULL
      AND ce.end_time <= v_now
    LIMIT 500
  LOOP
    -- Discord notifications disabled - skip message creation
    -- IF v_event.discord_channel_id IS NOT NULL THEN
    --   IF v_event.calendar_type = 'office_hours' THEN
    --     v_display_name := COALESCE(v_event.organizer_name, v_event.title);
    --     IF v_event.has_multiple_queues AND v_event.queue_name IS NOT NULL THEN
    --       v_display_name := v_display_name || ' (' || v_event.queue_name || ')';
    --     END IF;
    --     v_message := jsonb_build_object(
    --       'method', 'send_message',
    --       'args', jsonb_build_object(
    --         'channel_id', v_event.discord_channel_id,
    --         'content', '🔴 **' || v_display_name || '** is now off duty'
    --       ),
    --       'class_id', v_event.class_id
    --     );
    --   ELSE
    --     v_message := jsonb_build_object(
    --       'method', 'send_message',
    --       'args', jsonb_build_object(
    --         'channel_id', v_event.discord_channel_id,
    --         'content', '✅ **' || v_event.title || '** has ended'
    --       ),
    --       'class_id', v_event.class_id
    --     );
    --   END IF;
    --   v_messages := array_append(v_messages, v_message);
    -- END IF;
    v_ended_ids := array_append(v_ended_ids, v_event.id);
  END LOOP;

  -- 4. Batch insert all messages into pgmq
  -- Discord notifications disabled - skip message queueing
  -- IF array_length(v_messages, 1) > 0 THEN
  --   PERFORM pgmq_public.send_batch(
  --     queue_name := 'discord_async_calls',
  --     messages := v_messages
  --   );
  -- END IF;

  -- 5. Batch update announcement timestamps (still update to mark events as processed)
  IF array_length(v_changed_ids, 1) > 0 THEN
    UPDATE public.calendar_events
    SET change_announced_at = v_now
    WHERE id = ANY(v_changed_ids);
  END IF;

  IF array_length(v_started_ids, 1) > 0 THEN
    UPDATE public.calendar_events
    SET start_announced_at = v_now
    WHERE id = ANY(v_started_ids);
  END IF;

  IF array_length(v_ended_ids, 1) > 0 THEN
    UPDATE public.calendar_events
    SET end_announced_at = v_now
    WHERE id = ANY(v_ended_ids);
  END IF;

  v_processed_count := COALESCE(array_length(v_changed_ids, 1), 0) + 
                       COALESCE(array_length(v_started_ids, 1), 0) + 
                       COALESCE(array_length(v_ended_ids, 1), 0);

  RETURN jsonb_build_object(
    'success', true,
    'processed_count', v_processed_count,
    'messages_queued', 0, -- Always 0 since Discord notifications are disabled
    'change_announcements', COALESCE(array_length(v_changed_ids, 1), 0),
    'start_announcements', COALESCE(array_length(v_started_ids, 1), 0),
    'end_announcements', COALESCE(array_length(v_ended_ids, 1), 0)
  );
END;
$function$
;
