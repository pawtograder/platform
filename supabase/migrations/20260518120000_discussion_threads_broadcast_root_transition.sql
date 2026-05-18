-- When a root thread is merged as a duplicate, the row transitions from root → reply
-- (root_class_id is nulled out). The existing broadcast trigger only sends to the students
-- channel when the row is currently a root, so students viewing the discussion feed never
-- receive a signal to remove the stale teaser. Extend the trigger to also broadcast to the
-- students channel when the row WAS a root in the previous state.

CREATE OR REPLACE FUNCTION public.broadcast_discussion_threads_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
DECLARE
    target_class_id bigint;
    thread_root_id bigint;
    is_root_thread boolean;
    was_root_thread boolean;
    staff_payload jsonb;
    student_payload jsonb;
    thread_payload jsonb;
BEGIN
    IF TG_OP = 'INSERT' THEN
        target_class_id := NEW.class_id;
        thread_root_id := COALESCE(NEW.root, NEW.id);
        is_root_thread := NEW.root IS NULL OR NEW.root = NEW.id;
        was_root_thread := false;
    ELSIF TG_OP = 'UPDATE' THEN
        target_class_id := COALESCE(NEW.class_id, OLD.class_id);
        thread_root_id := COALESCE(NEW.root, OLD.root, NEW.id, OLD.id);
        is_root_thread := (NEW.root IS NULL OR NEW.root = NEW.id);
        was_root_thread := (OLD.root IS NULL OR OLD.root = OLD.id);
    ELSIF TG_OP = 'DELETE' THEN
        target_class_id := OLD.class_id;
        thread_root_id := COALESCE(OLD.root, OLD.id);
        is_root_thread := OLD.root IS NULL OR OLD.root = OLD.id;
        was_root_thread := is_root_thread;
    END IF;

    IF target_class_id IS NOT NULL THEN
        staff_payload := jsonb_build_object(
            'type', 'staff_data_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END,
            'data', CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,
            'class_id', target_class_id,
            'discussion_thread_root_id', thread_root_id,
            'timestamp', NOW()
        );

        PERFORM public.safe_broadcast(
            staff_payload,
            'broadcast',
            'class:' || target_class_id || ':staff',
            true
        );

        -- Broadcast to the students channel for the discussion feed when the row is
        -- currently a root OR was previously a root (so a duplicate-merge transition
        -- properly evicts the stale teaser from student caches).
        IF is_root_thread OR was_root_thread THEN
            student_payload := jsonb_build_object(
                'type', 'table_change',
                'operation', TG_OP,
                'table', TG_TABLE_NAME,
                'row_id', CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END,
                'data', CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,
                'class_id', target_class_id,
                'timestamp', NOW()
            );

            PERFORM public.safe_broadcast(
                student_payload,
                'broadcast',
                'class:' || target_class_id || ':students',
                true
            );
        END IF;

        thread_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END,
            'data', CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,
            'class_id', target_class_id,
            'discussion_thread_root_id', thread_root_id,
            'timestamp', NOW()
        );

        IF thread_root_id IS NOT NULL THEN
            PERFORM public.safe_broadcast(
                thread_payload,
                'broadcast',
                'discussion_thread:' || thread_root_id,
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

COMMENT ON FUNCTION public.broadcast_discussion_threads_change() IS
'Smart broadcast for discussion_threads with targeted channel routing. Staff channel always
receives the row; students channel receives root threads AND transitions out of root (e.g.
duplicate-merge), so feed caches evict correctly; per-thread channel always receives the row.';
