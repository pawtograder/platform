-- Fix help_requests realtime routing:
-- - Broadcast INSERT/UPDATE/DELETE events to class-scoped channels instead of per-request channels
-- - Privacy-aware payloads: if request is private, include only id; if public, include full row
-- - Keep staff vs students separation by using class:<class_id>:staff and class:<class_id>:students

-- Helper to build privacy-aware payload for help_requests row
CREATE OR REPLACE FUNCTION public._help_request_public_payload(
    tg_op text,
    new_row public.help_requests,
    old_row public.help_requests
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    is_private boolean;
    data jsonb;
    row_id bigint;
BEGIN
    IF tg_op = 'DELETE' THEN
        is_private := old_row.is_private;
        row_id := old_row.id;
    ELSE
        is_private := new_row.is_private;
        row_id := new_row.id;
    END IF;

    IF is_private THEN
        data := jsonb_build_object('id', row_id);
    ELSE
        data := CASE WHEN tg_op = 'DELETE' THEN to_jsonb(old_row) ELSE to_jsonb(new_row) END;
    END IF;

    RETURN jsonb_build_object(
        'type', 'table_change',
        'operation', tg_op,
        'table', 'help_requests',
        'row_id', row_id,
        'data', data,
        'timestamp', NOW()
    );
END;
$$;


-- Replace help request broadcast function to route to class-scoped channels
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
    staff_payload JSONB;
    public_payload JSONB;
BEGIN
    -- Resolve context for direct table
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
        -- Resolve context for related tables that include help_request_id
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

    -- Backfill class_id and is_private for related tables
    IF (class_id IS NULL OR is_private IS NULL) AND help_request_id IS NOT NULL THEN
        SELECT hr.class_id, hr.is_private INTO class_id, is_private
        FROM public.help_requests hr
        WHERE hr.id = help_request_id;
    END IF;

    -- Broadcast to class-scoped channels when we have context
    IF help_request_id IS NOT NULL AND class_id IS NOT NULL THEN
        -- Staff sees full data regardless of privacy
        staff_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', row_id,
            'help_request_id', help_request_id,
            'class_id', class_id,
            'data', CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,
            'target_audience', 'staff',
            'timestamp', NOW()
        );

        PERFORM public.safe_broadcast(
            staff_payload,
            'broadcast',
            'class:' || class_id || ':staff',
            true
        );

        -- Students get privacy-aware payload on the class students channel
        public_payload := public._help_request_public_payload(TG_OP, NEW, OLD)
            || jsonb_build_object(
                'help_request_id', help_request_id,
                'class_id', class_id
            );

        PERFORM public.safe_broadcast(
            public_payload,
            'broadcast',
            'class:' || class_id || ':students',
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

-- Note: Triggers already exist and point to broadcast_help_request_data_change(); this edit only changes routing

