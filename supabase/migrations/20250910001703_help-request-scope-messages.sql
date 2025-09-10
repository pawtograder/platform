-- Scope office-hours realtime topics by class_id and route private help requests to class staff
-- Migration: 20250910001703_help-request-scope-messages.sql

-- 1) Replace global help_queues topic with class-scoped help_queues:<class_id>
CREATE OR REPLACE FUNCTION public.broadcast_help_queue_data_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    help_queue_id BIGINT;
    class_id BIGINT;
    row_id BIGINT;
    is_private_request BOOLEAN;
    queue_payload JSONB;
BEGIN
    -- Get help_queue_id, class_id, and privacy context
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
            help_queue_id := COALESCE(NEW.help_queue_id, OLD.help_queue_id);
            class_id := COALESCE(NEW.class_id, OLD.class_id);
            row_id := COALESCE(NEW.id, OLD.id);
        ELSIF TG_OP = 'DELETE' THEN
            help_queue_id := OLD.help_queue_id;
            class_id := OLD.class_id;
            row_id := OLD.id;
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

    -- Only broadcast if we have valid help_queue_id and class_id
    IF help_queue_id IS NOT NULL AND class_id IS NOT NULL THEN
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

        -- If the change came from a PRIVATE help request, route to office-hours staff only
        IF TG_TABLE_NAME = 'help_requests' AND is_private_request IS TRUE THEN
            PERFORM realtime.send(
                queue_payload,
                'broadcast',
                'help_queues:' || class_id || ':staff',
                true
            );
        ELSE
            -- Normal case: send to queue-specific and class-scoped aggregators
            PERFORM realtime.send(
                queue_payload,
                'broadcast',
                'help_queue:' || help_queue_id,
                true
            );

            PERFORM realtime.send(
                queue_payload,
                'broadcast',
                'help_queues:' || class_id,
                true
            );
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$;


-- 2) Pre-create channels using class-scoped aggregator
CREATE OR REPLACE FUNCTION public.create_help_queue_channels()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Pre-create the individual help queue channel
    PERFORM realtime.send(
        jsonb_build_object(
            'type', 'channel_created',
            'help_queue_id', NEW.id,
            'class_id', NEW.class_id,
            'created_at', NOW()
        ),
        'system',
        'help_queue:' || NEW.id,
        true
    );

    -- Also broadcast to the class-scoped help_queues aggregator
    PERFORM realtime.send(
        jsonb_build_object(
            'type', 'help_queue_created',
            'help_queue_id', NEW.id,
            'class_id', NEW.class_id,
            'created_at', NOW()
        ),
        'system',
        'help_queues:' || NEW.class_id,
        true
    );

    RETURN NEW;
END;
$$;


-- 3) Route private help request data to help_queues:<class_id>:staff; keep public on per-request topic
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
        PERFORM realtime.send(
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


-- 4) Staff data always to office-hours staff, remove per-request staff broadcasts
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
        PERFORM realtime.send(
            staff_payload,
            'broadcast',
            'help_queues:' || class_id || ':staff',
            true
        );
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;


-- 5) Authorization: remove global help_queues; add class-scoped aggregator and restrict private requests to staff
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

    -- class-level channels
    if topic_type = 'class' then
        if array_length(topic_parts, 1) < 3 then
            return false;
        end if;
        class_id_text := topic_parts[2];
        channel_type := topic_parts[3];
        begin
            class_id_bigint := class_id_text::bigint;
        exception when others then
            return false;
        end;
        if channel_type = 'staff' then
            return public.authorizeforclassgrader(class_id_bigint);
        elsif channel_type = 'user' then
            if array_length(topic_parts, 1) != 4 then
                return false;
            end if;
            profile_id_text := topic_parts[4];
            begin
                profile_id_uuid := profile_id_text::uuid;
            exception when others then
                return false;
            end;
            return public.authorizeforclassgrader(class_id_bigint) or public.authorizeforprofile(profile_id_uuid);
        else
            return false;
        end if;
    end if;

    return false;
END;
$$;


-- 6) Do not pre-create per-request staff channels (we will only use office-hours staff)
CREATE OR REPLACE FUNCTION public.create_help_request_channels()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Pre-create the main help request channel by sending an initial message
    PERFORM realtime.send(
        jsonb_build_object(
            'type', 'channel_created',
            'help_request_id', NEW.id,
            'class_id', NEW.class_id,
            'created_at', NOW()
        ),
        'system',
        'help_request:' || NEW.id,
        true
    );

    RETURN NEW;
END;
$$;
