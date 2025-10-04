--Migration: Allow students to view autograder data such as submissions count and max submissions in a period

CREATE POLICY "Students can view autograder data"
ON public.autograder
FOR SELECT
USING (
	EXISTS (
		SELECT 1
		FROM public.user_privileges up
		JOIN public.assignments a ON a.id = autograder.id
		WHERE up.role = ('student')
		    AND up.user_id = auth.uid()
		    AND up.course_id = a.course_id
		)
	);
