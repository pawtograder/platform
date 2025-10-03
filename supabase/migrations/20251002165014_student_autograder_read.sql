--Migration: Allow students to view autograder data such as submissions count and max submissions in a period

CREATE POLICY "Students can view autograder data"
ON public.autograder
USING (
	SELECT up.private_profile_id
	FROM public.user_privileges up
	WHERE up.role = ('student')
	AND up.user_id = auth.uid()
);
