-- Migration: Add broadcast support for submissions and notifications
-- This replaces Supabase Realtime postgres changes (which were disabled for performance)
-- with custom broadcasts using the existing broadcast channel infrastructure

-- =====================================================================
-- PART 1: SUBMISSIONS
-- Broadcast INSERT/UPDATE/DELETE to affected users' channels
-- =====================================================================

CREATE OR REPLACE FUNCTION "public"."broadcast_submission_change"()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public,pg_temp
AS $$
DECLARE
    submission_class_id bigint;
    submission_profile_id UUID;
    submission_group_id bigint;
    affected_profile_ids UUID[];
    profile_id UUID;
    payload JSONB;
BEGIN
    -- Get the submission details
    IF TG_OP = 'INSERT' THEN
        submission_class_id := NEW.class_id;
        submission_profile_id := NEW.profile_id;
        submission_group_id := NEW.assignment_group_id;
    ELSIF TG_OP = 'UPDATE' THEN
        submission_class_id := NEW.class_id;
        submission_profile_id := NEW.profile_id;
        submission_group_id := NEW.assignment_group_id;
    ELSIF TG_OP = 'DELETE' THEN
        submission_class_id := OLD.class_id;
        submission_profile_id := OLD.profile_id;
        submission_group_id := OLD.assignment_group_id;
    END IF;

    -- Get affected profile IDs (submission author and/or group members)
    IF submission_group_id IS NOT NULL THEN
        -- Group submission: notify all group members
        SELECT ARRAY(
            SELECT DISTINCT agm.profile_id
            FROM assignment_groups_members agm
            WHERE agm.assignment_group_id = submission_group_id
        ) INTO affected_profile_ids;
    ELSIF submission_profile_id IS NOT NULL THEN
        -- Individual submission: notify the author
        affected_profile_ids := ARRAY[submission_profile_id];
    END IF;

    -- Only broadcast if we have affected profiles
    IF affected_profile_ids IS NOT NULL AND array_length(affected_profile_ids, 1) > 0 THEN
        -- Create payload
        payload := jsonb_build_object(
            'type', 'table_change',
            'operation', TG_OP,
            'table', 'submissions',
            'row_id', CASE 
                WHEN TG_OP = 'DELETE' THEN OLD.id
                ELSE NEW.id
            END,
            'data', CASE 
                WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
                ELSE to_jsonb(NEW)
            END,
            'class_id', submission_class_id,
            'timestamp', NOW(),
            'target_audience', 'user'
        );

        -- Broadcast to each affected user's channel
        FOREACH profile_id IN ARRAY affected_profile_ids
        LOOP
            PERFORM public.safe_broadcast(
                payload,
                'broadcast',
                'class:' || submission_class_id || ':user:' || profile_id,
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

-- Create trigger for submissions
DROP TRIGGER IF EXISTS broadcast_submission_change_trigger ON "public"."submissions";
CREATE TRIGGER broadcast_submission_change_trigger
    AFTER INSERT OR UPDATE OR DELETE ON "public"."submissions"
    FOR EACH ROW
    EXECUTE FUNCTION broadcast_submission_change();


-- =====================================================================
-- PART 2: NOTIFICATIONS
-- When a notification is inserted, updated, or deleted, broadcast to the user/class channel
-- =====================================================================

CREATE OR REPLACE FUNCTION "public"."broadcast_notification_change"()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public,pg_temp
AS $$
DECLARE
    notification_user_id UUID;
    notification_class_id bigint;
    target_profile_id UUID;
    payload JSONB;
BEGIN
    -- Get the notification user_id and class_id
    IF TG_OP = 'INSERT' THEN
        notification_user_id := NEW.user_id;
        notification_class_id := NEW.class_id;
    ELSIF TG_OP = 'UPDATE' THEN
        notification_user_id := NEW.user_id;
        notification_class_id := NEW.class_id;
    ELSIF TG_OP = 'DELETE' THEN
        notification_user_id := OLD.user_id;
        notification_class_id := OLD.class_id;
    END IF;

    -- Get the profile_id for this user in this class
    -- Note: notifications use user_id, but channels use private_profile_id
    SELECT ur.private_profile_id INTO target_profile_id
    FROM public.user_roles ur
    WHERE ur.user_id = notification_user_id
      AND ur.class_id = notification_class_id
    LIMIT 1;

    -- Only broadcast if we found a profile (user is enrolled in the class)
    IF target_profile_id IS NOT NULL THEN
        -- Create payload
        payload := jsonb_build_object(
            'type', 'table_change',
            'operation', TG_OP,
            'table', 'notifications',
            'row_id', CASE 
                WHEN TG_OP = 'DELETE' THEN OLD.id
                ELSE NEW.id
            END,
            'data', CASE 
                WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
                ELSE to_jsonb(NEW)
            END,
            'class_id', notification_class_id,
            'timestamp', NOW(),
            'target_audience', 'user'
        );

        -- Broadcast to user channel for this user/class pair
        PERFORM public.safe_broadcast(
            payload,
            'broadcast',
            'class:' || notification_class_id || ':user:' || target_profile_id,
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

-- Create trigger for notifications
DROP TRIGGER IF EXISTS broadcast_notification_change_trigger ON "public"."notifications";
CREATE TRIGGER broadcast_notification_change_trigger
    AFTER INSERT OR UPDATE OR DELETE ON "public"."notifications"
    FOR EACH ROW
    EXECUTE FUNCTION broadcast_notification_change();

