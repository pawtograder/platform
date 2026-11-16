-- Restore class-scoped help queue broadcasts (issue #1082).
--
-- 20250910001703_help-request-scope-messages.sql routed broadcast_help_queue_data_change()
-- to help_queue:<id> and help_queues:<class_id>, and sent private help requests only to
-- help_queues:<class_id>:staff. 20250929004834_realtime-broadcast-optimization.sql rewrote
-- the function on top of an older copy and lost both parts:
--
-- 1. It sent to the global 'help_queues' topic instead of help_queues:<class_id>.
--    check_unified_realtime_authorization() rejects a help_queues topic without a class id,
--    so no client can join it, and OfficeHoursRealTimeController listens on
--    help_queues:<class_id>. Queue edits therefore never reached the help_queues
--    TableController, and the queue settings page showed stale data until a reload,
--    including in the window that made the edit, since the page does not refetch after
--    a save.
--
-- 2. It dropped the is_private branch. The broadcast_help_requests_to_queue_change trigger
--    also runs this function, so every private help request row (including the request
--    text) went to help_queue:<id>, which any class member may join.
--
-- This version restores the 20250910 routing and keeps safe_broadcast() from 20250929.
-- The unreachable global 'help_queues' send is removed.

CREATE OR REPLACE FUNCTION public.broadcast_help_queue_data_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    help_queue_id BIGINT;
    class_id BIGINT;
    row_id BIGINT;
    is_private_request BOOLEAN;
    queue_payload JSONB;
BEGIN
    IF TG_TABLE_NAME = 'help_queues' THEN
        IF TG_OP = 'DELETE' THEN
            help_queue_id := OLD.id;
            class_id := OLD.class_id;
            row_id := OLD.id;
        ELSE
            help_queue_id := NEW.id;
            class_id := NEW.class_id;
            row_id := NEW.id;
        END IF;
    ELSIF TG_TABLE_NAME = 'help_queue_assignments' THEN
        IF TG_OP = 'DELETE' THEN
            help_queue_id := OLD.help_queue_id;
            class_id := OLD.class_id;
            row_id := OLD.id;
        ELSE
            help_queue_id := NEW.help_queue_id;
            class_id := NEW.class_id;
            row_id := NEW.id;
        END IF;
    ELSIF TG_TABLE_NAME = 'help_requests' THEN
        IF TG_OP = 'INSERT' THEN
            help_queue_id := NEW.help_queue;
            class_id := NEW.class_id;
            row_id := NEW.id;
            is_private_request := NEW.is_private;
        ELSIF TG_OP = 'UPDATE' THEN
            help_queue_id := COALESCE(NEW.help_queue, OLD.help_queue);
            class_id := COALESCE(NEW.class_id, OLD.class_id);
            row_id := NEW.id;
            is_private_request := COALESCE(NEW.is_private, OLD.is_private);
        ELSIF TG_OP = 'DELETE' THEN
            help_queue_id := OLD.help_queue;
            class_id := OLD.class_id;
            row_id := OLD.id;
            is_private_request := OLD.is_private;
        END IF;
    END IF;

    IF help_queue_id IS NULL OR class_id IS NULL THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        RETURN NEW;
    END IF;

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

    IF TG_TABLE_NAME = 'help_requests' AND is_private_request IS TRUE THEN
        -- Private help requests go to office-hours staff only.
        PERFORM public.safe_broadcast(
            queue_payload,
            'broadcast',
            'help_queues:' || class_id || ':staff',
            true
        );
    ELSE
        PERFORM public.safe_broadcast(
            queue_payload,
            'broadcast',
            'help_queue:' || help_queue_id,
            true
        );

        PERFORM public.safe_broadcast(
            queue_payload,
            'broadcast',
            'help_queues:' || class_id,
            true
        );
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$function$;
