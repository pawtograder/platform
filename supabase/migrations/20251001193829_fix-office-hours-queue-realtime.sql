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


-- New function used only by help_requests table to route events to class-scoped channels
CREATE OR REPLACE FUNCTION public.broadcast_help_requests_to_class()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    class_id BIGINT;
    row_id BIGINT;
    staff_payload JSONB;
    public_payload JSONB;
BEGIN
    -- This trigger is only attached to public.help_requests
    IF TG_OP = 'DELETE' THEN
        class_id := OLD.class_id;
        row_id := OLD.id;
    ELSE
        class_id := NEW.class_id;
        row_id := NEW.id;
    END IF;

    IF class_id IS NOT NULL THEN
        -- Staff sees full data regardless of privacy
        staff_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', TG_OP,
            'table', 'help_requests',
            'row_id', row_id,
            'help_request_id', row_id,
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
                'help_request_id', row_id,
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

-- Rewire help_requests trigger to the new function; other tables retain existing behavior
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relname = 'help_requests' AND t.tgname = 'broadcast_help_requests_change'
    ) THEN
        EXECUTE 'DROP TRIGGER IF EXISTS broadcast_help_requests_change ON public.help_requests';
    END IF;
END $$;

CREATE TRIGGER broadcast_help_requests_change
AFTER INSERT OR DELETE OR UPDATE ON public.help_requests
FOR EACH ROW EXECUTE FUNCTION public.broadcast_help_requests_to_class();

-- Note: Triggers already exist and point to broadcast_help_request_data_change(); this edit only changes routing

