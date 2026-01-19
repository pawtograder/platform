-- Add RPC function to set discussion thread visibility
-- This function allows updating the instructors_only visibility for a root post
-- and all its descendant posts atomically

CREATE OR REPLACE FUNCTION public.set_discussion_thread_visibility(
  p_thread_id bigint,
  p_instructors_only boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_thread_class_id bigint;
  v_thread_root bigint;
  v_thread_author text;
  v_is_staff boolean;
  v_is_author boolean;
BEGIN
  -- Set fixed search_path to prevent search_path attacks
  PERFORM set_config('search_path', 'pg_catalog, public', true);
  
  -- Get the thread and verify it exists
  SELECT class_id, root, author
  INTO v_thread_class_id, v_thread_root, v_thread_author
  FROM public.discussion_threads
  WHERE id = p_thread_id;
  
  IF v_thread_class_id IS NULL THEN
    RAISE EXCEPTION 'Thread not found'
      USING ERRCODE = 'no_data_found';
  END IF;
  
  -- Verify this is a root thread (root is NULL or equals id)
  IF v_thread_root IS NOT NULL AND v_thread_root != p_thread_id THEN
    RAISE EXCEPTION 'Can only set visibility for root posts'
      USING ERRCODE = 'check_violation';
  END IF;
  
  -- Check if the caller is a grader or instructor for this class
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = auth.uid()
      AND class_id = v_thread_class_id
      AND disabled = false
      AND role IN ('grader', 'instructor')
  ) INTO v_is_staff;
  
  -- Check if the caller is the author of the thread
  -- Cast v_thread_author (text) to uuid for comparison with profile IDs
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = auth.uid()
      AND class_id = v_thread_class_id
      AND (private_profile_id = v_thread_author::uuid OR public_profile_id = v_thread_author::uuid)
  ) INTO v_is_author;
  
  -- Check that the caller is either staff or the author
  IF NOT (v_is_staff OR v_is_author) THEN
    RAISE EXCEPTION 'Access denied: Must be grader/instructor or thread author'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  
  -- Update the root thread and all descendant threads atomically
  -- All updates happen in a single transaction (implicit)
  UPDATE public.discussion_threads
  SET instructors_only = p_instructors_only
  WHERE id = p_thread_id;
  
  -- Update all descendant threads (replies) to match the root visibility
  UPDATE public.discussion_threads
  SET instructors_only = p_instructors_only
  WHERE root = p_thread_id
    AND id != p_thread_id;  -- Don't update the root again
  
END;
$$;

-- Grant execute permission to authenticated users
-- Authorization is checked within the function
GRANT EXECUTE ON FUNCTION public.set_discussion_thread_visibility(bigint, boolean) TO authenticated;

-- Add comment
COMMENT ON FUNCTION public.set_discussion_thread_visibility IS 
'Sets the visibility (instructors_only) for a root discussion thread and all its descendant posts atomically. Staff (grader/instructor) or thread author only. Updates both the root thread and all child threads in a single transaction.';
