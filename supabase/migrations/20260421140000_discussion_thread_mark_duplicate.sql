-- Staff can merge a duplicate discussion root (and its replies) under another root as a reply.
-- Metadata columns support a banner in the UI; RPC notifies the duplicate author.

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
