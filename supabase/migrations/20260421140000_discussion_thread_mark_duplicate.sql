-- Staff can merge a duplicate discussion root (and its replies) under another root as a reply.
-- Metadata columns support a banner in the UI; RPC notifies the duplicate author. The broadcast
-- trigger is extended so that the row's transition out of "root" reaches student feed caches,
-- and the cache-invalidation trigger is extended so the SSR cache for the originating class is
-- invalidated when root_class_id transitions to NULL.

-- =====================================================================
-- Columns: metadata for the duplicate-merge banner
-- =====================================================================
ALTER TABLE public.discussion_threads
  ADD COLUMN IF NOT EXISTS duplicate_original_subject text,
  ADD COLUMN IF NOT EXISTS duplicate_marked_by_user_id uuid REFERENCES auth.users (id),
  ADD COLUMN IF NOT EXISTS duplicate_marked_by_display_name text,
  ADD COLUMN IF NOT EXISTS duplicate_marked_at timestamptz;

COMMENT ON COLUMN public.discussion_threads.duplicate_original_subject IS
  'When staff merges a thread as a duplicate, the former root subject is preserved for the banner.';
COMMENT ON COLUMN public.discussion_threads.duplicate_marked_by_user_id IS
  'Auth user id of the staff member who marked this post as a duplicate.';
COMMENT ON COLUMN public.discussion_threads.duplicate_marked_by_display_name IS
  'Staff display name at merge time (from public.users).';
COMMENT ON COLUMN public.discussion_threads.duplicate_marked_at IS
  'When this post was marked as a duplicate and relocated.';

-- =====================================================================
-- RPC: mark_discussion_thread_duplicate
-- =====================================================================
CREATE OR REPLACE FUNCTION public.mark_discussion_thread_duplicate(
  p_duplicate_root_id bigint,
  p_original_root_id bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_dup_class_id bigint;
  v_dup_root bigint;
  v_dup_subject text;
  v_dup_author_profile uuid;
  v_orig_class_id bigint;
  v_orig_root bigint;
  v_orig_topic_id bigint;
  v_orig_instructors_only boolean;
  v_author_user_id uuid;
  v_staff_name text;
  v_orig_subject text;
  v_dup_ordinal integer;
BEGIN
  PERFORM set_config('search_path', 'pg_catalog, public', true);
  -- SECURITY DEFINER still applies RLS as the invoker; disable for this body so
  -- discussion_threads SELECT policy cannot recurse (42P17) during root/parent updates.
  PERFORM set_config('row_security', 'off', true);

  IF p_duplicate_root_id = p_original_root_id THEN
    RAISE EXCEPTION 'Cannot mark a thread as a duplicate of itself'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT dt.class_id, dt.root, dt.subject, dt.author, dt.ordinal
  INTO v_dup_class_id, v_dup_root, v_dup_subject, v_dup_author_profile, v_dup_ordinal
  FROM public.discussion_threads dt
  WHERE dt.id = p_duplicate_root_id;

  IF v_dup_class_id IS NULL THEN
    RAISE EXCEPTION 'Duplicate thread not found'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_dup_root IS NULL OR v_dup_root != p_duplicate_root_id THEN
    RAISE EXCEPTION 'Can only mark root discussion posts as duplicates'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT dt.class_id, dt.root, dt.topic_id, dt.instructors_only, dt.subject
  INTO v_orig_class_id, v_orig_root, v_orig_topic_id, v_orig_instructors_only, v_orig_subject
  FROM public.discussion_threads dt
  WHERE dt.id = p_original_root_id;

  IF v_orig_class_id IS NULL THEN
    RAISE EXCEPTION 'Original thread not found'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_orig_root IS NULL OR v_orig_root != p_original_root_id THEN
    RAISE EXCEPTION 'Original must be a root discussion post'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_dup_class_id != v_orig_class_id THEN
    RAISE EXCEPTION 'Threads must belong to the same class'
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.discussion_threads o
    WHERE o.id = p_original_root_id
      AND (o.id = p_duplicate_root_id OR o.root = p_duplicate_root_id)
  ) THEN
    RAISE EXCEPTION 'Original thread cannot be the duplicate or a reply under the duplicate'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT (
    public.authorizeforclassinstructor(v_dup_class_id)
    OR public.authorizeforclassgrader(v_dup_class_id)
  ) THEN
    RAISE EXCEPTION 'Access denied: Grader or instructor role required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT ur.user_id
  INTO v_author_user_id
  FROM public.user_roles ur
  WHERE ur.class_id = v_dup_class_id
    AND ur.disabled = false
    AND (ur.private_profile_id = v_dup_author_profile OR ur.public_profile_id = v_dup_author_profile)
  LIMIT 1;

  SELECT COALESCE(u.name, u.email, 'Course staff')
  INTO v_staff_name
  FROM public.users u
  WHERE u.user_id = auth.uid();

  -- Drop watcher rows that would violate (user_id, discussion_thread_root_id) uniqueness after retargeting
  DELETE FROM public.discussion_thread_watchers wdup
  USING public.discussion_thread_watchers worig
  WHERE wdup.discussion_thread_root_id = p_duplicate_root_id
    AND worig.discussion_thread_root_id = p_original_root_id
    AND wdup.user_id = worig.user_id;

  UPDATE public.discussion_thread_watchers
  SET discussion_thread_root_id = p_original_root_id
  WHERE discussion_thread_root_id = p_duplicate_root_id;

  UPDATE public.discussion_thread_read_status
  SET discussion_thread_root_id = p_original_root_id
  WHERE discussion_thread_root_id = p_duplicate_root_id;

  UPDATE public.discussion_threads
  SET
    root = p_original_root_id,
    parent = p_original_root_id,
    topic_id = v_orig_topic_id,
    instructors_only = v_orig_instructors_only,
    root_class_id = NULL,
    duplicate_original_subject = v_dup_subject,
    duplicate_marked_by_user_id = auth.uid(),
    duplicate_marked_by_display_name = v_staff_name,
    duplicate_marked_at = now()
  WHERE id = p_duplicate_root_id;

  UPDATE public.discussion_threads
  SET
    root = p_original_root_id,
    topic_id = v_orig_topic_id,
    instructors_only = v_orig_instructors_only
  WHERE root = p_duplicate_root_id
    AND id != p_duplicate_root_id;

  PERFORM public.recalculate_discussion_thread_children_counts(v_dup_class_id);

  IF v_author_user_id IS NOT NULL AND v_author_user_id IS DISTINCT FROM auth.uid() THEN
    INSERT INTO public.notifications (class_id, subject, body, style, user_id)
    VALUES (
      v_dup_class_id,
      '{}'::jsonb,
      jsonb_build_object(
        'type', 'discussion_thread',
        'action', 'marked_duplicate',
        'root_thread_id', p_original_root_id,
        'duplicate_thread_id', p_duplicate_root_id,
        'original_thread_subject', v_orig_subject,
        'duplicate_original_subject', v_dup_subject,
        'marked_by_user_id', auth.uid(),
        'marked_by_name', v_staff_name,
        'duplicate_thread_ordinal', v_dup_ordinal
      ),
      'info',
      v_author_user_id
    );
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_discussion_thread_duplicate(bigint, bigint) TO authenticated;

COMMENT ON FUNCTION public.mark_discussion_thread_duplicate(bigint, bigint) IS
  'Moves a root thread and its replies under another root as a duplicate; records banner metadata and notifies the duplicate author.';

-- =====================================================================
-- Broadcast trigger: ensure root → reply transitions evict student feed teasers
-- =====================================================================
-- When a root thread is merged as a duplicate, the row transitions from root → reply
-- (root_class_id is nulled out). The previous broadcast trigger only sent to the students
-- channel when the row was currently a root, so students viewing the discussion feed never
-- received a signal to remove the stale teaser. Extend the trigger to also broadcast to the
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
    visible_to_students boolean;
    staff_payload jsonb;
    student_payload jsonb;
    thread_payload jsonb;
BEGIN
    IF TG_OP = 'INSERT' THEN
        target_class_id := NEW.class_id;
        thread_root_id := COALESCE(NEW.root, NEW.id);
        is_root_thread := NEW.root IS NULL OR NEW.root = NEW.id;
        was_root_thread := false;
        visible_to_students := NOT COALESCE(NEW.instructors_only, false);
    ELSIF TG_OP = 'UPDATE' THEN
        target_class_id := COALESCE(NEW.class_id, OLD.class_id);
        thread_root_id := COALESCE(NEW.root, OLD.root, NEW.id, OLD.id);
        is_root_thread := (NEW.root IS NULL OR NEW.root = NEW.id);
        was_root_thread := (OLD.root IS NULL OR OLD.root = OLD.id);
        visible_to_students := NOT COALESCE(NEW.instructors_only, false);
    ELSIF TG_OP = 'DELETE' THEN
        target_class_id := OLD.class_id;
        thread_root_id := COALESCE(OLD.root, OLD.id);
        is_root_thread := OLD.root IS NULL OR OLD.root = OLD.id;
        was_root_thread := is_root_thread;
        visible_to_students := NOT COALESCE(OLD.instructors_only, false);
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
        -- properly evicts the stale teaser from student caches). Skip for
        -- instructors_only threads to avoid leaking staff-only content to students.
        IF (is_root_thread OR was_root_thread) AND visible_to_students THEN
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

-- =====================================================================
-- Cache-invalidation trigger: include OLD.root_class_id on UPDATE
-- =====================================================================
-- When a root thread becomes a duplicate, root_class_id transitions X → NULL. Inspecting
-- only new_table on UPDATE means class X's SSR cache is never invalidated, so the teaser
-- stays in the discussion feed on the next page load. Union OLD and NEW for UPDATE so both
-- the "leaving" and "joining" class caches are invalidated.
CREATE OR REPLACE FUNCTION public.invalidate_discussion_threads_cache()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  class_ids bigint[];
  class_id_value bigint;
  tags text[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT ARRAY_AGG(DISTINCT root_class_id ORDER BY root_class_id)
    INTO class_ids
    FROM old_table
    WHERE root_class_id IS NOT NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT ARRAY_AGG(DISTINCT root_class_id ORDER BY root_class_id)
    INTO class_ids
    FROM (
      SELECT root_class_id FROM old_table WHERE root_class_id IS NOT NULL
      UNION
      SELECT root_class_id FROM new_table WHERE root_class_id IS NOT NULL
    ) AS combined;
  ELSE
    SELECT ARRAY_AGG(DISTINCT root_class_id ORDER BY root_class_id)
    INTO class_ids
    FROM new_table
    WHERE root_class_id IS NOT NULL;
  END IF;

  IF class_ids IS NULL OR array_length(class_ids, 1) IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  FOREACH class_id_value IN ARRAY class_ids
  LOOP
    tags := ARRAY[
      'discussion_threads:' || class_id_value || ':staff',
      'discussion_threads:' || class_id_value || ':student'
    ];
    PERFORM public.call_cache_invalidate(tags);
  END LOOP;

  RETURN COALESCE(NEW, OLD);
END;
$$;
