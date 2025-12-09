-- Discord Bot Triggers
-- Auto-create Discord channels and send notifications for help requests and regrade requests

-- 1. Function to enqueue Discord channel creation
CREATE OR REPLACE FUNCTION public.enqueue_discord_channel_creation(
  p_class_id bigint,
  p_channel_type public.discord_channel_type,
  p_resource_id bigint DEFAULT NULL,
  p_channel_name text DEFAULT NULL,
  p_guild_id text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_guild_id text;
  v_channel_group_id text;
  v_class_slug text;
  v_channel_name text;
BEGIN
  -- Get Discord server info from class
  SELECT c.discord_server_id, c.discord_channel_group_id, c.slug
  INTO v_guild_id, v_channel_group_id, v_class_slug
  FROM public.classes c
  WHERE c.id = p_class_id;

  -- Use provided guild_id or fall back to class's discord_server_id
  v_guild_id := COALESCE(p_guild_id, v_guild_id);

  -- Skip if no Discord server configured
  IF v_guild_id IS NULL THEN
    RETURN;
  END IF;

  -- Determine channel name if not provided
  IF p_channel_name IS NULL THEN
    CASE p_channel_type
      WHEN 'general' THEN
        v_channel_name := COALESCE(v_class_slug, 'general');
      WHEN 'assignment' THEN
        SELECT a.title INTO v_channel_name
        FROM public.assignments a
        WHERE a.id = p_resource_id;
        v_channel_name := COALESCE(v_channel_name, 'assignment-' || p_resource_id);
        -- Add HW prefix
        v_channel_name := 'HW: ' || v_channel_name;
      WHEN 'lab' THEN
        SELECT ls.name INTO v_channel_name
        FROM public.lab_sections ls
        WHERE ls.id = p_resource_id;
        v_channel_name := COALESCE(v_channel_name, 'lab-' || p_resource_id);
        -- Add Lab prefix
        v_channel_name := 'Lab: ' || v_channel_name;
      WHEN 'office_hours' THEN
        SELECT hq.name INTO v_channel_name
        FROM public.help_queues hq
        WHERE hq.id = p_resource_id;
        v_channel_name := COALESCE(v_channel_name, 'office-hours-' || p_resource_id);
        -- Add OH prefix
        v_channel_name := 'OH: ' || v_channel_name;
      WHEN 'regrades' THEN
        v_channel_name := 'Regrades';
      ELSE
        v_channel_name := 'channel';
    END CASE;
  ELSE
    v_channel_name := p_channel_name;
    -- Add prefix based on channel type if not already present
    IF p_channel_type = 'assignment' AND NOT v_channel_name LIKE 'HW:%' THEN
      v_channel_name := 'HW: ' || v_channel_name;
    ELSIF p_channel_type = 'lab' AND NOT v_channel_name LIKE 'Lab:%' THEN
      v_channel_name := 'Lab: ' || v_channel_name;
    ELSIF p_channel_type = 'office_hours' AND NOT v_channel_name LIKE 'OH:%' THEN
      v_channel_name := 'OH: ' || v_channel_name;
    END IF;
  END IF;

  -- Enqueue channel creation
  PERFORM pgmq_public.send(
    queue_name := 'discord_async_calls',
    message := jsonb_build_object(
      'method', 'create_channel',
      'args', jsonb_build_object(
        'guild_id', v_guild_id,
        'name', v_channel_name,
        'type', 0, -- Text channel
        'parent_id', v_channel_group_id
      ),
      'class_id', p_class_id,
      'channel_type', p_channel_type,
      'resource_id', p_resource_id
    )
  );
END;
$$;

-- 2. Function to enqueue Discord message for help request
CREATE OR REPLACE FUNCTION public.enqueue_discord_help_request_message(
  p_help_request_id bigint,
  p_action text DEFAULT 'created' -- 'created', 'updated', 'resolved'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_help_request RECORD;
  v_queue RECORD;
  v_class RECORD;
  v_discord_channel_id text;
  v_student_names text[];
  v_student_name text;
  v_message_content text;
  v_embed jsonb;
  v_status_color integer;
  v_status_emoji text;
BEGIN
  -- Get help request details
  SELECT 
    hr.id,
    hr.class_id,
    hr.help_queue,
    hr.status,
    hr.request,
    hr.assignee,
    hr.created_by,
    hr.resolved_at,
    hr.resolved_by
  INTO v_help_request
  FROM public.help_requests hr
  WHERE hr.id = p_help_request_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Get class Discord info
  SELECT c.discord_server_id, c.slug
  INTO v_class
  FROM public.classes c
  WHERE c.id = v_help_request.class_id;

  -- Skip if no Discord server configured
  IF v_class.discord_server_id IS NULL THEN
    RETURN;
  END IF;

  -- Get queue info
  SELECT hq.name, hq.id
  INTO v_queue
  FROM public.help_queues hq
  WHERE hq.id = v_help_request.help_queue;

  -- Get Discord channel for this queue
  SELECT dc.discord_channel_id
  INTO v_discord_channel_id
  FROM public.discord_channels dc
  WHERE dc.class_id = v_help_request.class_id
    AND dc.channel_type = 'office_hours'
    AND dc.resource_id = v_help_request.help_queue;

  -- Skip if no channel found
  IF v_discord_channel_id IS NULL THEN
    RETURN;
  END IF;

  -- Get student names
  SELECT ARRAY_AGG(p.name ORDER BY p.name)
  INTO v_student_names
  FROM public.help_request_students hrs
  JOIN public.profiles p ON p.id = hrs.profile_id
  WHERE hrs.help_request_id = p_help_request_id;

  v_student_name := COALESCE(array_to_string(v_student_names, ', '), 'Unknown Student');

  -- Determine status color and emoji
  CASE v_help_request.status
    WHEN 'open' THEN
      v_status_color := 3447003; -- Blue
      v_status_emoji := '🟦';
    WHEN 'in_progress' THEN
      v_status_color := 15844367; -- Gold
      v_status_emoji := '🟨';
    WHEN 'resolved' THEN
      v_status_color := 3066993; -- Green
      v_status_emoji := '🟩';
    WHEN 'closed' THEN
      v_status_color := 9807270; -- Grey
      v_status_emoji := '⬜';
    ELSE
      v_status_color := 9807270;
      v_status_emoji := '⚪';
  END CASE;

  -- Build message content
  IF p_action = 'created' THEN
    v_message_content := format('**New Help Request** | Queue: %s', COALESCE(v_queue.name, 'Office Hours'));
  ELSIF p_action = 'updated' THEN
    v_message_content := format('**Help Request Updated** | Queue: %s', COALESCE(v_queue.name, 'Office Hours'));
  ELSIF p_action = 'resolved' THEN
    v_message_content := format('**Help Request Resolved** | Queue: %s', COALESCE(v_queue.name, 'Office Hours'));
  ELSE
    v_message_content := format('**Help Request** | Queue: %s', COALESCE(v_queue.name, 'Office Hours'));
  END IF;

  -- Build embed
  v_embed := jsonb_build_object(
    'title', format('Help Request #%s', v_help_request.id),
    'description', LEFT(v_help_request.request, 500),
    'color', v_status_color,
    'fields', jsonb_build_array(
      jsonb_build_object('name', 'Student', 'value', v_student_name, 'inline', true),
      jsonb_build_object('name', 'Status', 'value', format('%s %s', v_status_emoji, UPPER(v_help_request.status::text)), 'inline', true)
    ),
    'footer', jsonb_build_object('text', format('Request ID: %s', v_help_request.id)),
    'timestamp', NOW()::text
  );

  -- Add assignee if present
  IF v_help_request.assignee IS NOT NULL THEN
    SELECT p.name INTO v_student_name
    FROM public.profiles p
    WHERE p.id = v_help_request.assignee;
    
    v_embed := jsonb_set(
      v_embed,
      '{fields}',
      (v_embed->'fields') || jsonb_build_object('name', 'Assigned To', 'value', COALESCE(v_student_name, 'Unknown'), 'inline', true)
    );
  END IF;

  -- Check if message already exists (for updates)
  IF p_action != 'created' THEN
    DECLARE
      v_existing_message_id text;
    BEGIN
      SELECT dm.discord_message_id
      INTO v_existing_message_id
      FROM public.discord_messages dm
      WHERE dm.class_id = v_help_request.class_id
        AND dm.resource_type = 'help_request'
        AND dm.resource_id = p_help_request_id;

      IF v_existing_message_id IS NOT NULL THEN
        -- Update existing message
        PERFORM pgmq_public.send(
          queue_name := 'discord_async_calls',
          message := jsonb_build_object(
            'method', 'update_message',
            'args', jsonb_build_object(
              'channel_id', v_discord_channel_id,
              'message_id', v_existing_message_id,
              'content', v_message_content,
              'embeds', jsonb_build_array(v_embed)
            ),
            'class_id', v_help_request.class_id
          )
        );
        RETURN;
      END IF;
    END;
  END IF;

  -- Send new message
  PERFORM pgmq_public.send(
    queue_name := 'discord_async_calls',
    message := jsonb_build_object(
      'method', 'send_message',
      'args', jsonb_build_object(
        'channel_id', v_discord_channel_id,
        'content', v_message_content,
        'embeds', jsonb_build_array(v_embed)
      ),
      'class_id', v_help_request.class_id,
      'resource_type', 'help_request',
      'resource_id', p_help_request_id
    )
  );
END;
$$;

-- 3. Function to enqueue Discord message for regrade request
CREATE OR REPLACE FUNCTION public.enqueue_discord_regrade_request_message(
  p_regrade_request_id bigint,
  p_action text DEFAULT 'created' -- 'created', 'updated', 'resolved', 'escalated'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_regrade_request RECORD;
  v_class RECORD;
  v_discord_channel_id text;
  v_student_name text;
  v_grader_name text;
  v_message_content text;
  v_embed jsonb;
  v_status_color integer;
  v_status_emoji text;
  v_mention_user_id text;
BEGIN
  -- Get regrade request details
  SELECT 
    srr.id,
    srr.class_id,
    srr.assignment_id,
    srr.submission_id,
    srr.status,
    srr.assignee,
    srr.created_by,
    srr.escalated_by,
    srr.resolved_by,
    srr.initial_points,
    srr.resolved_points,
    srr.closed_points
  INTO v_regrade_request
  FROM public.submission_regrade_requests srr
  WHERE srr.id = p_regrade_request_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Get class Discord info
  SELECT c.discord_server_id, c.slug
  INTO v_class
  FROM public.classes c
  WHERE c.id = v_regrade_request.class_id;

  -- Skip if no Discord server configured
  IF v_class.discord_server_id IS NULL THEN
    RETURN;
  END IF;

  -- Get Discord channel for regrades
  SELECT dc.discord_channel_id
  INTO v_discord_channel_id
  FROM public.discord_channels dc
  WHERE dc.class_id = v_regrade_request.class_id
    AND dc.channel_type = 'regrades';

  -- Create regrades channel if it doesn't exist
  IF v_discord_channel_id IS NULL THEN
    PERFORM public.enqueue_discord_channel_creation(
      v_regrade_request.class_id,
      'regrades',
      NULL,
      'regrades',
      v_class.discord_server_id
    );
    -- Wait a bit for channel creation, then retry (or skip for now)
    RETURN;
  END IF;

  -- Get student name
  SELECT p.name INTO v_student_name
  FROM public.profiles p
  WHERE p.id = v_regrade_request.created_by;

  -- Get grader name
  SELECT p.name INTO v_grader_name
  FROM public.profiles p
  WHERE p.id = v_regrade_request.assignee;

  -- Get Discord user ID for mention
  SELECT u.discord_id INTO v_mention_user_id
  FROM public.users u
  JOIN public.user_roles ur ON ur.user_id = u.user_id
  JOIN public.profiles p ON p.id = v_regrade_request.assignee
  WHERE ur.private_profile_id = v_regrade_request.assignee
    AND ur.class_id = v_regrade_request.class_id
    AND u.discord_id IS NOT NULL
  LIMIT 1;

  -- Determine status color and emoji
  CASE v_regrade_request.status
    WHEN 'draft' THEN
      v_status_color := 9807270; -- Grey
      v_status_emoji := '📝';
    WHEN 'opened' THEN
      v_status_color := 3447003; -- Blue
      v_status_emoji := '🔵';
    WHEN 'resolved' THEN
      v_status_color := 3066993; -- Green
      v_status_emoji := '✅';
    WHEN 'escalated' THEN
      v_status_color := 15158332; -- Red
      v_status_emoji := '🚨';
    WHEN 'closed' THEN
      v_status_color := 9807270; -- Grey
      v_status_emoji := '🔒';
    ELSE
      v_status_color := 9807270;
      v_status_emoji := '⚪';
  END CASE;

  -- Build message content with mention
  IF p_action = 'created' OR p_action = 'updated' THEN
    IF v_mention_user_id IS NOT NULL THEN
      v_message_content := format('**New Regrade Request** <@%s>', v_mention_user_id);
    ELSE
      v_message_content := format('**New Regrade Request** (Grader: %s)', COALESCE(v_grader_name, 'Unknown'));
    END IF;
  ELSIF p_action = 'escalated' THEN
    v_message_content := '**Regrade Request Escalated** @instructors';
  ELSE
    v_message_content := format('**Regrade Request %s**', UPPER(p_action));
  END IF;

  -- Build embed
  v_embed := jsonb_build_object(
    'title', format('Regrade Request #%s', v_regrade_request.id),
    'color', v_status_color,
    'fields', jsonb_build_array(
      jsonb_build_object('name', 'Student', 'value', COALESCE(v_student_name, 'Unknown'), 'inline', true),
      jsonb_build_object('name', 'Status', 'value', format('%s %s', v_status_emoji, UPPER(v_regrade_request.status::text)), 'inline', true),
      jsonb_build_object('name', 'Grader', 'value', COALESCE(v_grader_name, 'Unknown'), 'inline', true)
    ),
    'footer', jsonb_build_object('text', format('Request ID: %s', v_regrade_request.id)),
    'timestamp', NOW()::text
  );

  -- Add points info
  IF v_regrade_request.initial_points IS NOT NULL THEN
    v_embed := jsonb_set(
      v_embed,
      '{fields}',
      (v_embed->'fields') || jsonb_build_object('name', 'Initial Points', 'value', v_regrade_request.initial_points::text, 'inline', true)
    );
  END IF;

  IF v_regrade_request.resolved_points IS NOT NULL THEN
    v_embed := jsonb_set(
      v_embed,
      '{fields}',
      (v_embed->'fields') || jsonb_build_object('name', 'Resolved Points', 'value', v_regrade_request.resolved_points::text, 'inline', true)
    );
  END IF;

  -- Check if message already exists (for updates)
  IF p_action != 'created' THEN
    DECLARE
      v_existing_message_id text;
    BEGIN
      SELECT dm.discord_message_id
      INTO v_existing_message_id
      FROM public.discord_messages dm
      WHERE dm.class_id = v_regrade_request.class_id
        AND dm.resource_type = 'regrade_request'
        AND dm.resource_id = p_regrade_request_id;

      IF v_existing_message_id IS NOT NULL THEN
        -- Update existing message
        PERFORM pgmq_public.send(
          queue_name := 'discord_async_calls',
          message := jsonb_build_object(
            'method', 'update_message',
            'args', jsonb_build_object(
              'channel_id', v_discord_channel_id,
              'message_id', v_existing_message_id,
              'content', v_message_content,
              'embeds', jsonb_build_array(v_embed)
            ),
            'class_id', v_regrade_request.class_id
          )
        );
        RETURN;
      END IF;
    END;
  END IF;

  -- Send new message
  PERFORM pgmq_public.send(
    queue_name := 'discord_async_calls',
    message := jsonb_build_object(
      'method', 'send_message',
      'args', jsonb_build_object(
        'channel_id', v_discord_channel_id,
        'content', v_message_content,
        'embeds', jsonb_build_array(v_embed),
        'allowed_mentions', jsonb_build_object(
          'users', CASE WHEN v_mention_user_id IS NOT NULL THEN jsonb_build_array(v_mention_user_id) ELSE '[]'::jsonb END
        )
      ),
      'class_id', v_regrade_request.class_id,
      'resource_type', 'regrade_request',
      'resource_id', p_regrade_request_id
    )
  );
END;
$$;

-- 4. Triggers for channel creation
CREATE OR REPLACE FUNCTION public.trigger_discord_channel_creation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'assignments' THEN
    PERFORM public.enqueue_discord_channel_creation(
      NEW.class_id,
      'assignment',
      NEW.id,
      NULL,
      NULL
    );
  ELSIF TG_TABLE_NAME = 'lab_sections' THEN
    PERFORM public.enqueue_discord_channel_creation(
      NEW.class_id,
      'lab',
      NEW.id,
      NULL,
      NULL
    );
  ELSIF TG_TABLE_NAME = 'help_queues' THEN
    PERFORM public.enqueue_discord_channel_creation(
      NEW.class_id,
      'office_hours',
      NEW.id,
      NULL,
      NULL
    );
  END IF;
  RETURN NEW;
END;
$$;

-- Create triggers
DROP TRIGGER IF EXISTS trg_discord_create_assignment_channel ON public.assignments;
CREATE TRIGGER trg_discord_create_assignment_channel
  AFTER INSERT ON public.assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_discord_channel_creation();

DROP TRIGGER IF EXISTS trg_discord_create_lab_channel ON public.lab_sections;
CREATE TRIGGER trg_discord_create_lab_channel
  AFTER INSERT ON public.lab_sections
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_discord_channel_creation();

DROP TRIGGER IF EXISTS trg_discord_create_queue_channel ON public.help_queues;
CREATE TRIGGER trg_discord_create_queue_channel
  AFTER INSERT ON public.help_queues
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_discord_channel_creation();

-- 5. Triggers for help request notifications
CREATE OR REPLACE FUNCTION public.trigger_discord_help_request_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- On INSERT: send created message
  IF TG_OP = 'INSERT' THEN
    PERFORM public.enqueue_discord_help_request_message(NEW.id, 'created');
    RETURN NEW;
  END IF;

  -- On UPDATE: send updated message if status changed
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
      IF NEW.status = 'resolved' THEN
        PERFORM public.enqueue_discord_help_request_message(NEW.id, 'resolved');
      ELSE
        PERFORM public.enqueue_discord_help_request_message(NEW.id, 'updated');
      END IF;
    ELSIF OLD.assignee IS DISTINCT FROM NEW.assignee THEN
      -- Assignment changed
      PERFORM public.enqueue_discord_help_request_message(NEW.id, 'updated');
    END IF;
    RETURN NEW;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_discord_help_request_notification ON public.help_requests;
CREATE TRIGGER trg_discord_help_request_notification
  AFTER INSERT OR UPDATE ON public.help_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_discord_help_request_notification();

-- 6. Triggers for regrade request notifications
CREATE OR REPLACE FUNCTION public.trigger_discord_regrade_request_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- On INSERT: only send if status is 'opened' (not 'draft')
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'opened' THEN
      PERFORM public.enqueue_discord_regrade_request_message(NEW.id, 'created');
    END IF;
    RETURN NEW;
  END IF;

  -- On UPDATE: send notification on status changes
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
      IF NEW.status = 'escalated' THEN
        PERFORM public.enqueue_discord_regrade_request_message(NEW.id, 'escalated');
      ELSIF NEW.status = 'resolved' THEN
        PERFORM public.enqueue_discord_regrade_request_message(NEW.id, 'resolved');
      ELSIF NEW.status = 'closed' THEN
        PERFORM public.enqueue_discord_regrade_request_message(NEW.id, 'closed');
      ELSIF NEW.status = 'opened' AND OLD.status = 'draft' THEN
        PERFORM public.enqueue_discord_regrade_request_message(NEW.id, 'created');
      ELSE
        PERFORM public.enqueue_discord_regrade_request_message(NEW.id, 'updated');
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_discord_regrade_request_notification ON public.submission_regrade_requests;
CREATE TRIGGER trg_discord_regrade_request_notification
  AFTER INSERT OR UPDATE ON public.submission_regrade_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_discord_regrade_request_notification();

-- Grant execute permissions
REVOKE EXECUTE ON FUNCTION public.enqueue_discord_channel_creation(bigint, public.discord_channel_type, bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_discord_channel_creation(bigint, public.discord_channel_type, bigint, text, text) TO postgres;

REVOKE EXECUTE ON FUNCTION public.enqueue_discord_help_request_message(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_discord_help_request_message(bigint, text) TO postgres;

REVOKE EXECUTE ON FUNCTION public.enqueue_discord_regrade_request_message(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_discord_regrade_request_message(bigint, text) TO postgres;
