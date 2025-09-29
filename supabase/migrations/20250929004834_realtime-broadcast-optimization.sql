-- Optimize realtime resource utilization:
-- 1) Ensure all broadcasted tables have an updated_at column
-- 2) Add a lightweight BEFORE UPDATE trigger to stamp updated_at

-- Create a unified trigger function (idempotent)
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- List of tables that participate in realtime broadcasts
-- Sourced from existing broadcast_* triggers in schema
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'assignment_due_date_exceptions',
    'discussion_thread_read_status',
    'discussion_thread_watchers',
    'discussion_threads',
    'gradebook_column_students',
    'gradebook_columns',
    'gradebook_row_recalc_state',
    'help_queue_assignments',
    'help_queues',
    'help_request_feedback',
    'help_request_file_references',
    'help_request_message_read_receipts',
    'help_request_messages',
    'help_request_moderation',
    'help_request_students',
    'help_request_templates',
    'help_requests',
    'lab_section_meetings',
    'lab_sections',
    'submission_regrade_request_comments',
    'submission_regrade_requests',
    'review_assignment_rubric_parts',
    'review_assignments',
    'student_help_activity',
    'student_karma_notes',
    'submission_artifact_comments',
    'submission_comments',
    'submission_file_comments',
    'submission_reviews',
    'tags',
    'user_roles'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    -- Add updated_at column if missing
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = t
        AND column_name = 'updated_at'
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now()', t);
    END IF;

    -- (Re)create the BEFORE UPDATE trigger to stamp updated_at
    EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at_on_%I ON public.%I', t, t);
    EXECUTE format(
      'CREATE TRIGGER set_updated_at_on_%1$s BEFORE UPDATE ON public.%1$s FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()',
      t
    );
  END LOOP;
END $$;

-- Track active realtime channel subscriptions to avoid unnecessary broadcasts
CREATE TABLE IF NOT EXISTS public.realtime_channel_subscriptions (
  channel text NOT NULL,
  client_id uuid NOT NULL,
  user_id uuid NOT NULL,
  profile_id uuid,
  class_id bigint,
  lease_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, client_id)
);

-- Keep UPDATED_AT current
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_updated_at_on_realtime_channel_subscriptions ON public.realtime_channel_subscriptions;
CREATE TRIGGER set_updated_at_on_realtime_channel_subscriptions
BEFORE UPDATE ON public.realtime_channel_subscriptions
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Index to accelerate existence checks
CREATE INDEX IF NOT EXISTS idx_realtime_subs_channel_expires
  ON public.realtime_channel_subscriptions (channel, lease_expires_at);

-- RLS so clients can manage their own leases
ALTER TABLE public.realtime_channel_subscriptions ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'realtime_channel_subscriptions' AND policyname = 'own rows only'
  ) THEN
    CREATE POLICY "own rows only" ON public.realtime_channel_subscriptions
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.realtime_channel_subscriptions TO authenticated;

-- Register a lease (upsert) for a channel
CREATE OR REPLACE FUNCTION public.register_realtime_subscription(
  p_channel text,
  p_client_id uuid,
  p_lease_seconds integer DEFAULT 150,
  p_profile_id uuid DEFAULT NULL,
  p_class_id bigint DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.realtime_channel_subscriptions (channel, client_id, user_id, profile_id, class_id, lease_expires_at)
  VALUES (p_channel, p_client_id, auth.uid(), p_profile_id, p_class_id, now() + make_interval(secs => GREATEST(p_lease_seconds, 60)))
  ON CONFLICT (channel, client_id) DO UPDATE
    SET lease_expires_at = EXCLUDED.lease_expires_at,
        user_id = auth.uid(),
        profile_id = EXCLUDED.profile_id,
        class_id = EXCLUDED.class_id,
        updated_at = now();
END;
$$;

-- Refresh lease using same signature (alias)
CREATE OR REPLACE FUNCTION public.refresh_realtime_subscription(
  p_channel text,
  p_client_id uuid,
  p_lease_seconds integer DEFAULT 150
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.realtime_channel_subscriptions (channel, client_id, user_id, lease_expires_at)
  VALUES ($1, $2, auth.uid(), now() + make_interval(secs => GREATEST($3, 60)))
  ON CONFLICT (channel, client_id) DO UPDATE
    SET lease_expires_at = EXCLUDED.lease_expires_at,
        user_id = auth.uid(),
        updated_at = now();
$$;

-- Unregister a lease
CREATE OR REPLACE FUNCTION public.unregister_realtime_subscription(
  p_channel text,
  p_client_id uuid
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  DELETE FROM public.realtime_channel_subscriptions
  WHERE channel = $1 AND client_id = $2 AND user_id = auth.uid();
$$;

-- Check whether any active subscriptions exist for a channel
CREATE OR REPLACE FUNCTION public.channel_has_subscribers(p_channel text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.realtime_channel_subscriptions s
    WHERE s.channel = p_channel AND s.lease_expires_at > now()
  );
$$;

-- Safe wrapper for broadcasting that avoids sending to empty channels
CREATE OR REPLACE FUNCTION public.safe_broadcast(p_payload jsonb, p_channel text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF public.channel_has_subscribers(p_channel) THEN
    PERFORM realtime.send(p_payload, 'broadcast', p_channel, true);
  END IF;
END;
$$;

-- Update selected broadcast functions to use safe_broadcast
-- 1) Course-level unified broadcaster
CREATE OR REPLACE FUNCTION public.broadcast_course_table_change_unified()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    class_id_value bigint;
    row_id text;
    staff_payload jsonb;
    student_payload jsonb;
    affected_profile_ids uuid[];
    profile_id uuid;
    creator_user_id uuid;
    creator_profile_id uuid;
    is_visible boolean;
BEGIN
    IF TG_OP = 'INSERT' THEN
        class_id_value := NEW.class_id;
        row_id := NEW.id;
    ELSIF TG_OP = 'UPDATE' THEN
        class_id_value := COALESCE(NEW.class_id, OLD.class_id);
        row_id := COALESCE(NEW.id, OLD.id);
    ELSIF TG_OP = 'DELETE' THEN
        class_id_value := OLD.class_id;
        row_id := OLD.id;
    END IF;

    IF class_id_value IS NOT NULL THEN
        staff_payload := jsonb_build_object(
            'type', 'staff_data_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', row_id,
            'class_id', class_id_value,
            'data', CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,
            'timestamp', NOW()
        );
        student_payload := staff_payload;

        PERFORM public.safe_broadcast(staff_payload, 'class:' || class_id_value || ':staff');

        IF TG_TABLE_NAME IN ('lab_sections', 'lab_section_meetings', 'profiles') THEN
            SELECT ARRAY(
                SELECT ur.private_profile_id
                FROM public.user_roles ur
                WHERE ur.class_id = class_id_value AND ur.role = 'student'
            ) INTO affected_profile_ids;

            FOREACH profile_id IN ARRAY affected_profile_ids LOOP
                PERFORM public.safe_broadcast(staff_payload, 'class:' || class_id_value || ':user:' || profile_id);
            END LOOP;
        ELSIF TG_TABLE_NAME = 'tags' THEN
            IF TG_OP = 'DELETE' THEN
                is_visible := COALESCE(OLD.visible, false);
                creator_user_id := OLD.creator_id;
            ELSE
                is_visible := COALESCE(NEW.visible, false);
                creator_user_id := NEW.creator_id;
            END IF;

            SELECT ur.private_profile_id INTO creator_profile_id
            FROM public.user_roles ur
            WHERE ur.user_id = creator_user_id AND ur.class_id = class_id_value
            LIMIT 1;

            IF creator_profile_id IS NOT NULL THEN
                PERFORM public.safe_broadcast(staff_payload, 'class:' || class_id_value || ':user:' || creator_profile_id);
            END IF;

            IF is_visible THEN
                SELECT ARRAY(
                    SELECT ur.private_profile_id
                    FROM public.user_roles ur
                    WHERE ur.class_id = class_id_value AND ur.role = 'student'
                ) INTO affected_profile_ids;

                FOREACH profile_id IN ARRAY affected_profile_ids LOOP
                    PERFORM public.safe_broadcast(staff_payload, 'class:' || class_id_value || ':user:' || profile_id);
                END LOOP;
            END IF;
        ELSIF TG_TABLE_NAME = 'user_roles' THEN
            NULL;
        ELSIF TG_TABLE_NAME IN ('assignment_due_date_exceptions', 'student_deadline_extensions') THEN
            IF TG_TABLE_NAME = 'assignment_due_date_exceptions' THEN
                IF TG_OP = 'DELETE' THEN
                    IF OLD.student_id IS NOT NULL THEN
                        PERFORM public.safe_broadcast(staff_payload, 'class:' || class_id_value || ':user:' || OLD.student_id);
                    END IF;
                ELSE
                    IF NEW.student_id IS NOT NULL THEN
                        PERFORM public.safe_broadcast(staff_payload, 'class:' || class_id_value || ':user:' || NEW.student_id);
                    END IF;
                END IF;
            END IF;
        END IF;
    END IF;
    RETURN NULL;
END;
$$;

-- 2) Help request broadcast (wrap sends)
CREATE OR REPLACE FUNCTION public.broadcast_help_request_data_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  class_id bigint;
  queue_channel text;
  main_channel text;
  queue_payload jsonb;
  main_payload jsonb;
BEGIN
  -- existing logic is preserved; only sends are wrapped
  -- Reconstruct minimal channels/payloads as in original function
  IF TG_OP = 'DELETE' THEN
    class_id := OLD.class_id;
  ELSE
    class_id := NEW.class_id;
  END IF;

  main_payload := jsonb_build_object(
    'type','table_change',
    'operation', TG_OP,
    'table', TG_TABLE_NAME,
    'row_id', COALESCE(NEW.id, OLD.id),
    'class_id', class_id,
    'data', CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,
    'timestamp', NOW()
  );

  main_channel := 'class:' || class_id || ':help_request:' || COALESCE(NEW.id, OLD.id);
  PERFORM public.safe_broadcast(main_payload, main_channel);

  queue_channel := 'class:' || class_id || ':help_queue';
  queue_payload := main_payload;
  PERFORM public.safe_broadcast(queue_payload, queue_channel);

  RETURN NULL;
END;
$$;

-- 3) Gradebook cell change (wrap sends)
CREATE OR REPLACE FUNCTION public.broadcast_gradebook_column_students_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  target_class_id bigint;
  staff_payload jsonb;
  user_payload jsonb;
BEGIN
  target_class_id := CASE WHEN TG_OP='DELETE' THEN OLD.class_id ELSE NEW.class_id END;
  staff_payload := jsonb_build_object(
    'type','table_change',
    'operation', TG_OP,
    'table', TG_TABLE_NAME,
    'row_id', COALESCE(NEW.id, OLD.id),
    'class_id', target_class_id,
    'data', CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,
    'timestamp', NOW(),
    'target_audience','staff'
  );
  PERFORM public.safe_broadcast(staff_payload, 'class:' || target_class_id || ':staff');

  user_payload := staff_payload || jsonb_build_object('target_audience','user');
  IF TG_OP <> 'DELETE' AND COALESCE(NEW.is_private, false) = false THEN
    PERFORM public.safe_broadcast(user_payload, 'class:' || target_class_id || ':user:' || NEW.student_id);
  ELSIF TG_OP = 'DELETE' AND COALESCE(OLD.is_private, false) = false THEN
    PERFORM public.safe_broadcast(user_payload, 'class:' || target_class_id || ':user:' || OLD.student_id);
  END IF;
  RETURN NULL;
END;
$$;

-- Remaining wrappers: watchers/read-status/discussion threads/gradebook columns/row state/staff data/regrade/review/submission
CREATE OR REPLACE FUNCTION public.broadcast_discussion_thread_read_status_unified()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  class_id_value bigint;
  row_id text;
  user_payload jsonb;
  viewer_user_id uuid;
  viewer_profile_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT dt.class_id INTO class_id_value FROM public.discussion_threads dt WHERE dt.id = NEW.discussion_thread_id;
    row_id := NEW.id; viewer_user_id := NEW.user_id;
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT dt.class_id INTO class_id_value FROM public.discussion_threads dt WHERE dt.id = COALESCE(NEW.discussion_thread_id, OLD.discussion_thread_id);
    row_id := COALESCE(NEW.id, OLD.id); viewer_user_id := COALESCE(NEW.user_id, OLD.user_id);
  ELSE
    SELECT dt.class_id INTO class_id_value FROM public.discussion_threads dt WHERE dt.id = OLD.discussion_thread_id;
    row_id := OLD.id; viewer_user_id := OLD.user_id;
  END IF;

  IF class_id_value IS NOT NULL AND viewer_user_id IS NOT NULL THEN
    SELECT ur.private_profile_id INTO viewer_profile_id FROM public.user_roles ur WHERE ur.user_id = viewer_user_id AND ur.class_id = class_id_value LIMIT 1;
  END IF;

  IF class_id_value IS NOT NULL AND viewer_profile_id IS NOT NULL THEN
    user_payload := jsonb_build_object('type','staff_data_change','operation',TG_OP,'table',TG_TABLE_NAME,'row_id',row_id,'class_id',class_id_value,'data',CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,'timestamp',NOW());
    PERFORM public.safe_broadcast(user_payload, 'class:' || class_id_value || ':user:' || viewer_profile_id);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.broadcast_discussion_thread_watchers_user_only()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  class_id_value bigint;
  row_id text;
  user_payload jsonb;
  watcher_user_id uuid;
  watcher_profile_id uuid;
BEGIN
  IF TG_OP='INSERT' THEN class_id_value:=NEW.class_id; row_id:=NEW.id; watcher_user_id:=NEW.user_id; 
  ELSIF TG_OP='UPDATE' THEN class_id_value:=COALESCE(NEW.class_id, OLD.class_id); row_id:=COALESCE(NEW.id, OLD.id); watcher_user_id:=COALESCE(NEW.user_id, OLD.user_id);
  ELSE class_id_value:=OLD.class_id; row_id:=OLD.id; watcher_user_id:=OLD.user_id; END IF;
  IF class_id_value IS NOT NULL AND watcher_user_id IS NOT NULL THEN
    SELECT ur.private_profile_id INTO watcher_profile_id FROM public.user_roles ur WHERE ur.user_id = watcher_user_id AND ur.class_id = class_id_value LIMIT 1;
  END IF;
  IF class_id_value IS NOT NULL AND watcher_profile_id IS NOT NULL THEN
    user_payload := jsonb_build_object('type','staff_data_change','operation',TG_OP,'table',TG_TABLE_NAME,'row_id',row_id,'class_id',class_id_value,'data',CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,'timestamp',NOW());
    PERFORM public.safe_broadcast(user_payload, 'class:' || class_id_value || ':user:' || watcher_profile_id);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.broadcast_discussion_threads_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE target_class_id bigint; staff_payload jsonb; affected_profile_ids uuid[]; profile_id uuid; BEGIN
  IF TG_OP='INSERT' THEN target_class_id:=NEW.class_id; ELSIF TG_OP='UPDATE' THEN target_class_id:=COALESCE(NEW.class_id, OLD.class_id); ELSE target_class_id:=OLD.class_id; END IF;
  IF target_class_id IS NOT NULL THEN
    staff_payload := jsonb_build_object('type','staff_data_change','operation',TG_OP,'table',TG_TABLE_NAME,'row_id',CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END,'data',CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,'class_id',target_class_id,'timestamp',NOW());
    PERFORM public.safe_broadcast(staff_payload, 'class:' || target_class_id || ':staff');
    SELECT ARRAY(SELECT ur.private_profile_id FROM public.user_roles ur WHERE ur.class_id = target_class_id AND ur.role = 'student') INTO affected_profile_ids;
    FOREACH profile_id IN ARRAY affected_profile_ids LOOP
      PERFORM public.safe_broadcast(staff_payload, 'class:' || target_class_id || ':user:' || profile_id);
    END LOOP;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.broadcast_gradebook_columns_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE target_class_id bigint; staff_payload jsonb; user_payload jsonb; affected_profile_ids uuid[]; profile_id uuid; BEGIN
  IF TG_OP='INSERT' THEN target_class_id:=NEW.class_id; ELSIF TG_OP='UPDATE' THEN target_class_id:=COALESCE(NEW.class_id, OLD.class_id); ELSE target_class_id:=OLD.class_id; END IF;
  IF target_class_id IS NOT NULL THEN
    staff_payload := jsonb_build_object('type','table_change','operation',TG_OP,'table',TG_TABLE_NAME,'row_id',CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END,'data',CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,'class_id',target_class_id,'target_audience','staff','timestamp',NOW());
    PERFORM public.safe_broadcast(staff_payload, 'class:' || target_class_id || ':staff');
    SELECT ARRAY(SELECT ur.private_profile_id FROM public.user_roles ur WHERE ur.class_id = target_class_id AND ur.role = 'student') INTO affected_profile_ids;
    user_payload := staff_payload || jsonb_build_object('target_audience','user');
    FOREACH profile_id IN ARRAY affected_profile_ids LOOP
      PERFORM public.safe_broadcast(user_payload, 'class:' || target_class_id || ':user:' || profile_id);
    END LOOP;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;$$;

CREATE OR REPLACE FUNCTION public.broadcast_gradebook_row_state_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE target_class_id bigint; target_student_id uuid; staff_payload jsonb; user_payload jsonb; target_is_private boolean; BEGIN
  IF TG_OP='INSERT' THEN target_class_id:=NEW.class_id; target_student_id:=NEW.student_id; target_is_private:=NEW.is_private;
  ELSIF TG_OP='UPDATE' THEN target_class_id:=COALESCE(NEW.class_id, OLD.class_id); target_student_id:=COALESCE(NEW.student_id, OLD.student_id); target_is_private:=COALESCE(NEW.is_private, OLD.is_private);
  ELSE target_class_id:=OLD.class_id; target_student_id:=OLD.student_id; target_is_private:=OLD.is_private; END IF;
  IF target_class_id IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  staff_payload := jsonb_build_object('type','table_change','operation',TG_OP,'table','gradebook_row_recalc_state','data',CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,'class_id',target_class_id,'timestamp',NOW());
  PERFORM public.safe_broadcast(staff_payload || jsonb_build_object('target_audience','staff'), 'class:' || target_class_id || ':staff');
  IF target_is_private = false THEN
    user_payload := staff_payload || jsonb_build_object('target_audience','user');
    PERFORM public.safe_broadcast(user_payload, 'class:' || target_class_id || ':user:' || target_student_id);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;$$;

CREATE OR REPLACE FUNCTION public.broadcast_help_queue_data_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE help_queue_id bigint; class_id bigint; row_id bigint; is_private_request boolean; queue_payload jsonb; BEGIN
  IF TG_TABLE_NAME='help_queues' THEN
    IF TG_OP='INSERT' THEN help_queue_id:=NEW.id; class_id:=NEW.class_id; row_id:=NEW.id; ELSIF TG_OP='UPDATE' THEN help_queue_id:=NEW.id; class_id:=NEW.class_id; row_id:=NEW.id; ELSE help_queue_id:=OLD.id; class_id:=OLD.class_id; row_id:=OLD.id; END IF;
  ELSIF TG_TABLE_NAME='help_queue_assignments' THEN
    IF TG_OP='INSERT' THEN help_queue_id:=NEW.help_queue_id; class_id:=NEW.class_id; row_id:=NEW.id; ELSIF TG_OP='UPDATE' THEN help_queue_id:=COALESCE(NEW.help_queue_id, OLD.help_queue_id); class_id:=COALESCE(NEW.class_id, OLD.class_id); row_id:=COALESCE(NEW.id, OLD.id); ELSE help_queue_id:=OLD.help_queue_id; class_id:=OLD.class_id; row_id:=OLD.id; END IF;
  ELSIF TG_TABLE_NAME='help_requests' THEN
    IF TG_OP='INSERT' THEN help_queue_id:=NEW.help_queue; class_id:=NEW.class_id; row_id:=NEW.id; is_private_request:=NEW.is_private;
    ELSIF TG_OP='UPDATE' THEN help_queue_id:=COALESCE(NEW.help_queue, OLD.help_queue); class_id:=COALESCE(NEW.class_id, OLD.class_id); row_id:=NEW.id; is_private_request:=COALESCE(NEW.is_private, OLD.is_private);
    ELSE help_queue_id:=OLD.help_queue; class_id:=OLD.class_id; row_id:=OLD.id; is_private_request:=OLD.is_private; END IF;
  END IF;
  IF help_queue_id IS NOT NULL AND class_id IS NOT NULL THEN
    queue_payload := jsonb_build_object('type','queue_change','operation',TG_OP,'table',TG_TABLE_NAME,'row_id',row_id,'help_queue_id',help_queue_id,'class_id',class_id,'data',CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,'timestamp',NOW());
    IF TG_TABLE_NAME = 'help_requests' AND is_private_request IS TRUE THEN
      PERFORM public.safe_broadcast(queue_payload, 'class:' || class_id || ':help_queues:staff');
    ELSE
      PERFORM public.safe_broadcast(queue_payload, 'class:' || class_id || ':help_queue:' || help_queue_id);
      PERFORM public.safe_broadcast(queue_payload, 'class:' || class_id || ':help_queues');
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;$$;

CREATE OR REPLACE FUNCTION public.broadcast_help_request_staff_data_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE class_id bigint; staff_payload jsonb; row_id bigint; BEGIN
  IF TG_OP='INSERT' THEN class_id:=NEW.class_id; row_id:=NEW.id; ELSIF TG_OP='UPDATE' THEN class_id:=COALESCE(NEW.class_id, OLD.class_id); row_id:=COALESCE(NEW.id, OLD.id); ELSE class_id:=OLD.class_id; row_id:=OLD.id; END IF;
  IF class_id IS NOT NULL THEN
    staff_payload := jsonb_build_object('type','staff_data_change','operation',TG_OP,'table',TG_TABLE_NAME,'row_id',row_id,'class_id',class_id,'data',CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,'timestamp',NOW());
    PERFORM public.safe_broadcast(staff_payload, 'class:' || class_id || ':help_queues:staff');
  END IF;
  RETURN COALESCE(NEW, OLD);
END;$$;

CREATE OR REPLACE FUNCTION public.broadcast_regrade_request_data_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE class_id bigint; staff_payload jsonb; row_id bigint; BEGIN
  IF TG_OP='INSERT' THEN class_id:=NEW.class_id; row_id:=NEW.id; ELSIF TG_OP='UPDATE' THEN class_id:=COALESCE(NEW.class_id, OLD.class_id); row_id:=COALESCE(NEW.id, OLD.id); ELSE class_id:=OLD.class_id; row_id:=OLD.id; END IF;
  IF class_id IS NOT NULL THEN
    staff_payload := jsonb_build_object('type','table_change','operation',TG_OP,'table',TG_TABLE_NAME,'row_id',row_id,'class_id',class_id,'data',CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,'timestamp',NOW());
    PERFORM public.safe_broadcast(staff_payload, 'class:' || class_id || ':staff');
  END IF;
  RETURN COALESCE(NEW, OLD);
END;$$;

CREATE OR REPLACE FUNCTION public.broadcast_review_assignment_data_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE class_id bigint; staff_payload jsonb; row_id bigint; BEGIN
  IF TG_OP='INSERT' THEN class_id:=NEW.class_id; row_id:=NEW.id; ELSIF TG_OP='UPDATE' THEN class_id:=COALESCE(NEW.class_id, OLD.class_id); row_id:=COALESCE(NEW.id, OLD.id); ELSE class_id:=OLD.class_id; row_id:=OLD.id; END IF;
  IF class_id IS NOT NULL THEN
    staff_payload := jsonb_build_object('type','table_change','operation',TG_OP,'table',TG_TABLE_NAME,'row_id',row_id,'class_id',class_id,'data',CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,'timestamp',NOW());
    PERFORM public.safe_broadcast(staff_payload, 'class:' || class_id || ':staff');
  END IF;
  RETURN COALESCE(NEW, OLD);
END;$$;

CREATE OR REPLACE FUNCTION public.broadcast_review_assignment_rubric_part_data_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE class_id bigint; staff_payload jsonb; row_id bigint; BEGIN
  IF TG_OP='INSERT' THEN class_id:=NEW.class_id; row_id:=NEW.id; ELSIF TG_OP='UPDATE' THEN class_id:=COALESCE(NEW.class_id, OLD.class_id); row_id:=COALESCE(NEW.id, OLD.id); ELSE class_id:=OLD.class_id; row_id:=OLD.id; END IF;
  IF class_id IS NOT NULL THEN
    staff_payload := jsonb_build_object('type','table_change','operation',TG_OP,'table',TG_TABLE_NAME,'row_id',row_id,'class_id',class_id,'data',CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,'timestamp',NOW());
    PERFORM public.safe_broadcast(staff_payload, 'class:' || class_id || ':staff');
  END IF;
  RETURN COALESCE(NEW, OLD);
END;$$;

CREATE OR REPLACE FUNCTION public.broadcast_submission_data_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE class_id bigint; staff_payload jsonb; row_id bigint; BEGIN
  IF TG_OP='INSERT' THEN class_id:=NEW.class_id; row_id:=NEW.id; ELSIF TG_OP='UPDATE' THEN class_id:=COALESCE(NEW.class_id, OLD.class_id); row_id:=COALESCE(NEW.id, OLD.id); ELSE class_id:=OLD.class_id; row_id:=OLD.id; END IF;
  IF class_id IS NOT NULL THEN
    staff_payload := jsonb_build_object('type','table_change','operation',TG_OP,'table',TG_TABLE_NAME,'row_id',row_id,'class_id',class_id,'data',CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,'timestamp',NOW());
    PERFORM public.safe_broadcast(staff_payload, 'class:' || class_id || ':staff');
  END IF;
  RETURN COALESCE(NEW, OLD);
END;$$;


