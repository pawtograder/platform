--Migration: Allow students to view autograder data such as submissions count and max submissions in a period

CREATE OR REPLACE FUNCTION get_submissions_limits(p_assignment_id int8)
RETURNS TABLE(
	id int8,
	created_at timestamptz,
	max_submissions_count int4,
	max_submissions_period_secs int4
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
	RETURN QUERY
	SELECT a.id, a.created_at, a.max_submissions_count, a.max_submissions_period_secs
	FROM public.autograder a
	JOIN public.assignments asn ON asn.id = a.id
	WHERE a.id = p_assignment_id
	  AND EXISTS (
		SELECT 1
	    	FROM public.user_privileges up
	    	WHERE up.role = 'student'
	      	AND up.user_id = auth.uid()
	      	AND up.class_id = asn.class_id
    );
END;
$$;


