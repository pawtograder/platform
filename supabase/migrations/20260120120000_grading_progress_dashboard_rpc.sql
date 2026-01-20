-- Create RPC function to get grading progress for each TA on an assignment
-- This aggregates review_assignments and comment counts efficiently

CREATE OR REPLACE FUNCTION public.get_grading_progress_for_assignment(
  p_class_id bigint,
  p_assignment_id bigint
)
RETURNS TABLE (
  profile_id uuid,
  name text,
  email text,
  pending_count bigint,
  completed_count bigint,
  submissions_with_comments bigint,
  earliest_due_date timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Authorization check: only instructors can view grading progress
  IF NOT public.authorizeforclassinstructor(p_class_id) THEN
    RAISE EXCEPTION 'Access denied: Only instructors can view grading progress'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Validate that the assignment belongs to the class
  IF NOT EXISTS (
    SELECT 1 FROM public.assignments 
    WHERE id = p_assignment_id AND class_id = p_class_id
  ) THEN
    RAISE EXCEPTION 'Assignment not found or does not belong to class'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  WITH grader_info AS (
    -- Get all active graders for this class with their profile and user info
    SELECT 
      ur.private_profile_id,
      p.name,
      u.email
    FROM public.user_roles ur
    INNER JOIN public.profiles p ON p.id = ur.private_profile_id
    INNER JOIN public.users u ON u.user_id = ur.user_id
    WHERE ur.class_id = p_class_id
      AND ur.role = 'grader'
      AND NOT ur.disabled
  ),
  review_stats AS (
    -- Count pending and completed review assignments per grader
    SELECT 
      ra.assignee_profile_id,
      COUNT(*) FILTER (WHERE ra.completed_at IS NULL) AS pending,
      COUNT(*) FILTER (WHERE ra.completed_at IS NOT NULL) AS completed,
      MIN(ra.due_date) FILTER (WHERE ra.completed_at IS NULL) AS earliest_pending_due_date
    FROM public.review_assignments ra
    WHERE ra.assignment_id = p_assignment_id
      AND ra.class_id = p_class_id
    GROUP BY ra.assignee_profile_id
  ),
  comment_stats AS (
    -- Count distinct submissions where each grader has added comments
    SELECT 
      author AS profile_id,
      COUNT(DISTINCT submission_id) AS submissions_with_comments_count
    FROM (
      -- submission_file_comments
      SELECT sfc.author, sfc.submission_id
      FROM public.submission_file_comments sfc
      INNER JOIN public.submissions s ON s.id = sfc.submission_id
      WHERE s.assignment_id = p_assignment_id
        AND sfc.deleted_at IS NULL
      
      UNION
      
      -- submission_comments
      SELECT sc.author, sc.submission_id
      FROM public.submission_comments sc
      INNER JOIN public.submissions s ON s.id = sc.submission_id
      WHERE s.assignment_id = p_assignment_id
        AND sc.deleted_at IS NULL
      
      UNION
      
      -- submission_artifact_comments
      SELECT sac.author, sac.submission_id
      FROM public.submission_artifact_comments sac
      INNER JOIN public.submissions s ON s.id = sac.submission_id
      WHERE s.assignment_id = p_assignment_id
        AND sac.deleted_at IS NULL
    ) AS all_comments
    GROUP BY author
  )
  SELECT 
    gi.private_profile_id,
    gi.name,
    gi.email,
    COALESCE(rs.pending, 0)::bigint AS pending_count,
    COALESCE(rs.completed, 0)::bigint AS completed_count,
    COALESCE(cs.submissions_with_comments_count, 0)::bigint AS submissions_with_comments,
    rs.earliest_pending_due_date AS earliest_due_date
  FROM grader_info gi
  LEFT JOIN review_stats rs ON rs.assignee_profile_id = gi.private_profile_id
  LEFT JOIN comment_stats cs ON cs.profile_id = gi.private_profile_id
  ORDER BY gi.name;
END;
$$;

-- Grant execute permission to authenticated users (RLS will enforce instructor-only access)
GRANT EXECUTE ON FUNCTION public.get_grading_progress_for_assignment(bigint, bigint) TO authenticated;

COMMENT ON FUNCTION public.get_grading_progress_for_assignment IS 
'Returns grading progress statistics for each TA on a specific assignment, including pending/completed review assignments and submissions with comments. Only accessible to instructors.';
