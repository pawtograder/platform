-- Add RPC function to toggle discussion thread author anonymity
-- This function allows staff to toggle between public and private profile IDs
-- for a root post and all its descendant posts (replies) by the same user

CREATE OR REPLACE FUNCTION public.toggle_discussion_thread_author_anonymity(
  p_thread_id bigint,
  p_make_anonymous boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_thread_class_id bigint;
  v_current_author_id text;
  v_target_author_id text;
  v_user_role_record public.user_roles%ROWTYPE;
  v_is_staff boolean;
  v_thread_root bigint;
BEGIN
  -- Set fixed search_path to prevent search_path attacks
  PERFORM set_config('search_path', 'pg_catalog, public', true);
  
  -- Get the thread and verify it exists and is a root thread
  SELECT class_id, author, root
  INTO v_thread_class_id, v_current_author_id, v_thread_root
  FROM public.discussion_threads
  WHERE id = p_thread_id;
  
  IF v_thread_class_id IS NULL THEN
    RAISE EXCEPTION 'Thread not found'
      USING ERRCODE = 'no_data_found';
  END IF;
  
  -- Verify this is a root thread (root is NULL or equals id)
  IF v_thread_root IS NOT NULL AND v_thread_root != p_thread_id THEN
    RAISE EXCEPTION 'Can only toggle anonymity for root posts'
      USING ERRCODE = 'check_violation';
  END IF;
  
  -- Check that the caller is a grader or instructor for this class
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = auth.uid()
      AND class_id = v_thread_class_id
      AND disabled = false
      AND role IN ('grader', 'instructor')
  ) INTO v_is_staff;
  
  IF NOT v_is_staff THEN
    RAISE EXCEPTION 'Access denied: Grader or instructor role required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  
  -- Find the user_roles record that matches the current author
  -- The author could be either private_profile_id or public_profile_id
  SELECT *
  INTO v_user_role_record
  FROM public.user_roles
  WHERE class_id = v_thread_class_id
    AND (private_profile_id = v_current_author_id OR public_profile_id = v_current_author_id)
  LIMIT 1;
  
  IF v_user_role_record IS NULL THEN
    RAISE EXCEPTION 'Could not find user role for thread author'
      USING ERRCODE = 'no_data_found';
  END IF;
  
  -- Determine target profile ID based on p_make_anonymous
  IF p_make_anonymous THEN
    v_target_author_id := v_user_role_record.public_profile_id;
  ELSE
    v_target_author_id := v_user_role_record.private_profile_id;
  END IF;
  
  -- If already at target state, no-op
  IF v_current_author_id = v_target_author_id THEN
    RETURN;
  END IF;
  
  -- Update the root thread
  UPDATE public.discussion_threads
  SET author = v_target_author_id
  WHERE id = p_thread_id;
  
  -- Update all descendant threads (replies) by the same user
  -- We need to find all threads where:
  -- 1. root = p_thread_id (they're part of this thread tree)
  -- 2. author matches either the old private or public profile ID (same user)
  UPDATE public.discussion_threads
  SET author = v_target_author_id
  WHERE root = p_thread_id
    AND id != p_thread_id  -- Don't update the root again
    AND author IN (v_user_role_record.private_profile_id, v_user_role_record.public_profile_id);
  
END;
$$;

-- Grant execute permission to authenticated users
-- Authorization is checked within the function
GRANT EXECUTE ON FUNCTION public.toggle_discussion_thread_author_anonymity(bigint, boolean) TO authenticated;

-- Add comment
COMMENT ON FUNCTION public.toggle_discussion_thread_author_anonymity IS 
'Toggles the author anonymity for a root discussion thread and all its descendant posts by the same user. Staff (grader/instructor) only. If p_make_anonymous is true, switches to public_profile_id; if false, switches to private_profile_id.';

-- Add RPC function to set discussion thread topic
-- This function allows staff to update the topic for a root post and all its descendant posts atomically

CREATE OR REPLACE FUNCTION public.set_discussion_thread_topic(
  p_thread_id bigint,
  p_topic_id bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_thread_class_id bigint;
  v_thread_root bigint;
BEGIN
  -- Set fixed search_path to prevent search_path attacks
  PERFORM set_config('search_path', 'pg_catalog, public', true);
  
  -- Get the thread and verify it exists
  SELECT class_id, root
  INTO v_thread_class_id, v_thread_root
  FROM public.discussion_threads
  WHERE id = p_thread_id;
  
  IF v_thread_class_id IS NULL THEN
    RAISE EXCEPTION 'Thread not found'
      USING ERRCODE = 'no_data_found';
  END IF;
  
  -- Verify this is a root thread (root is NULL or equals id)
  IF v_thread_root IS NOT NULL AND v_thread_root != p_thread_id THEN
    RAISE EXCEPTION 'Can only set topic for root posts'
      USING ERRCODE = 'check_violation';
  END IF;
  
  -- Check that the caller is a grader or instructor for this class
  IF NOT (public.authorizeforclassinstructor(v_thread_class_id) OR public.authorizeforclassgrader(v_thread_class_id)) THEN
    RAISE EXCEPTION 'Access denied: Grader or instructor role required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  
  -- Update the root thread and all descendant threads atomically
  -- All updates happen in a single transaction (implicit)
  UPDATE public.discussion_threads
  SET topic_id = p_topic_id
  WHERE id = p_thread_id;
  
  -- Update all descendant threads (replies) to match the root topic
  UPDATE public.discussion_threads
  SET topic_id = p_topic_id
  WHERE root = p_thread_id
    AND id != p_thread_id;  -- Don't update the root again
  
END;
$$;

-- Grant execute permission to authenticated users
-- Authorization is checked within the function
GRANT EXECUTE ON FUNCTION public.set_discussion_thread_topic(bigint, bigint) TO authenticated;

-- Add comment
COMMENT ON FUNCTION public.set_discussion_thread_topic IS 
'Sets the topic for a root discussion thread and all its descendant posts atomically. Staff (grader/instructor) only. Updates both the root thread and all child threads in a single transaction.';
