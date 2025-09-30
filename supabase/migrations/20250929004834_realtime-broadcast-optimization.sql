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
    'student_deadline_extensions',
    'profiles',
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
      WITH CHECK (user_id = auth.uid() AND lease_expires_at <= now() + interval '15 minutes');
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
DECLARE
  guarded_user_id uuid;
  capped_lease_seconds integer;
BEGIN
  -- Guard against NULL auth.uid() with fallback
  guarded_user_id := COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid);
  
  -- Cap lease duration to prevent permanent leases (min 60s, max 3600s = 1 hour)
  capped_lease_seconds := LEAST(GREATEST(p_lease_seconds, 60), 3600);
  
  INSERT INTO public.realtime_channel_subscriptions (channel, client_id, user_id, profile_id, class_id, lease_expires_at)
  VALUES (p_channel, p_client_id, guarded_user_id, p_profile_id, p_class_id, now() + make_interval(secs => capped_lease_seconds))
  ON CONFLICT (channel, client_id) DO UPDATE
    SET lease_expires_at = EXCLUDED.lease_expires_at,
        user_id = guarded_user_id,
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
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  guarded_user_id uuid;
  capped_lease_seconds integer;
BEGIN
  -- Guard against NULL auth.uid() with fallback
  guarded_user_id := COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid);
  
  -- Cap lease duration to prevent permanent leases (min 60s, max 3600s = 1 hour)
  capped_lease_seconds := LEAST(GREATEST(p_lease_seconds, 60), 3600);
  
  INSERT INTO public.realtime_channel_subscriptions (channel, client_id, user_id, lease_expires_at)
  VALUES (p_channel, p_client_id, guarded_user_id, now() + make_interval(secs => capped_lease_seconds))
  ON CONFLICT (channel, client_id) DO UPDATE
    SET lease_expires_at = EXCLUDED.lease_expires_at,
        user_id = guarded_user_id,
        updated_at = now();
END;
$$;

-- Unregister a lease
CREATE OR REPLACE FUNCTION public.unregister_realtime_subscription(
  p_channel text,
  p_client_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  guarded_user_id uuid;
BEGIN
  -- Guard against NULL auth.uid() with fallback
  guarded_user_id := COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid);
  
  DELETE FROM public.realtime_channel_subscriptions
  WHERE channel = p_channel AND client_id = p_client_id AND user_id = guarded_user_id;
END;
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
CREATE OR REPLACE FUNCTION public.safe_broadcast(p_payload jsonb, p_event text, p_channel text, p_private boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF public.channel_has_subscribers(p_channel) THEN
    PERFORM realtime.send(p_payload, p_event, p_channel, p_private);
  END IF;
END;
$$;

-- Update selected broadcast functions to use safe_broadcast
-- 1) Course-level unified broadcaster
CREATE OR REPLACE FUNCTION "public"."broadcast_course_table_change_unified"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
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
    -- Get the class_id and row_id from the record
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

    -- Only broadcast if we have valid class_id
    IF class_id_value IS NOT NULL THEN
        -- Create payload with table-specific information (staff scoped)
        staff_payload := jsonb_build_object(
            'type', 'staff_data_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', row_id,
            'class_id', class_id_value,
            'data', CASE 
                WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
                ELSE to_jsonb(NEW)
            END,
            'timestamp', NOW()
        );

        -- For student-facing notifications, start with the same payload (can be minimized later)
        student_payload := staff_payload;

        -- Broadcast to staff channel
        PERFORM public.safe_broadcast(
            staff_payload,
            'broadcast',
            'class:' || class_id_value || ':staff',
            true
        );

        -- Student-facing broadcasts by table, mirroring office-hours pattern where safe
        IF TG_TABLE_NAME IN ('lab_sections', 'lab_section_meetings', 'profiles') THEN
            -- Broadcast to all students in the class
            SELECT ARRAY(
                SELECT ur.private_profile_id
                FROM public.user_roles ur
                WHERE ur.class_id = class_id_value AND ur.role = 'student'
            ) INTO affected_profile_ids;

            FOREACH profile_id IN ARRAY affected_profile_ids LOOP
                PERFORM public.safe_broadcast(
                    staff_payload,
                    'broadcast',
                    'class:' || class_id_value || ':user:' || profile_id,
                    true
                );
            END LOOP;
        ELSIF TG_TABLE_NAME = 'tags' THEN
            -- Tags visible to class → broadcast to all students; non-visible → only to creator
            IF TG_OP = 'DELETE' THEN
                is_visible := COALESCE(OLD.visible, false);
                creator_user_id := OLD.creator_id;
            ELSE
                is_visible := COALESCE(NEW.visible, false);
                creator_user_id := NEW.creator_id;
            END IF;

            -- Notify creator for any change (even when not visible)
            SELECT ur.private_profile_id INTO creator_profile_id
            FROM public.user_roles ur
            WHERE ur.user_id = creator_user_id AND ur.class_id = class_id_value
            LIMIT 1;

            IF creator_profile_id IS NOT NULL THEN
                PERFORM public.safe_broadcast(
                    staff_payload,
                    'broadcast',
                    'class:' || class_id_value || ':user:' || creator_profile_id,
                    true
                );
            END IF;

            -- If visible, also broadcast to all students in the class
            IF is_visible THEN
                SELECT ARRAY(
                    SELECT ur.private_profile_id
                    FROM public.user_roles ur
                    WHERE ur.class_id = class_id_value AND ur.role = 'student'
                ) INTO affected_profile_ids;

                FOREACH profile_id IN ARRAY affected_profile_ids LOOP
                    PERFORM public.safe_broadcast(
                        staff_payload,
                        'broadcast',
                        'class:' || class_id_value || ':user:' || profile_id,
                        true
                    );
                END LOOP;
            END IF;
        ELSIF TG_TABLE_NAME = 'user_roles' THEN
            -- OPTIMIZATION: user_roles changes now ONLY go to staff
            -- Removed individual user notification - staff visibility is sufficient
            -- This eliminates unnecessary broadcasts when users join/leave classes
            NULL; -- No additional broadcasts beyond staff channel
        ELSIF TG_TABLE_NAME IN ('assignment_due_date_exceptions', 'student_deadline_extensions') THEN
            -- These tables affect specific students or groups
            -- Staff always see all changes (already handled above)

            -- For assignment_due_date_exceptions: notify affected students/groups
            IF TG_TABLE_NAME = 'assignment_due_date_exceptions' THEN
                IF TG_OP = 'DELETE' THEN
                    -- Notify the affected student if individual exception
                    IF OLD.student_id IS NOT NULL THEN
                        PERFORM public.safe_broadcast(
                            staff_payload,
                            'broadcast',
                            'class:' || class_id_value || ':user:' || OLD.student_id,
                            true
                        );
                    END IF;
                    -- For group exceptions, notify all group members
                    IF OLD.assignment_group_id IS NOT NULL THEN
                        SELECT ARRAY(
                            SELECT agm.profile_id
                            FROM public.assignment_groups_members agm
                            WHERE agm.assignment_group_id = OLD.assignment_group_id
                        ) INTO affected_profile_ids;

                        FOREACH profile_id IN ARRAY affected_profile_ids LOOP
                            PERFORM public.safe_broadcast(
                                staff_payload,
                                'broadcast',
                                'class:' || class_id_value || ':user:' || profile_id,
                                true
                            );
                        END LOOP;
                    END IF;
                ELSE
                    -- For INSERT/UPDATE operations
                    IF NEW.student_id IS NOT NULL THEN
                        PERFORM public.safe_broadcast(
                            staff_payload,
                            'broadcast',
                            'class:' || class_id_value || ':user:' || NEW.student_id,
                            true
                        );
                    END IF;
                    IF NEW.assignment_group_id IS NOT NULL THEN
                        SELECT ARRAY(
                            SELECT agm.profile_id
                            FROM public.assignment_groups_members agm
                            WHERE agm.assignment_group_id = NEW.assignment_group_id
                        ) INTO affected_profile_ids;

                        FOREACH profile_id IN ARRAY affected_profile_ids LOOP
                            PERFORM public.safe_broadcast(
                                staff_payload,
                                'broadcast',
                                'class:' || class_id_value || ':user:' || profile_id,
                                true
                            );
                        END LOOP;
                    END IF;
                END IF;
            ELSIF TG_TABLE_NAME = 'student_deadline_extensions' THEN
                -- Notify the specific student about their extension
                IF TG_OP = 'DELETE' THEN
                    PERFORM public.safe_broadcast(
                        staff_payload,
                        'broadcast',
                        'class:' || class_id_value || ':user:' || OLD.student_id,
                        true
                    );
                ELSE
                    PERFORM public.safe_broadcast(
                        staff_payload,
                        'broadcast',
                        'class:' || class_id_value || ':user:' || NEW.student_id,
                        true
                    );
                END IF;
            END IF;
        END IF;
    END IF;

    -- Return the appropriate record
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$;

-- 2) Help request broadcast (wrap sends)
CREATE OR REPLACE FUNCTION public.broadcast_help_request_data_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    help_request_id BIGINT;
    class_id BIGINT;
    row_id BIGINT;
    is_private BOOLEAN;
    main_payload JSONB;
BEGIN
    -- Get the help_request_id and class_id based on the table
    IF TG_TABLE_NAME = 'help_requests' THEN
        IF TG_OP = 'INSERT' THEN
            help_request_id := NEW.id;
            class_id := NEW.class_id;
            row_id := NEW.id;
            is_private := NEW.is_private;
        ELSIF TG_OP = 'UPDATE' THEN
            help_request_id := NEW.id;
            class_id := NEW.class_id;
            row_id := NEW.id;
            is_private := NEW.is_private;
        ELSIF TG_OP = 'DELETE' THEN
            help_request_id := OLD.id;
            class_id := OLD.class_id;
            row_id := OLD.id;
            is_private := OLD.is_private;
        END IF;
    ELSE
        -- For related tables, derive help_request_id and class_id
        IF TG_TABLE_NAME = 'help_request_message_read_receipts' THEN
            IF TG_OP = 'INSERT' THEN
                help_request_id := COALESCE(NEW.help_request_id, (
                    SELECT hrm.help_request_id FROM public.help_request_messages hrm WHERE hrm.id = NEW.message_id
                ));
                row_id := NEW.id;
            ELSIF TG_OP = 'UPDATE' THEN
                help_request_id := COALESCE(NEW.help_request_id, (
                    SELECT hrm.help_request_id FROM public.help_request_messages hrm WHERE hrm.id = NEW.message_id
                ));
                row_id := NEW.id;
            ELSIF TG_OP = 'DELETE' THEN
                help_request_id := COALESCE(OLD.help_request_id, (
                    SELECT hrm.help_request_id FROM public.help_request_messages hrm WHERE hrm.id = OLD.message_id
                ));
                row_id := OLD.id;
            END IF;
        ELSE
            IF TG_OP = 'INSERT' THEN
                help_request_id := NEW.help_request_id;
                class_id := NEW.class_id;
                row_id := NEW.id;
            ELSIF TG_OP = 'UPDATE' THEN
                help_request_id := COALESCE(NEW.help_request_id, OLD.help_request_id);
                class_id := COALESCE(NEW.class_id, OLD.class_id);
                row_id := NEW.id;
            ELSIF TG_OP = 'DELETE' THEN
                help_request_id := OLD.help_request_id;
                class_id := OLD.class_id;
                row_id := OLD.id;
            END IF;
        END IF;
    END IF;

    -- Lookup class_id and is_private when missing (for related tables)
    IF (class_id IS NULL OR is_private IS NULL) AND help_request_id IS NOT NULL THEN
        SELECT hr.class_id, hr.is_private INTO class_id, is_private
        FROM public.help_requests hr
        WHERE hr.id = help_request_id;
    END IF;

    -- Only broadcast if we have valid help_request_id and class_id
    IF help_request_id IS NOT NULL AND class_id IS NOT NULL THEN
        -- Create payload with help request specific information
        main_payload := jsonb_build_object(
            'type', 'request_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', row_id,
            'help_request_id', help_request_id,
            'class_id', class_id,
            'data', CASE 
                WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
                ELSE to_jsonb(NEW)
            END,
            'timestamp', NOW()
        );

        -- Each help request channel has its own RLS
        PERFORM public.safe_broadcast(
            main_payload,
            'broadcast',
            'help_request:' || help_request_id,
            true
        );
    END IF;

    -- Return appropriate record
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$;
-- 3) Gradebook cell change (wrap sends)

-- Create unified broadcast function for gradebook_column_students changes
CREATE OR REPLACE FUNCTION broadcast_gradebook_column_students_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    target_class_id BIGINT;
    target_student_id UUID;
    target_is_private BOOLEAN;
    staff_payload JSONB;
    user_payload JSONB;
BEGIN
    -- Get the class_id, student_id, and is_private from the record
    IF TG_OP = 'INSERT' THEN
        target_class_id := NEW.class_id;
        target_student_id := NEW.student_id;
        target_is_private := NEW.is_private;
    ELSIF TG_OP = 'UPDATE' THEN
        target_class_id := COALESCE(NEW.class_id, OLD.class_id);
        target_student_id := COALESCE(NEW.student_id, OLD.student_id);
        target_is_private := COALESCE(NEW.is_private, OLD.is_private);
    ELSIF TG_OP = 'DELETE' THEN
        target_class_id := OLD.class_id;
        target_student_id := OLD.student_id;
        target_is_private := OLD.is_private;
    END IF;

    IF target_class_id IS NOT NULL AND target_student_id IS NOT NULL THEN
        -- Create base payload for gradebook_column_students changes
        staff_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', CASE
                WHEN TG_OP = 'DELETE' THEN OLD.id
                ELSE NEW.id
            END,
            'data', CASE
                WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
                ELSE to_jsonb(NEW)
            END,
            'class_id', target_class_id,
            'student_id', target_student_id,
            'is_private', target_is_private,
            'timestamp', NOW()
        );

        -- Always broadcast to staff channel (instructors and graders see all changes)
        PERFORM public.safe_broadcast(
            staff_payload || jsonb_build_object('target_audience', 'staff'),
            'broadcast',
            'class:' || target_class_id || ':staff',
            true
        );

        -- If this is a public record (is_private = false), also broadcast to the student's channel
        IF target_is_private = false THEN
            user_payload := staff_payload || jsonb_build_object('target_audience', 'user');
            
            PERFORM public.safe_broadcast(
                user_payload,
                'broadcast',
                'class:' || target_class_id || ':user:' || target_student_id,
                true
            );
        END IF;
    END IF;

    -- Return the appropriate record
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$;

-- Remaining wrappers: watchers/read-status/discussion threads/gradebook columns/row state/staff data/regrade/review/submission
CREATE OR REPLACE FUNCTION "public"."broadcast_discussion_thread_read_status_unified"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
    class_id_value bigint;
    row_id text;
    user_payload jsonb;
    viewer_user_id uuid;
    viewer_profile_id uuid;
BEGIN
    -- Get class_id from the discussion thread and row_id
    IF TG_OP = 'INSERT' THEN
        SELECT dt.class_id INTO class_id_value
        FROM public.discussion_threads dt
        WHERE dt.id = NEW.discussion_thread_id;
        row_id := NEW.id;
        viewer_user_id := NEW.user_id;
    ELSIF TG_OP = 'UPDATE' THEN
        SELECT dt.class_id INTO class_id_value
        FROM public.discussion_threads dt
        WHERE dt.id = COALESCE(NEW.discussion_thread_id, OLD.discussion_thread_id);
        row_id := COALESCE(NEW.id, OLD.id);
        viewer_user_id := COALESCE(NEW.user_id, OLD.user_id);
    ELSIF TG_OP = 'DELETE' THEN
        SELECT dt.class_id INTO class_id_value
        FROM public.discussion_threads dt
        WHERE dt.id = OLD.discussion_thread_id;
        row_id := OLD.id;
        viewer_user_id := OLD.user_id;
    END IF;

    -- Get the private_profile_id from user_id for the channel name
    IF class_id_value IS NOT NULL AND viewer_user_id IS NOT NULL THEN
        SELECT ur.private_profile_id INTO viewer_profile_id
        FROM public.user_roles ur
        WHERE ur.user_id = viewer_user_id AND ur.class_id = class_id_value
        LIMIT 1;
    END IF;

    -- Only broadcast if we have valid class_id and profile_id
    IF class_id_value IS NOT NULL AND viewer_profile_id IS NOT NULL THEN
        -- Create payload for the individual user only
        user_payload := jsonb_build_object(
            'type', 'staff_data_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', row_id,
            'class_id', class_id_value,
            'data', CASE 
                WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
                ELSE to_jsonb(NEW)
            END,
            'timestamp', NOW()
        );

        -- Broadcast ONLY to the individual user who made the read status change
        -- This eliminates unnecessary broadcasts to staff and other users
        PERFORM public.safe_broadcast(
            user_payload,
            'broadcast',
            'class:' || class_id_value || ':user:' || viewer_profile_id,
            true
        );
    END IF;

    -- Return the appropriate record
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$;
CREATE OR REPLACE FUNCTION "public"."broadcast_discussion_thread_watchers_user_only"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
    class_id_value bigint;
    row_id text;
    user_payload jsonb;
    watcher_user_id uuid;
    watcher_profile_id uuid;
BEGIN
    -- Get class_id and user info from the record
    IF TG_OP = 'INSERT' THEN
        class_id_value := NEW.class_id;
        row_id := NEW.id;
        watcher_user_id := NEW.user_id;
    ELSIF TG_OP = 'UPDATE' THEN
        class_id_value := COALESCE(NEW.class_id, OLD.class_id);
        row_id := COALESCE(NEW.id, OLD.id);
        watcher_user_id := COALESCE(NEW.user_id, OLD.user_id);
    ELSIF TG_OP = 'DELETE' THEN
        class_id_value := OLD.class_id;
        row_id := OLD.id;
        watcher_user_id := OLD.user_id;
    END IF;

    -- Get the private_profile_id from user_id for the channel name
    IF class_id_value IS NOT NULL AND watcher_user_id IS NOT NULL THEN
        SELECT ur.private_profile_id INTO watcher_profile_id
        FROM public.user_roles ur
        WHERE ur.user_id = watcher_user_id AND ur.class_id = class_id_value
        LIMIT 1;
    END IF;

    -- Only broadcast if we have valid class_id and profile_id
    IF class_id_value IS NOT NULL AND watcher_profile_id IS NOT NULL THEN
        -- Create payload for the individual user only
        user_payload := jsonb_build_object(
            'type', 'staff_data_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', row_id,
            'class_id', class_id_value,
            'data', CASE 
                WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
                ELSE to_jsonb(NEW)
            END,
            'timestamp', NOW()
        );

        -- Broadcast ONLY to the individual user who changed their watch status
        -- Staff don't need to see personal watch preferences
        PERFORM public.safe_broadcast(
            user_payload,
            'broadcast',
            'class:' || class_id_value || ':user:' || watcher_profile_id,
            true
        );
    END IF;

    -- Return the appropriate record
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$;


CREATE OR REPLACE FUNCTION public.broadcast_discussion_threads_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
    target_class_id bigint;
    staff_payload jsonb;
    student_payload jsonb;
    affected_profile_ids uuid[];
    profile_id uuid;
begin
    -- Get the class_id from the record
    if TG_OP = 'INSERT' then
        target_class_id := NEW.class_id;
    elsif TG_OP = 'UPDATE' then
        target_class_id := coalesce(NEW.class_id, OLD.class_id);
    elsif TG_OP = 'DELETE' then
        target_class_id := OLD.class_id;
    end if;

    if target_class_id is not null then
        -- Create payload for discussion_threads changes (staff scoped)
        staff_payload := jsonb_build_object(
            'type', 'staff_data_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', case
                when TG_OP = 'DELETE' then OLD.id
                else NEW.id
            end,
            'data', case
                when TG_OP = 'DELETE' then to_jsonb(OLD)
                else to_jsonb(NEW)
            end,
            'class_id', target_class_id,
            'timestamp', now()
        );

        -- Broadcast to staff channel (instructors and graders see all discussion threads)
        perform public.safe_broadcast(
            staff_payload,
            'broadcast',
            'class:' || target_class_id || ':staff',
            true
        );

        -- Minimal student payload; clients refetch
        student_payload := jsonb_build_object(
            'type','table_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', case when TG_OP='DELETE' then OLD.id else NEW.id end,
            'class_id', target_class_id,
            'timestamp', now()
        );

        PERFORM public.safe_broadcast(
            student_payload,
            'broadcast',
            'class:' || target_class_id || ':students',
            true
        );
    end if;

    -- Return the appropriate record
    if TG_OP = 'DELETE' then
        return OLD;
    else
        return NEW;
    end if;
end;
$function$
;
CREATE OR REPLACE FUNCTION broadcast_gradebook_columns_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    target_class_id BIGINT;
    staff_payload JSONB;
    user_payload JSONB;
    affected_profile_ids UUID[];
    profile_id UUID;
BEGIN
    -- Get the class_id from the record
    IF TG_OP = 'INSERT' THEN
        target_class_id := NEW.class_id;
    ELSIF TG_OP = 'UPDATE' THEN
        target_class_id := COALESCE(NEW.class_id, OLD.class_id);
    ELSIF TG_OP = 'DELETE' THEN
        target_class_id := OLD.class_id;
    END IF;

    IF target_class_id IS NOT NULL THEN
        -- Create payload for gradebook_columns changes
        staff_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', CASE
                WHEN TG_OP = 'DELETE' THEN OLD.id
                ELSE NEW.id
            END,
            'data', CASE
                WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
                ELSE to_jsonb(NEW)
            END,
            'class_id', target_class_id,
            'target_audience', 'staff',
            'timestamp', NOW()
        );

        -- Broadcast to staff channel (instructors and graders see all column changes)
        PERFORM public.safe_broadcast(
            staff_payload,
            'broadcast',
            'class:' || target_class_id || ':staff',
            true
        );

        -- Get all students in the class for user channels
        SELECT ARRAY(
            SELECT ur.private_profile_id
            FROM public.user_roles ur
            WHERE ur.class_id = target_class_id AND ur.role = 'student'
        ) INTO affected_profile_ids;

        -- Create user payload (same as staff but marked for users)
        user_payload := staff_payload || jsonb_build_object('target_audience', 'user');

        -- Broadcast to all student user channels (students see column structure changes)
        FOREACH profile_id IN ARRAY affected_profile_ids
        LOOP
            PERFORM public.safe_broadcast(
                user_payload,
                'broadcast',
                'class:' || target_class_id || ':user:' || profile_id,
                true
            );
        END LOOP;
    END IF;

    -- Return the appropriate record
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.broadcast_gradebook_row_state_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  target_class_id BIGINT;
  target_student_id UUID;
  staff_payload JSONB;
  user_payload JSONB;
  target_is_private BOOLEAN;
BEGIN
  -- Determine IDs and privacy based on operation
  IF TG_OP = 'INSERT' THEN
    target_class_id := NEW.class_id;
    target_student_id := NEW.student_id;
    target_is_private := NEW.is_private;
  ELSIF TG_OP = 'UPDATE' THEN
    target_class_id := COALESCE(NEW.class_id, OLD.class_id);
    target_student_id := COALESCE(NEW.student_id, OLD.student_id);
    target_is_private := COALESCE(NEW.is_private, OLD.is_private);
  ELSIF TG_OP = 'DELETE' THEN
    target_class_id := OLD.class_id;
    target_student_id := OLD.student_id;
    target_is_private := OLD.is_private;
  END IF;

  IF target_class_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Build base payload matching existing table_change format
  staff_payload := jsonb_build_object(
    'type', 'table_change',
    'operation', TG_OP,
    'table', 'gradebook_row_recalc_state',
    'data', CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,
    'class_id', target_class_id,
    'timestamp', NOW()
  );

  -- Always broadcast to staff channel
  PERFORM public.safe_broadcast(
    staff_payload || jsonb_build_object('target_audience', 'staff'),
    'broadcast',
    'class:' || target_class_id || ':staff',
    true
  );

  -- If non-private, also broadcast to the student's user channel
  IF target_is_private = false THEN
    user_payload := staff_payload || jsonb_build_object('target_audience', 'user');
    PERFORM public.safe_broadcast(
      user_payload,
      'broadcast',
      'class:' || target_class_id || ':user:' || target_student_id,
      true
    );
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.broadcast_help_queue_data_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    help_queue_id BIGINT;
    class_id BIGINT;
    row_id BIGINT;
    queue_payload JSONB;
BEGIN
    -- Get help_queue_id and class_id based on the table
    IF TG_TABLE_NAME = 'help_queues' THEN
        IF TG_OP = 'INSERT' THEN
            help_queue_id := NEW.id;
            class_id := NEW.class_id;
            row_id := NEW.id;
        ELSIF TG_OP = 'UPDATE' THEN
            help_queue_id := NEW.id;
            class_id := NEW.class_id;
            row_id := NEW.id;
        ELSIF TG_OP = 'DELETE' THEN
            help_queue_id := OLD.id;
            class_id := OLD.class_id;
            row_id := OLD.id;
        END IF;
    ELSIF TG_TABLE_NAME = 'help_queue_assignments' THEN
        IF TG_OP = 'INSERT' THEN
            help_queue_id := NEW.help_queue_id;
            class_id := NEW.class_id;
            row_id := NEW.id;
        ELSIF TG_OP = 'UPDATE' THEN
            help_queue_id := NEW.help_queue_id;
            class_id := NEW.class_id;
            row_id := NEW.id;
        ELSIF TG_OP = 'DELETE' THEN
            help_queue_id := OLD.help_queue_id;
            class_id := OLD.class_id;
            row_id := OLD.id;
        END IF;
    ELSIF TG_TABLE_NAME = 'help_requests' THEN
        -- For help requests, we also need to update the help queue status
        IF TG_OP = 'INSERT' THEN
            help_queue_id := NEW.help_queue;
            class_id := NEW.class_id;
            row_id := NEW.id;
        ELSIF TG_OP = 'UPDATE' THEN
            help_queue_id := COALESCE(NEW.help_queue, OLD.help_queue);
            class_id := COALESCE(NEW.class_id, OLD.class_id);
            row_id := NEW.id;
        ELSIF TG_OP = 'DELETE' THEN
            help_queue_id := OLD.help_queue;
            class_id := OLD.class_id;
            row_id := OLD.id;
        END IF;
    END IF;

    -- Only broadcast if we have valid help_queue_id and class_id
    IF help_queue_id IS NOT NULL AND class_id IS NOT NULL THEN
        -- Create payload with help queue specific information
        queue_payload := jsonb_build_object(
            'type', 'queue_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', row_id,
            'help_queue_id', help_queue_id,
            'class_id', class_id,
            'data', CASE 
                WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
                ELSE to_jsonb(NEW)
            END,
            'timestamp', NOW()
        );

        -- Broadcast to individual help queue channel
        PERFORM public.safe_broadcast(
            queue_payload,
            'broadcast',
            'help_queue:' || help_queue_id,
            true
        );

        -- Also broadcast to global help queues channel
        PERFORM public.safe_broadcast(
            queue_payload,
            'broadcast',
            'help_queues',
            true
        );
    END IF;

    -- Return the appropriate record
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.broadcast_help_request_staff_data_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    help_request_id BIGINT;
    class_id BIGINT;
    student_profile_id UUID;
    row_id BIGINT;
    staff_payload JSONB;
BEGIN
    -- Get relevant IDs based on table
    IF TG_TABLE_NAME = 'help_request_moderation' THEN
        IF TG_OP = 'INSERT' THEN
            help_request_id := NEW.help_request_id;
            class_id := NEW.class_id;
            student_profile_id := NEW.student_profile_id;
            row_id := NEW.id;
        ELSIF TG_OP = 'UPDATE' THEN
            help_request_id := COALESCE(NEW.help_request_id, OLD.help_request_id);
            class_id := COALESCE(NEW.class_id, OLD.class_id);
            student_profile_id := COALESCE(NEW.student_profile_id, OLD.student_profile_id);
            row_id := COALESCE(NEW.id, OLD.id);
        ELSIF TG_OP = 'DELETE' THEN
            help_request_id := OLD.help_request_id;
            class_id := OLD.class_id;
            student_profile_id := OLD.student_profile_id;
            row_id := OLD.id;
        END IF;
    ELSIF TG_TABLE_NAME = 'student_karma_notes' THEN
        IF TG_OP = 'INSERT' THEN
            help_request_id := NEW.help_request_id;
            class_id := NEW.class_id;
            student_profile_id := NEW.student_profile_id;
            row_id := NEW.id;
        ELSIF TG_OP = 'UPDATE' THEN
            help_request_id := COALESCE(NEW.help_request_id, OLD.help_request_id);
            class_id := COALESCE(NEW.class_id, OLD.class_id);
            student_profile_id := COALESCE(NEW.student_profile_id, OLD.student_profile_id);
            row_id := COALESCE(NEW.id, OLD.id);
        ELSIF TG_OP = 'DELETE' THEN
            help_request_id := OLD.help_request_id;
            class_id := OLD.class_id;
            student_profile_id := OLD.student_profile_id;
            row_id := OLD.id;
        END IF;
    ELSIF TG_TABLE_NAME = 'help_request_templates' THEN
        IF TG_OP = 'INSERT' THEN
            class_id := NEW.class_id;
            row_id := NEW.id;
        ELSIF TG_OP = 'UPDATE' THEN
            class_id := COALESCE(NEW.class_id, OLD.class_id);
            row_id := COALESCE(NEW.id, OLD.id);
        ELSIF TG_OP = 'DELETE' THEN
            class_id := OLD.class_id;
            row_id := OLD.id;
        END IF;
    END IF;

    -- Build payload
    staff_payload := jsonb_build_object(
        'type', 'staff_data_change',
        'operation', TG_OP,
        'table', TG_TABLE_NAME,
        'row_id', row_id,
        'class_id', class_id,
        'student_profile_id', student_profile_id,
        'help_request_id', help_request_id,
        'data', CASE 
            WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
            ELSE to_jsonb(NEW)
        END,
        'timestamp', NOW()
    );

    -- Always broadcast to office-hours staff channel
    IF class_id IS NOT NULL THEN
        PERFORM public.safe_broadcast(
            staff_payload,
            'broadcast',
            'help_queues:' || class_id || ':staff',
            true
        );
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION broadcast_regrade_request_data_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    class_id BIGINT;
    assignee_profile_id UUID;
    profile_id UUID;
    affected_profile_ids UUID[];
    staff_payload JSONB;
    user_payload JSONB;
BEGIN
    -- Get the class_id and assignee_profile_id
    IF TG_OP = 'INSERT' THEN
        class_id := NEW.class_id;
        assignee_profile_id := NEW.assignee;
    ELSIF TG_OP = 'UPDATE' THEN
        class_id := COALESCE(NEW.class_id, OLD.class_id);
        assignee_profile_id := COALESCE(NEW.assignee, OLD.assignee);
    ELSIF TG_OP = 'DELETE' THEN
        class_id := OLD.class_id;
        assignee_profile_id := OLD.assignee;
    END IF;

    IF class_id IS NOT NULL THEN
        -- Create payload with multiplexing information
        staff_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'data', CASE 
                WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
                ELSE to_jsonb(NEW)
            END,
            'class_id', class_id,
            'timestamp', NOW()
        );

        -- Broadcast to staff channel
        PERFORM public.safe_broadcast(
            staff_payload,
            'broadcast',
            'class:' || class_id || ':staff',
            true
        );

        -- Also broadcast to the submission owner's channel and all group members
        IF TG_OP = 'INSERT' THEN
            -- Get all affected profile IDs (submission owner + group members)
            SELECT ARRAY(
                SELECT DISTINCT COALESCE(s.profile_id, agm.profile_id)
                FROM public.submissions s
                LEFT JOIN public.assignment_groups ag ON s.assignment_group_id = ag.id
                LEFT JOIN public.assignment_groups_members agm ON ag.id = agm.assignment_group_id
                WHERE s.id = NEW.submission_id
            ) INTO affected_profile_ids;
            
            -- Broadcast to all affected users
            IF array_length(affected_profile_ids, 1) > 0 THEN
                user_payload := staff_payload || jsonb_build_object('target_audience', 'user');
                -- Send to each affected user
                FOREACH profile_id IN ARRAY affected_profile_ids
                LOOP
                    IF profile_id IS NOT NULL THEN
                        PERFORM public.safe_broadcast(
                            user_payload,
                            'broadcast',
                            'class:' || class_id || ':user:' || profile_id,
                            true
                        );
                    END IF;
                END LOOP;
            END IF;
        ELSIF TG_OP = 'UPDATE' THEN
            -- For updates, check both old and new submission owners and group members
            DECLARE
                old_affected_profile_ids UUID[];
                new_affected_profile_ids UUID[];
            BEGIN
                -- Get old affected profile IDs (submission owner + group members)
                SELECT ARRAY(
                    SELECT DISTINCT COALESCE(s.profile_id, agm.profile_id)
                    FROM submissions s
                    LEFT JOIN assignment_groups ag ON s.assignment_group_id = ag.id
                    LEFT JOIN assignment_groups_members agm ON ag.id = agm.assignment_group_id
                    WHERE s.id = OLD.submission_id
                ) INTO old_affected_profile_ids;
                
                -- Get new affected profile IDs (submission owner + group members)
                SELECT ARRAY(
                    SELECT DISTINCT COALESCE(s.profile_id, agm.profile_id)
                    FROM public.submissions s
                    LEFT JOIN public.assignment_groups ag ON s.assignment_group_id = ag.id
                    LEFT JOIN public.assignment_groups_members agm ON ag.id = agm.assignment_group_id
                    WHERE s.id = NEW.submission_id
                ) INTO new_affected_profile_ids;
                
                -- Broadcast to old affected users if submission_id changed
                IF OLD.submission_id != NEW.submission_id AND array_length(old_affected_profile_ids, 1) > 0 THEN
                    user_payload := staff_payload || jsonb_build_object('target_audience', 'user');
                    FOREACH profile_id IN ARRAY old_affected_profile_ids
                    LOOP
                        IF profile_id IS NOT NULL THEN
                            PERFORM public.safe_broadcast(
                                user_payload,
                                'broadcast',
                                'class:' || class_id || ':user:' || profile_id,
                                true
                            );
                        END IF;
                    END LOOP;
                END IF;
                
                -- Broadcast to new affected users
                IF array_length(new_affected_profile_ids, 1) > 0 THEN
                    user_payload := staff_payload || jsonb_build_object('target_audience', 'user');
                    FOREACH profile_id IN ARRAY new_affected_profile_ids
                    LOOP
                        IF profile_id IS NOT NULL THEN
                            PERFORM public.safe_broadcast(
                                user_payload,
                                'broadcast',
                                'class:' || class_id || ':user:' || profile_id,
                                true
                            );
                        END IF;
                    END LOOP;
                END IF;
            END;
        ELSIF TG_OP = 'DELETE' THEN
            -- For deletes, broadcast to the submission owner and all group members
            SELECT ARRAY(
                SELECT DISTINCT COALESCE(s.profile_id, agm.profile_id)
                FROM public.submissions s
                LEFT JOIN public.assignment_groups ag ON s.assignment_group_id = ag.id
                LEFT JOIN public.assignment_groups_members agm ON ag.id = agm.assignment_group_id
                WHERE s.id = OLD.submission_id
            ) INTO affected_profile_ids;
            
            -- Broadcast to all affected users
            IF array_length(affected_profile_ids, 1) > 0 THEN
                user_payload := staff_payload || jsonb_build_object('target_audience', 'user');
                FOREACH profile_id IN ARRAY affected_profile_ids
                LOOP
                    IF profile_id IS NOT NULL THEN
                        PERFORM public.safe_broadcast(
                            user_payload,
                            'broadcast',
                            'class:' || class_id || ':user:' || profile_id,
                            true
                        );
                    END IF;
                END LOOP;
            END IF;
        END IF;
    END IF;

    -- Return the appropriate record
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION broadcast_review_assignment_data_change()
RETURNS TRIGGER AS $$
DECLARE
    class_id BIGINT;
    assignee_profile_id UUID;
    staff_payload JSONB;
    user_payload JSONB;
BEGIN
    -- Get the assignee_profile_id and class_id
    IF TG_OP = 'INSERT' THEN
        assignee_profile_id := NEW.assignee_profile_id;
        class_id := NEW.class_id;
    ELSIF TG_OP = 'UPDATE' THEN
        assignee_profile_id := COALESCE(NEW.assignee_profile_id, OLD.assignee_profile_id);
        class_id := COALESCE(NEW.class_id, OLD.class_id);
    ELSIF TG_OP = 'DELETE' THEN
        assignee_profile_id := OLD.assignee_profile_id;
        class_id := OLD.class_id;
    END IF;

    IF class_id IS NOT NULL THEN
        -- Create payload with multiplexing information
        staff_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'data', CASE 
                WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
                ELSE to_jsonb(NEW)
            END,
            'class_id', class_id,
            'timestamp', NOW()
        );

        -- Broadcast to staff channel
        PERFORM public.safe_broadcast(
            staff_payload,
            'broadcast',
            'class:' || class_id || ':staff',
            true
        );

        -- Broadcast to assignee user channel if there's an assignee
        IF assignee_profile_id IS NOT NULL THEN
            user_payload := staff_payload || jsonb_build_object('target_audience', 'user');
            PERFORM public.safe_broadcast(
                user_payload,
                'broadcast',
                'class:' || class_id || ':user:' || assignee_profile_id,
                true
            );
        END IF;
    END IF;

    -- Return the appropriate record
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION broadcast_review_assignment_rubric_part_data_change()
RETURNS TRIGGER AS $$
DECLARE
    class_id BIGINT;
    assignee_profile_id UUID;
    staff_payload JSONB;
    user_payload JSONB;
BEGIN
    -- Get the assignee_profile_id and class_id from the review_assignment
    IF TG_OP = 'INSERT' THEN
        SELECT ra.assignee_profile_id, ra.class_id 
        INTO assignee_profile_id, class_id
        FROM "public"."review_assignments" ra
        WHERE ra.id = NEW.review_assignment_id;
    ELSIF TG_OP = 'UPDATE' THEN
        SELECT ra.assignee_profile_id, ra.class_id 
        INTO assignee_profile_id, class_id
        FROM "public"."review_assignments" ra
        WHERE ra.id = COALESCE(NEW.review_assignment_id, OLD.review_assignment_id);
    ELSIF TG_OP = 'DELETE' THEN
        SELECT ra.assignee_profile_id, ra.class_id 
        INTO assignee_profile_id, class_id
        FROM "public"."review_assignments" ra
        WHERE ra.id = OLD.review_assignment_id;
    END IF;

    IF class_id IS NOT NULL THEN
        -- Create payload with multiplexing information
        staff_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'data', CASE 
                WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
                ELSE to_jsonb(NEW)
            END,
            'class_id', class_id,
            'timestamp', NOW()
        );

        -- Broadcast to staff channel
        PERFORM public.safe_broadcast(
            staff_payload,
            'broadcast',
            'class:' || class_id || ':staff',
            true
        );

        -- Broadcast to assignee user channel if there's an assignee
        IF assignee_profile_id IS NOT NULL THEN
            user_payload := staff_payload || jsonb_build_object('target_audience', 'user');
            PERFORM public.safe_broadcast(
                user_payload,
                'broadcast',
                'class:' || class_id || ':user:' || assignee_profile_id,
                true
            );
        END IF;
    END IF;

    -- Return the appropriate record
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION broadcast_submission_data_change()
RETURNS TRIGGER AS $$
DECLARE
    class_id BIGINT;
    submission_id BIGINT;
    comment_id BIGINT;
    grader_payload JSONB;
    user_payload JSONB;
    affected_profile_ids UUID[];
    profile_id UUID;
BEGIN
    -- Get the comment ID, submission_id, and class_id
    IF TG_OP = 'INSERT' THEN
        comment_id := NEW.id;
        submission_id := NEW.submission_id;
        class_id := NEW.class_id;
    ELSIF TG_OP = 'UPDATE' THEN
        comment_id := NEW.id;
        submission_id := COALESCE(NEW.submission_id, OLD.submission_id);
        class_id := COALESCE(NEW.class_id, OLD.class_id);
    ELSIF TG_OP = 'DELETE' THEN
        comment_id := OLD.id;
        submission_id := OLD.submission_id;
        class_id := OLD.class_id;
    END IF;

    -- Only broadcast if there's a submission_id and class_id
    IF submission_id IS NOT NULL AND class_id IS NOT NULL THEN
        -- Create payload with submission-specific information
        grader_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', comment_id,
            'submission_id', submission_id,
            'class_id', class_id,
            'timestamp', NOW()
        );

        -- Broadcast to graders channel for this submission
        PERFORM public.safe_broadcast(
            grader_payload,
            'broadcast',
            'submission:' || submission_id || ':graders',
            true
        );

        -- Get affected profile IDs (submission author and group members)
        SELECT ARRAY(
            SELECT DISTINCT COALESCE(s.profile_id, agm.profile_id)
            FROM submissions s
            LEFT JOIN assignment_groups ag ON s.assignment_group_id = ag.id
            LEFT JOIN assignment_groups_members agm ON ag.id = agm.assignment_group_id
            WHERE s.id = submission_id
        ) INTO affected_profile_ids;

        -- Create user payload (same as grader payload but marked for users)
        user_payload := grader_payload || jsonb_build_object('target_audience', 'user');

        -- Broadcast to affected user channels for this specific submission
        FOREACH profile_id IN ARRAY affected_profile_ids
        LOOP
            PERFORM public.safe_broadcast(
                user_payload,
                'broadcast',
                'submission:' || submission_id || ':profile_id:' || profile_id,
                true
            );
        END LOOP;
    END IF;

    -- Return the appropriate record
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION broadcast_gradebook_data_change()
RETURNS TRIGGER AS $$
DECLARE
    class_id_val BIGINT;
    student_id_val UUID;
    staff_payload JSONB;
    user_payload JSONB;
BEGIN
    -- Get the relevant IDs and context based on table and operation
    IF TG_TABLE_NAME = 'gradebook_column_students' THEN
        IF TG_OP = 'INSERT' THEN
            class_id_val := NEW.class_id;
            student_id_val := NEW.student_id;
        ELSIF TG_OP = 'UPDATE' THEN
            class_id_val := COALESCE(NEW.class_id, OLD.class_id);
            student_id_val := COALESCE(NEW.student_id, OLD.student_id);
        ELSIF TG_OP = 'DELETE' THEN
            class_id_val := OLD.class_id;
            student_id_val := OLD.student_id;
        END IF;
    ELSIF TG_TABLE_NAME = 'gradebook_columns' THEN
        IF TG_OP = 'INSERT' THEN
            class_id_val := NEW.class_id;
        ELSIF TG_OP = 'UPDATE' THEN
            class_id_val := COALESCE(NEW.class_id, OLD.class_id);
        ELSIF TG_OP = 'DELETE' THEN
            class_id_val := OLD.class_id;
        END IF;
    END IF;

    -- Only broadcast if there's a class_id
    IF class_id_val IS NOT NULL THEN
        -- Create payload for staff (instructors/graders see everything with full data)
        staff_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'data', CASE
                WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
                ELSE to_jsonb(NEW)
            END,
            'class_id', class_id_val,
            'timestamp', NOW()
        );

        -- Broadcast to staff channel (instructors/graders see all changes)
        PERFORM public.safe_broadcast(
            staff_payload,
            'broadcast',
            'gradebook:' || class_id_val || ':staff',
            true
        );

        -- For gradebook_column_students, also broadcast to the affected student
        -- Only broadcast to student if grades are not private (is_private = false)
        IF TG_TABLE_NAME = 'gradebook_column_students' AND student_id_val IS NOT NULL THEN
            -- Check if this should be visible to the student
            -- For INSERT/UPDATE: only if is_private = false
            -- For DELETE: always notify (student should know their grade was removed)
            IF TG_OP = 'DELETE' OR
               (TG_OP IN ('INSERT', 'UPDATE') AND NEW.is_private = false) THEN
                
                user_payload := staff_payload || jsonb_build_object('target_audience', 'student');
                
                PERFORM public.safe_broadcast(
                    user_payload,
                    'broadcast',
                    'gradebook:' || class_id_val || ':student:' || student_id_val,
                    true
                );
            END IF;
        ELSIF TG_TABLE_NAME = 'gradebook_columns' THEN
            -- For gradebook_columns changes, broadcast to all students in the class
            -- since column changes (like new assignments) affect everyone
            user_payload := staff_payload || jsonb_build_object('target_audience', 'student');
            
            -- Broadcast to a general student channel for the class
            PERFORM public.safe_broadcast(
                user_payload,
                'broadcast',
                'gradebook:' || class_id_val || ':students',
                true
            );
        END IF;
    END IF;

    -- Return the appropriate record
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


CREATE OR REPLACE VIEW public.assignments_for_student_dashboard
WITH (security_invoker = true) AS
WITH ur_students AS (
    -- Restrict to the current authenticated user to avoid row explosion
    SELECT ur.class_id, ur.private_profile_id AS student_profile_id, ur.user_id AS student_user_id
    FROM public.user_privileges ur
    WHERE ur.role = 'student'::public.app_role
      AND ur.user_id = auth.uid()
), latest_submission AS (
    -- For each assignment and student, pick the latest individual submission if any
    SELECT a.id AS assignment_id,
           s_ind.id AS submission_id,
           s_ind.created_at AS submission_created_at,
           s_ind.is_active AS submission_is_active,
           s_ind.ordinal AS submission_ordinal,
           ur.student_profile_id
    FROM public.assignments a
    JOIN ur_students ur ON ur.class_id = a.class_id
    LEFT JOIN LATERAL (
        SELECT s.id, s.created_at, s.is_active, s.ordinal
        FROM public.submissions s
        WHERE s.assignment_id = a.id
          AND s.profile_id = ur.student_profile_id
          AND s.assignment_group_id IS NULL
        ORDER BY s.created_at DESC
        LIMIT 1
    ) s_ind ON TRUE
), student_group AS (
    -- Compute the student's group for each assignment (if any)
    SELECT a.id AS assignment_id,
           ur.student_profile_id,
           agm.assignment_group_id
    FROM public.assignments a
    JOIN ur_students ur ON ur.class_id = a.class_id
    LEFT JOIN public.assignment_groups_members agm
      ON agm.assignment_id = a.id
     AND agm.profile_id = ur.student_profile_id
), latest_group_submission AS (
    -- If the student has a group, pick the group's latest submission
    SELECT sg.assignment_id,
           sg.student_profile_id,
           s_grp.id AS submission_id,
           s_grp.created_at AS submission_created_at,
           s_grp.is_active AS submission_is_active,
           s_grp.ordinal AS submission_ordinal
    FROM student_group sg
    LEFT JOIN LATERAL (
        SELECT s.id, s.created_at, s.is_active, s.ordinal
        FROM public.submissions s
        WHERE s.assignment_id = sg.assignment_id
          AND s.assignment_group_id = sg.assignment_group_id
        ORDER BY s.created_at DESC
        LIMIT 1
    ) s_grp ON TRUE
), chosen_submission AS (
    -- Choose the most recent between group and individual submission
    SELECT DISTINCT ON (assignment_id, student_profile_id)
           assignment_id,
           student_profile_id,
           submission_id,
           submission_created_at,
           submission_is_active,
           submission_ordinal
    FROM (
        SELECT ls.assignment_id,
               ls.student_profile_id,
               ls.submission_id,
               ls.submission_created_at,
               ls.submission_is_active,
               ls.submission_ordinal
        FROM latest_submission ls
        UNION ALL
        SELECT lgs.assignment_id,
               lgs.student_profile_id,
               lgs.submission_id,
               lgs.submission_created_at,
               lgs.submission_is_active,
               lgs.submission_ordinal
        FROM latest_group_submission lgs
    ) x
    ORDER BY assignment_id, student_profile_id, submission_created_at DESC NULLS LAST
), grader_result_for_submission AS (
    SELECT cs.assignment_id,
           cs.student_profile_id,
           gr.id AS grader_result_id,
           gr.score AS grader_result_score,
           gr.max_score AS grader_result_max_score
    FROM chosen_submission cs
    LEFT JOIN public.grader_results gr ON gr.submission_id = cs.submission_id
), student_repositories AS (
    -- Individual repositories
    SELECT DISTINCT r.assignment_id,
           ur.student_profile_id,
           r.id AS repository_id,
           r.repository,
           r.is_github_ready
    FROM public.repositories r
    JOIN ur_students ur ON ur.student_profile_id = r.profile_id
    WHERE r.profile_id IS NOT NULL
    UNION ALL
    -- Group repositories
    SELECT DISTINCT r.assignment_id,
           agm.profile_id AS student_profile_id,
           r.id AS repository_id,
           r.repository,
           r.is_github_ready
    FROM public.repositories r
    JOIN public.assignment_groups_members agm
      ON agm.assignment_group_id = r.assignment_group_id
    WHERE r.assignment_group_id IS NOT NULL
), review_info AS (
    SELECT a.id AS assignment_id,
           ur.student_profile_id,
           ra.id AS review_assignment_id,
           ra.submission_id AS review_submission_id,
           sr.id AS submission_review_id,
           sr.completed_at AS submission_review_completed_at
    FROM public.assignments a
    JOIN ur_students ur ON ur.class_id = a.class_id
    LEFT JOIN public.review_assignments ra
      ON ra.assignment_id = a.id
     AND ra.assignee_profile_id = ur.student_profile_id
    LEFT JOIN public.submission_reviews sr ON sr.id = ra.submission_review_id
), due_date_ex AS (
    SELECT a.id AS assignment_id,
           ur.student_profile_id,
           ade.id AS due_date_exception_id,
           ade.hours AS exception_hours,
           ade.minutes AS exception_minutes,
           ade.tokens_consumed AS exception_tokens_consumed,
           ade.created_at AS exception_created_at,
           ade.creator_id AS exception_creator_id,
           ade.note AS exception_note
    FROM public.assignments a
    JOIN ur_students ur ON ur.class_id = a.class_id
    LEFT JOIN LATERAL (
        SELECT ade.*
        FROM public.assignment_due_date_exceptions ade
        WHERE ade.assignment_id = a.id
          AND (ade.student_id = ur.student_profile_id OR
               ade.assignment_group_id IN (
                   SELECT agm.assignment_group_id
                   FROM public.assignment_groups_members agm
                   WHERE agm.profile_id = ur.student_profile_id
                     AND agm.assignment_id = a.id
               ))
        ORDER BY ade.created_at DESC
        LIMIT 1
    ) ade ON TRUE
)
SELECT a.id,
       a.created_at,
       a.class_id,
       a.title,
       a.release_date,
       public.calculate_effective_due_date(a.id, ur.student_profile_id) AS due_date,
       a.student_repo_prefix,
       a.total_points,
       a.has_autograder,
       a.has_handgrader,
       a.description,
       a.slug,
       a.template_repo,
       a.allow_student_formed_groups,
       a.group_config,
       a.group_formation_deadline,
       a.max_group_size,
       a.min_group_size,
       a.archived_at,
       a.autograder_points,
       a.grading_rubric_id,
       a.max_late_tokens,
       a.latest_template_sha,
       a.meta_grading_rubric_id,
       a.self_review_rubric_id,
       a.self_review_setting_id,
       a.gradebook_column_id,
       a.minutes_due_after_lab,
       a.allow_not_graded_submissions,
       ur.student_profile_id,
       ur.student_user_id,
       cs.submission_id,
       cs.submission_created_at,
       cs.submission_is_active,
       cs.submission_ordinal,
       gr.grader_result_id,
       gr.grader_result_score,
       gr.grader_result_max_score,
       sr.repository_id,
       sr.repository,
       sr.is_github_ready,
       asrs.id AS assignment_self_review_setting_id,
       asrs.enabled AS self_review_enabled,
       asrs.deadline_offset AS self_review_deadline_offset,
       ri.review_assignment_id,
       ri.review_submission_id,
       ri.submission_review_id,
       ri.submission_review_completed_at,
       de.due_date_exception_id,
       de.exception_hours,
       de.exception_minutes,
       de.exception_tokens_consumed,
       de.exception_created_at,
       de.exception_creator_id,
       de.exception_note
FROM public.assignments a
JOIN ur_students ur ON ur.class_id = a.class_id
LEFT JOIN chosen_submission cs
  ON cs.assignment_id = a.id AND cs.student_profile_id = ur.student_profile_id
LEFT JOIN grader_result_for_submission gr
  ON gr.assignment_id = a.id AND gr.student_profile_id = ur.student_profile_id
LEFT JOIN student_repositories sr
  ON sr.assignment_id = a.id AND sr.student_profile_id = ur.student_profile_id
LEFT JOIN public.assignment_self_review_settings asrs
  ON asrs.id = a.self_review_setting_id
LEFT JOIN review_info ri
  ON ri.assignment_id = a.id AND ri.student_profile_id = ur.student_profile_id
LEFT JOIN due_date_ex de
  ON de.assignment_id = a.id AND de.student_profile_id = ur.student_profile_id
WHERE a.archived_at IS NULL;

-- Cleanup function for expired realtime subscriptions
CREATE OR REPLACE FUNCTION public.cleanup_expired_realtime_subscriptions()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  deleted_count integer;
BEGIN
  -- Delete subscriptions that expired more than 1 hour ago
  DELETE FROM public.realtime_channel_subscriptions
  WHERE lease_expires_at < now() - interval '1 hour';
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  
  -- Log cleanup activity (optional - can be removed if logging is not needed)
  IF deleted_count > 0 THEN
    RAISE NOTICE 'Cleaned up % expired realtime subscriptions', deleted_count;
  END IF;
END;
$$;

-- Schedule cleanup job to run every 24 hours (idempotent)
-- Note: This requires pg_cron extension to be enabled
DO $$
BEGIN
  -- Only create the job if it doesn't already exist
  IF NOT EXISTS (
    SELECT 1 FROM cron.job 
    WHERE jobname = 'cleanup-expired-realtime-subscriptions'
  ) THEN
    PERFORM cron.schedule(
      'cleanup-expired-realtime-subscriptions',
      '0 0 * * *', -- Run daily at midnight
      'SELECT public.cleanup_expired_realtime_subscriptions();'
    );
  END IF;
END $$;

COMMENT ON FUNCTION public.cleanup_expired_realtime_subscriptions() IS 
'Cleans up expired realtime channel subscriptions that have been expired for more than 1 hour. Scheduled to run daily via pg_cron.';


CREATE OR REPLACE FUNCTION public.check_unified_realtime_authorization(topic_text text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
declare
    topic_parts text[];
    topic_type text;
    class_id_text text;
    submission_id_text text;
    profile_id_text text;
    help_request_id_text text;
    help_queue_id_text text;
    class_id_bigint bigint;
    submission_id_bigint bigint;
    profile_id_uuid uuid;
    help_request_id_bigint bigint;
    help_queue_id_bigint bigint;
    is_class_grader boolean;
    is_submission_authorized boolean;
    is_profile_owner boolean;
    is_private_request boolean;
    channel_type text;
begin
    -- Parse topic
    topic_parts := string_to_array(topic_text, ':');
    if array_length(topic_parts, 1) < 1 then
        return false;
    end if;
    topic_type := topic_parts[1];

    -- Gradebook channels delegate to existing function
    if topic_type = 'gradebook' then
        return public.check_gradebook_realtime_authorization(topic_text);
    end if;

    -- Class-scoped help_queues channels: help_queues:<class_id> and help_queues:<class_id>:staff
    if topic_type = 'help_queues' then
        if array_length(topic_parts, 1) < 2 then
            return false;
        end if;
        class_id_text := topic_parts[2];
        begin
            class_id_bigint := class_id_text::bigint;
        exception when others then
            return false;
        end;
        -- Staff variant (graders/instructors only)
        if array_length(topic_parts, 1) = 3 and topic_parts[3] = 'staff' then
            return public.authorizeforclassgrader(class_id_bigint);
        end if;
        -- Aggregator variant (all class members)
        if array_length(topic_parts, 1) = 2 then
            return public.authorizeforclass(class_id_bigint);
        end if;
        return false;
    end if;

    -- help_request channels (help_request:<id>)
    if topic_type = 'help_request' then
        if array_length(topic_parts, 1) < 2 then
            return false;
        end if;
        help_request_id_text := topic_parts[2];
        begin
            help_request_id_bigint := help_request_id_text::bigint;
        exception when others then
            return false;
        end;
        return public.can_access_help_request(help_request_id_bigint);
    end if;

    -- help_queue channels (help_queue:<id>)
    if topic_type = 'help_queue' then
        if array_length(topic_parts, 1) < 2 then
            return false;
        end if;
        help_queue_id_text := topic_parts[2];
        begin
            help_queue_id_bigint := help_queue_id_text::bigint;
        exception when others then
            return false;
        end;
        select hq.class_id into class_id_bigint from public.help_queues hq where hq.id = help_queue_id_bigint;
        if class_id_bigint is not null then
            return public.authorizeforclass(class_id_bigint);
        else
            return false;
        end if;
    end if;

      -- Handle class-level channels (for review_assignments, etc.)
    if topic_type = 'class' then
        class_id_text := topic_parts[2];
        channel_type := topic_parts[3];
        
        -- Convert class_id to bigint
        begin
            class_id_bigint := class_id_text::bigint;
        exception when others then
            return false;
        end;
        
        -- Handle staff channel
        if channel_type = 'staff' then
            return public.authorizeforclassgrader(class_id_bigint);
        
        -- Handle user channel
        elsif channel_type = 'user' then
            -- Must have 4 parts for user channel
            if array_length(topic_parts, 1) != 4 then
                return false;
            end if;
            
            profile_id_text := topic_parts[4];
            
            -- Convert profile_id to uuid
            begin
                profile_id_uuid := profile_id_text::uuid;
            exception when others then
                return false;
            end;
            
            -- Check if user is grader/instructor OR is the profile owner
            is_class_grader := public.authorizeforclassgrader(class_id_bigint);
            is_profile_owner := public.authorizeforprofile(profile_id_uuid);
            
            return is_class_grader or is_profile_owner;
        elsif channel_type = 'students' then
            return public.authorizeforclass(class_id_bigint);
        else
            return false;
        end if;
    
    -- Handle submission-level channels (for submission comments, etc.)
    elsif topic_type = 'submission' then
        submission_id_text := topic_parts[2];
        channel_type := topic_parts[3];
        
        -- Convert submission_id to bigint
        begin
            submission_id_bigint := submission_id_text::bigint;
        exception when others then
            return false;
        end;
        
        -- Handle graders channel
        if channel_type = 'graders' then
            -- Get class_id from submission to check grader authorization
            select s.class_id into class_id_bigint
            from public.submissions s
            where s.id = submission_id_bigint;
            
            if class_id_bigint is null then
                return false;
            end if;
            
            return public.authorizeforclassgrader(class_id_bigint);
        
        -- Handle profile_id channel
        elsif channel_type = 'profile_id' then
            -- Must have 4 parts for profile_id channel
            if array_length(topic_parts, 1) != 4 then
                return false;
            end if;
            
            profile_id_text := topic_parts[4];
            
            -- Convert profile_id to uuid
            begin
                profile_id_uuid := profile_id_text::uuid;
            exception when others then
                return false;
            end;
            
            -- Check if user has access to the submission OR is the profile owner
            is_submission_authorized := public.authorize_for_submission(submission_id_bigint);
            is_profile_owner := public.authorizeforprofile(profile_id_uuid);
            
            -- Also check if user is a grader for the class (for extra access)
            select s.class_id into class_id_bigint
            from public.submissions s
            where s.id = submission_id_bigint;
            
            if class_id_bigint is not null then
                is_class_grader := public.authorizeforclassgrader(class_id_bigint);
            else
                is_class_grader := false;
            end if;
            
            return is_class_grader or is_submission_authorized or is_profile_owner;
        
        else
            return false;
        end if;
    
    else
        return false;
    end if;
END;
$$;

-- Backfill: For all classes, create students channels by sending a 'channel_created' message to each 'gradebook:<class_id>:students' channel.

DO
$$
DECLARE
    rec RECORD;
BEGIN
    FOR rec IN
        SELECT id FROM public.classes
    LOOP
        PERFORM realtime.send(
            jsonb_build_object(
                'type', 'channel_created',
                'class_id', rec.id,
                'created_at', NOW()
            ),
            'system',
            'class:' || rec.id || ':students',
            true
        );
    END LOOP;
END
$$;


CREATE OR REPLACE FUNCTION "public"."create_staff_channel"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
    -- Pre-create the staff channel by sending an initial message
    PERFORM realtime.send(
        jsonb_build_object(
            'type', 'channel_created',
            'class_id', NEW.id,
            'created_at', NOW()
        ),
        'system',
        'class:' || NEW.id || ':staff',
        true
    );
    PERFORM realtime.send(
        jsonb_build_object(
            'type', 'channel_created',
            'class_id', NEW.id,
            'created_at', NOW()
        ),
        'system',
        'class:' || NEW.id || ':students',
        true
    );
    RETURN NEW;
END;
$$;