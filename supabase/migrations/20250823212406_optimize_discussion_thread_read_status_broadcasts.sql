-- Optimize broadcast messages to reduce unnecessary noise
-- Fix 1: discussion thread read status ONLY goes to the reader (not to entire class/staff etc)
-- Fix 2: user_roles changes ONLY go to staff (not to the affected individual user)
-- Fix 3: Add missing broadcast trigger for discussion_thread_watchers (was missing from realtime setup)

-- Drop the existing trigger first
DROP TRIGGER IF EXISTS broadcast_discussion_thread_read_status_realtime ON public.discussion_thread_read_status;

-- Replace the broadcast function to only send to the individual user, not staff
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
        PERFORM realtime.send(
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

-- Recreate the trigger
CREATE TRIGGER broadcast_discussion_thread_read_status_realtime
  AFTER INSERT OR DELETE OR UPDATE
  ON public.discussion_thread_read_status
  FOR EACH ROW
  EXECUTE FUNCTION broadcast_discussion_thread_read_status_unified();

-- Add comment explaining the optimization
COMMENT ON FUNCTION public.broadcast_discussion_thread_read_status_unified() IS 
'Optimized broadcast function for discussion thread read status. Only broadcasts to the individual user who changed their read status, eliminating unnecessary broadcasts to staff and other users.';

-- ========================================
-- Fix 2: Optimize user_roles broadcasts to staff only
-- ========================================

-- Update the course table change function to remove individual user notifications for user_roles
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
        PERFORM realtime.send(
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
                PERFORM realtime.send(
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
                PERFORM realtime.send(
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
                    PERFORM realtime.send(
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

-- Add comment explaining the user_roles optimization
COMMENT ON FUNCTION public.broadcast_course_table_change_unified() IS 
'Optimized broadcast function for course-level table changes. user_roles changes now only broadcast to staff channel, eliminating unnecessary individual user notifications when users join/leave classes.';

-- ========================================
-- Fix 3: Add missing broadcast for discussion_thread_watchers (user-only)
-- ========================================

-- Create a dedicated broadcast function for thread watchers that only broadcasts to the individual user
-- Thread watching is a personal preference - staff don't need to see this activity
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
        PERFORM realtime.send(
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

-- Add the broadcast trigger for discussion_thread_watchers using the user-only function
CREATE OR REPLACE TRIGGER "broadcast_discussion_thread_watchers_realtime" 
  AFTER INSERT OR DELETE OR UPDATE 
  ON "public"."discussion_thread_watchers" 
  FOR EACH ROW 
  EXECUTE FUNCTION "public"."broadcast_discussion_thread_watchers_user_only"();

-- Add comments explaining the approach
COMMENT ON FUNCTION public.broadcast_discussion_thread_watchers_user_only() IS 
'Broadcasts discussion_thread_watchers changes only to the individual user. Thread watching is a personal preference that staff do not need to monitor.';

COMMENT ON TRIGGER "broadcast_discussion_thread_watchers_realtime" ON "public"."discussion_thread_watchers" IS 
'Broadcasts changes to discussion_thread_watchers table only to the affected user. This trigger was missing from the original realtime setup.';
