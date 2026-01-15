--Migration: Extend get_submissions_limits to return submissions_used and submissions_remaining

-- Drop the existing function first since we're changing the return type
DROP FUNCTION IF EXISTS get_submissions_limits(int8);

CREATE FUNCTION get_submissions_limits(p_assignment_id int8)
RETURNS TABLE(
	id int8,
	created_at timestamptz,
	max_submissions_count int4,
	max_submissions_period_secs int4,
	submissions_used int4,
	submissions_remaining int4
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
	v_profile_id uuid;
	v_assignment_group_id int8;
	v_submissions_count int4;
	v_max_submissions_count int4;
	v_max_submissions_period_secs int4;
BEGIN
	-- Get the student's profile_id
	SELECT ur.private_profile_id INTO v_profile_id
	FROM public.user_privileges up
	JOIN public.user_roles ur ON ur.user_id = up.user_id AND ur.class_id = up.class_id
	WHERE up.role = 'student'
	  AND up.user_id = auth.uid()
	  AND EXISTS (
		SELECT 1
		FROM public.assignments a
		WHERE a.id = p_assignment_id
		  AND a.class_id = up.class_id
	  )
	LIMIT 1;

	-- If no profile found, return empty result
	IF v_profile_id IS NULL THEN
		RETURN;
	END IF;

	-- Check if student is in a group for this assignment
	SELECT agm.assignment_group_id INTO v_assignment_group_id
	FROM public.assignment_groups_members agm
	WHERE agm.assignment_id = p_assignment_id
	  AND agm.profile_id = v_profile_id
	LIMIT 1;

	-- Get autograder settings
	SELECT a.max_submissions_count, a.max_submissions_period_secs
	INTO v_max_submissions_count, v_max_submissions_period_secs
	FROM public.autograder a
	JOIN public.assignments asn ON asn.id = a.id
	WHERE a.id = p_assignment_id
	  AND EXISTS (
		SELECT 1
		FROM public.user_privileges up
		WHERE up.role = 'student'
		  AND up.user_id = auth.uid()
		  AND up.class_id = asn.class_id
	  )
	LIMIT 1;

	-- If no autograder settings found, return empty result
	IF v_max_submissions_count IS NULL OR v_max_submissions_period_secs IS NULL THEN
		RETURN;
	END IF;

	-- Count submissions within the time window
	-- Only count submissions where grader_results IS NULL OR grader_results.score > 0
	SELECT COUNT(*)::int4 INTO v_submissions_count
	FROM public.submissions s
	LEFT JOIN public.grader_results gr ON gr.submission_id = s.id
	WHERE s.assignment_id = p_assignment_id
	  AND s.created_at >= (NOW() - (v_max_submissions_period_secs || ' seconds')::interval)
	  AND (
		(v_assignment_group_id IS NOT NULL AND s.assignment_group_id = v_assignment_group_id)
		OR (v_assignment_group_id IS NULL AND s.profile_id = v_profile_id AND s.assignment_group_id IS NULL)
	  )
	  AND (gr.id IS NULL OR gr.score > 0);

	-- Return the result
	RETURN QUERY
	SELECT 
		p_assignment_id as id,
		NOW() as created_at,
		v_max_submissions_count as max_submissions_count,
		v_max_submissions_period_secs as max_submissions_period_secs,
		v_submissions_count as submissions_used,
		GREATEST(0, v_max_submissions_count - v_submissions_count) as submissions_remaining;
END;
$$;
