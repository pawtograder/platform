-- Office Hours Queue Enhancements
-- Adds: course-level description, demo queue mode, ordinal-based ordering

-- 1. Add office_hours_description to classes table
ALTER TABLE public.classes ADD COLUMN IF NOT EXISTS office_hours_description TEXT;

-- 2. Update only_calendar_or_discord_ids_changed() to allow office_hours_description
CREATE OR REPLACE FUNCTION public.only_calendar_or_discord_ids_changed(new_row public.classes)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(
    (
      SELECT COALESCE(
        (
          SELECT bool_and(changed.key = ANY(ARRAY[
            'discord_server_id',
            'discord_channel_group_id',
            'office_hours_ics_url',
            'events_ics_url',
            'office_hours_description',
            'updated_at'
          ]))
          FROM (
            SELECT t.key
            FROM jsonb_each(to_jsonb(new_row)) AS t(key, value)
            WHERE (to_jsonb(old_row)->t.key) IS DISTINCT FROM t.value
          ) AS changed
        ),
        true  -- no differences -> allow
      )
      FROM public.classes old_row
      WHERE old_row.id = new_row.id
    ),
    false -- no matching row found
  );
$$;

-- 3. Add is_demo and ordinal to help_queues table
ALTER TABLE public.help_queues ADD COLUMN IF NOT EXISTS is_demo BOOLEAN DEFAULT FALSE NOT NULL;
ALTER TABLE public.help_queues ADD COLUMN IF NOT EXISTS ordinal INTEGER DEFAULT 0 NOT NULL;

-- 4. Initialize ordinals for existing queues (per class)
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY class_id ORDER BY id) - 1 AS new_ordinal
  FROM public.help_queues
)
UPDATE public.help_queues SET ordinal = ranked.new_ordinal
FROM ranked WHERE help_queues.id = ranked.id;

-- 5. Create ordinal enforcement trigger function
CREATE OR REPLACE FUNCTION public.help_queues_enforce_ordinal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  max_ordinal integer;
BEGIN
  -- Avoid re-entrant work when our own UPDATEs fire the trigger
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  -- Take per-class advisory locks to serialize operations and avoid races
  IF TG_OP = 'UPDATE' AND NEW.class_id IS DISTINCT FROM OLD.class_id THEN
    IF OLD.class_id < NEW.class_id THEN
      PERFORM pg_advisory_xact_lock(OLD.class_id);
      PERFORM pg_advisory_xact_lock(NEW.class_id);
    ELSE
      PERFORM pg_advisory_xact_lock(NEW.class_id);
      PERFORM pg_advisory_xact_lock(OLD.class_id);
    END IF;
  ELSE
    PERFORM pg_advisory_xact_lock(NEW.class_id);
  END IF;

  -- Handle NULL or negative ordinal
  IF NEW.ordinal IS NULL THEN
    SELECT COALESCE(MAX(ordinal), -1) + 1
      INTO NEW.ordinal
      FROM public.help_queues
     WHERE class_id = NEW.class_id
       AND id != NEW.id;
  ELSIF NEW.ordinal < 0 THEN
    NEW.ordinal := 0;
  END IF;

  -- Handle conflicts by shifting other rows
  IF TG_OP = 'INSERT' THEN
    -- Shift right any conflicting or following queues
    UPDATE public.help_queues
       SET ordinal = ordinal + 1
     WHERE class_id = NEW.class_id
       AND ordinal >= NEW.ordinal
       AND id != NEW.id;

  ELSIF TG_OP = 'UPDATE' THEN
    -- Moving across classes: close gap in old, insert into new
    IF NEW.class_id IS DISTINCT FROM OLD.class_id THEN
      -- Close gap in old class
      IF OLD.ordinal IS NOT NULL THEN
        UPDATE public.help_queues
           SET ordinal = ordinal - 1
         WHERE class_id = OLD.class_id
           AND ordinal > OLD.ordinal
           AND id != NEW.id;
      END IF;

      -- Make room in new class
      UPDATE public.help_queues
         SET ordinal = ordinal + 1
       WHERE class_id = NEW.class_id
         AND ordinal >= NEW.ordinal
         AND id != NEW.id;

    -- Within same class: reposition if changed
    ELSIF NEW.ordinal IS DISTINCT FROM OLD.ordinal THEN
      -- Shift everything at the target position and beyond
      UPDATE public.help_queues
         SET ordinal = ordinal + 1
       WHERE class_id = NEW.class_id
         AND ordinal >= NEW.ordinal
         AND id != NEW.id;
      
      -- Close the gap where this queue used to be
      IF OLD.ordinal IS NOT NULL THEN
        UPDATE public.help_queues
           SET ordinal = ordinal - 1
         WHERE class_id = NEW.class_id
           AND ordinal > OLD.ordinal
           AND id != NEW.id;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END
$$;

-- 6. Create trigger for ordinal enforcement
DROP TRIGGER IF EXISTS help_queues_enforce_ordinal_tr ON public.help_queues;

CREATE TRIGGER help_queues_enforce_ordinal_tr
BEFORE INSERT OR UPDATE OF ordinal, class_id ON public.help_queues
FOR EACH ROW
EXECUTE FUNCTION public.help_queues_enforce_ordinal();

-- 7. Update create_help_request_notification to skip demo queues
CREATE OR REPLACE FUNCTION public.create_help_request_notification(
  p_class_id bigint,
  p_notification_type text,
  p_help_request_id bigint,
  p_help_queue_id bigint,
  p_help_queue_name text,
  p_creator_profile_id uuid,
  p_creator_name text,
  p_assignee_profile_id uuid DEFAULT NULL,
  p_assignee_name text DEFAULT NULL,
  p_status public.help_request_status DEFAULT NULL,
  p_request_preview text DEFAULT '',
  p_is_private boolean DEFAULT false,
  p_action text DEFAULT 'created'
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
declare
  notification_body jsonb;
  v_is_demo boolean;
begin
  -- Check if queue is demo - skip notifications for demo queues
  SELECT is_demo INTO v_is_demo
  FROM public.help_queues
  WHERE id = p_help_queue_id;

  IF v_is_demo THEN
    -- Skip all notifications for demo queues
    RETURN;
  END IF;

  if p_notification_type = 'help_request' then
    notification_body := jsonb_build_object(
      'type', 'help_request',
      'action', p_action,
      'help_request_id', p_help_request_id,
      'help_queue_id', p_help_queue_id,
      'help_queue_name', p_help_queue_name,
      'creator_profile_id', p_creator_profile_id,
      'creator_name', p_creator_name,
      'assignee_profile_id', p_assignee_profile_id,
      'assignee_name', p_assignee_name,
      'status', p_status,
      'request_preview', p_request_preview,
      -- Enrich with subject/body for email templates and digests
      'request_subject', coalesce(
        (
          select hrt.name
          from public.help_request_templates hrt
          where hrt.id = (
            select hr.template_id from public.help_requests hr where hr.id = p_help_request_id
          )
        ),
        'General'
      ),
      'request_body', (
        select hr.request from public.help_requests hr where hr.id = p_help_request_id
      ),
      'is_private', p_is_private
    );
  elsif p_notification_type is null then
    raise exception 'create_help_request_notification: p_notification_type must not be null';
  else
    -- Future-proof: explicitly reject unsupported types
    raise exception 'create_help_request_notification: unsupported p_notification_type=%', p_notification_type;
  end if;

  -- On creation: notify instructors and graders only (do NOT blast the entire class)
  if p_action = 'created' then
    insert into public.notifications (user_id, class_id, subject, body)
    select distinct
      ur.user_id,
      p_class_id,
      jsonb_build_object('text', 'Help Request ' || p_action),
      notification_body
    from public.user_roles ur
    left join public.notification_preferences np
      on np.user_id = ur.user_id and np.class_id = p_class_id
    left join public.users u
      on u.user_id = ur.user_id
    where ur.class_id = p_class_id
      and ur.role in ('instructor', 'grader')
      -- Default to 'none' if Discord linked, otherwise 'all'
      and coalesce(
        np.help_request_creation_notification::text,
        CASE 
          WHEN u.discord_id IS NOT NULL AND ur.role IN ('instructor', 'grader') THEN 'none'
          ELSE 'all'
        END
      ) <> 'none'
      and (
        coalesce(
          np.help_request_creation_notification::text,
          CASE 
            WHEN u.discord_id IS NOT NULL AND ur.role IN ('instructor', 'grader') THEN 'none'
            ELSE 'all'
          END
        ) = 'all'
        or (
          coalesce(
            np.help_request_creation_notification::text,
            CASE 
              WHEN u.discord_id IS NOT NULL AND ur.role IN ('instructor', 'grader') THEN 'none'
              ELSE 'all'
            END
          ) = 'only_active_queue'
          and exists (
            select 1
            from public.help_queue_assignments hqa
            where hqa.class_id = p_class_id
              and hqa.help_queue_id = p_help_queue_id
              and hqa.ta_profile_id = ur.private_profile_id
              and hqa.is_active = true
              and hqa.ended_at is null
          )
        )
      );

    -- Ensure the creator is watching their own request
    insert into public.help_request_watchers (user_id, help_request_id, class_id, enabled)
    select ur.user_id, p_help_request_id, p_class_id, true
    from public.user_roles ur
    where ur.private_profile_id = p_creator_profile_id
      and ur.class_id = p_class_id
    on conflict (user_id, help_request_id) do nothing;

  else
    -- For assignment/status changes: notify watchers
    insert into public.notifications (user_id, class_id, subject, body)
    select 
      hrw.user_id,
      p_class_id,
      jsonb_build_object('text', 'Help Request ' || p_action),
      notification_body
    from public.help_request_watchers hrw
    where hrw.help_request_id = p_help_request_id
      and hrw.enabled = true;
  end if;
end;
$$;

-- 8. Update trigger_discord_help_request_notification to skip demo queues
CREATE OR REPLACE FUNCTION public.trigger_discord_help_request_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_is_demo boolean;
BEGIN
  -- Check if queue is demo - skip Discord notifications for demo queues
  SELECT is_demo INTO v_is_demo
  FROM public.help_queues
  WHERE id = NEW.help_queue;

  IF v_is_demo THEN
    RETURN NEW; -- Skip Discord notifications
  END IF;

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
