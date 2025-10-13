-- Migration: Add missing broadcast triggers for discussion system
-- This migration adds realtime broadcasts for discussion_thread_likes and discussion_topics
-- which are currently missing, preventing realtime updates in the UI.

-- ============================================================================
-- 1. Broadcast function for discussion_thread_likes
-- ============================================================================
-- Broadcasts to individual user channel only (personal preference data)
CREATE OR REPLACE FUNCTION public.broadcast_discussion_thread_likes_user_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
DECLARE
    class_id_value bigint;
    row_id_value bigint;
    user_payload jsonb;
    like_user_id uuid;
    like_profile_id uuid;
BEGIN
    -- Get class_id from the discussion thread
    IF TG_OP = 'INSERT' THEN
        SELECT dt.class_id INTO class_id_value
        FROM public.discussion_threads dt
        WHERE dt.id = NEW.discussion_thread;
        row_id_value := NEW.id;
        like_user_id := NEW.creator;
    ELSIF TG_OP = 'UPDATE' THEN
        SELECT dt.class_id INTO class_id_value
        FROM public.discussion_threads dt
        WHERE dt.id = COALESCE(NEW.discussion_thread, OLD.discussion_thread);
        row_id_value := COALESCE(NEW.id, OLD.id);
        like_user_id := COALESCE(NEW.creator, OLD.creator);
    ELSIF TG_OP = 'DELETE' THEN
        SELECT dt.class_id INTO class_id_value
        FROM public.discussion_threads dt
        WHERE dt.id = OLD.discussion_thread;
        row_id_value := OLD.id;
        like_user_id := OLD.creator;
    END IF;

    -- Get the private_profile_id (creator is a profile_id, but we need to find their user_id first)
    -- Note: creator column is already a profile_id (private_profile)
    IF class_id_value IS NOT NULL AND like_user_id IS NOT NULL THEN
        -- creator is a profile_id, find the user_id
        SELECT ur.user_id INTO like_user_id
        FROM public.user_roles ur
        WHERE ur.private_profile_id = (CASE WHEN TG_OP = 'DELETE' THEN OLD.creator ELSE NEW.creator END)
          AND ur.class_id = class_id_value
        LIMIT 1;
        
        -- Now get the profile_id back for channel name
        like_profile_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.creator ELSE NEW.creator END;
    END IF;

    -- Only broadcast if we have valid class_id and profile_id
    IF class_id_value IS NOT NULL AND like_profile_id IS NOT NULL THEN
        -- Create payload for the individual user only
        user_payload := jsonb_build_object(
            'type', 'staff_data_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', row_id_value,
            'class_id', class_id_value,
            'data', CASE 
                WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
                ELSE to_jsonb(NEW)
            END,
            'timestamp', NOW()
        );

        -- Broadcast ONLY to the individual user who made the like/unlike
        PERFORM public.safe_broadcast(
            user_payload,
            'broadcast',
            'class:' || class_id_value || ':user:' || like_profile_id,
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

COMMENT ON FUNCTION public.broadcast_discussion_thread_likes_user_only() IS 
'Broadcasts discussion_thread_likes changes only to the individual user who liked/unliked. Like status is personal and does not need to be broadcast to all users.';

-- Create trigger for discussion_thread_likes
DROP TRIGGER IF EXISTS broadcast_discussion_thread_likes_realtime ON public.discussion_thread_likes;
CREATE TRIGGER broadcast_discussion_thread_likes_realtime
    AFTER INSERT OR UPDATE OR DELETE
    ON public.discussion_thread_likes
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_discussion_thread_likes_user_only();

COMMENT ON TRIGGER broadcast_discussion_thread_likes_realtime ON public.discussion_thread_likes IS
'Broadcasts like/unlike events to the user who performed the action for immediate UI feedback.';

-- ============================================================================
-- 2. Broadcast function for discussion_topics
-- ============================================================================
-- Broadcasts to both staff and students (topics are visible to all)
CREATE OR REPLACE FUNCTION public.broadcast_discussion_topics_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
DECLARE
    target_class_id bigint;
    staff_payload jsonb;
    student_payload jsonb;
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
        -- Create full payload for staff
        staff_payload := jsonb_build_object(
            'type', 'staff_data_change',
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
            'timestamp', NOW()
        );

        -- Broadcast to staff channel (full data)
        PERFORM public.safe_broadcast(
            staff_payload,
            'broadcast',
            'class:' || target_class_id || ':staff',
            true
        );

        -- Create full payload for students too (topics are public information)
        student_payload := jsonb_build_object(
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
            'timestamp', NOW()
        );

        -- Broadcast to students channel (full data)
        PERFORM public.safe_broadcast(
            student_payload,
            'broadcast',
            'class:' || target_class_id || ':students',
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

COMMENT ON FUNCTION public.broadcast_discussion_topics_change() IS 
'Broadcasts discussion_topics changes to both staff and students. Topics are public information visible to all class members.';

-- Create trigger for discussion_topics
DROP TRIGGER IF EXISTS broadcast_discussion_topics_realtime ON public.discussion_topics;
CREATE TRIGGER broadcast_discussion_topics_realtime
    AFTER INSERT OR UPDATE OR DELETE
    ON public.discussion_topics
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_discussion_topics_change();

COMMENT ON TRIGGER broadcast_discussion_topics_realtime ON public.discussion_topics IS
'Broadcasts topic changes to all class members so topic lists and filters update in real-time.';

-- ============================================================================
-- 3. Grant permissions
-- ============================================================================
GRANT ALL ON FUNCTION public.broadcast_discussion_thread_likes_user_only() TO anon;
GRANT ALL ON FUNCTION public.broadcast_discussion_thread_likes_user_only() TO authenticated;
GRANT ALL ON FUNCTION public.broadcast_discussion_thread_likes_user_only() TO service_role;

GRANT ALL ON FUNCTION public.broadcast_discussion_topics_change() TO anon;
GRANT ALL ON FUNCTION public.broadcast_discussion_topics_change() TO authenticated;
GRANT ALL ON FUNCTION public.broadcast_discussion_topics_change() TO service_role;

