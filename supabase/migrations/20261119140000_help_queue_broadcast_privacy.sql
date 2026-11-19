-- Privacy: the queue-level broadcast sent the full help_requests row to every subscriber of the
-- queue channel, including private requests. Private rows now send only their id, the same way the
-- class students broadcast already does, so the table controller refetches them under RLS.
--
-- Students start joining queue channels in the same change, so the two must ship together: without
-- this redaction they would receive other students' private requests in full.
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
                -- Private requests carry only their id; students then refetch the row under RLS.
                WHEN TG_TABLE_NAME = 'help_requests' AND COALESCE((to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END)->>'is_private')::boolean, false) THEN
                    jsonb_build_object('id', row_id)
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
$function$;
