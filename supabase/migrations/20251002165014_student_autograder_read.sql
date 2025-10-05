--Migration: Allow students to view autograder data such as submissions count and max submissions in a period

CREATE OR REPLACE FUNCTION get_submissions_limits()
RETURNS TABLE(
	id int8,
	created_at timestamptz,
	max_submissions_count int4,
	max_submissions_period_secs int4
)
LANGUAGE plpgsql
AS $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM public.user_privileges up
		WHERE up.role = ('student')
		    AND up.user_id = auth.uid()
		)
	THEN RETURN QUERY SELECT a.id, a.created_at, a.max_submissions_count, a.max_submissions_period_secs
		FROM public.autograder a;
	END IF;
END;
$$;


