-- Optimize process_calendar_announcements RPC to remove LIMIT 500 caps
-- Uses batch UPDATE with RETURNING instead of row-by-row processing
-- This fixes bugs where events beyond 500 were never processed

CREATE OR REPLACE FUNCTION public.process_calendar_announcements()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_changed_count int := 0;
  v_started_count int := 0;
  v_ended_count int := 0;
BEGIN
  -- 1. Batch update change announcements (no LIMIT - processes all eligible events)
  -- Events that need change announcements: not past, not already announced, have Discord server
  WITH updated AS (
    UPDATE public.calendar_events ce
    SET change_announced_at = NOW()
    FROM public.classes c
    WHERE c.id = ce.class_id
      AND c.discord_server_id IS NOT NULL
      AND ce.change_announced_at IS NULL
      AND ce.end_time >= NOW()
    RETURNING ce.id
  )
  SELECT COUNT(*) INTO v_changed_count FROM updated;

  -- 2. Batch update start announcements (no LIMIT - processes all eligible events)
  -- Events that have started but not yet announced
  WITH updated AS (
    UPDATE public.calendar_events ce
    SET start_announced_at = NOW()
    FROM public.classes c
    WHERE c.id = ce.class_id
      AND c.discord_server_id IS NOT NULL
      AND ce.start_announced_at IS NULL
      AND ce.start_time <= NOW()
    RETURNING ce.id
  )
  SELECT COUNT(*) INTO v_started_count FROM updated;

  -- 3. Batch update end announcements (no LIMIT - processes all eligible events)
  -- Events that have ended but not yet announced
  WITH updated AS (
    UPDATE public.calendar_events ce
    SET end_announced_at = NOW()
    FROM public.classes c
    WHERE c.id = ce.class_id
      AND c.discord_server_id IS NOT NULL
      AND ce.end_announced_at IS NULL
      AND ce.end_time <= NOW()
    RETURNING ce.id
  )
  SELECT COUNT(*) INTO v_ended_count FROM updated;

  RETURN jsonb_build_object(
    'success', true,
    'processed_count', v_changed_count + v_started_count + v_ended_count,
    'messages_queued', 0, -- Always 0 since Discord notifications are disabled
    'change_announcements', v_changed_count,
    'start_announcements', v_started_count,
    'end_announcements', v_ended_count
  );
END;
$function$;
