create policy "Graders can create their own grading conflicts"
on "public"."grading_conflicts"
as permissive
for insert
to authenticated
with check ((authorizeforclassgrader(class_id) AND (EXISTS ( SELECT 1
   FROM user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.private_profile_id = grading_conflicts.grader_profile_id) AND (user_roles.class_id = grading_conflicts.class_id) AND (user_roles.role = 'grader'::app_role))))));


create policy "Graders can view their own grading conflicts"
on "public"."grading_conflicts"
as permissive
for select
to authenticated
using ((authorizeforclassgrader(class_id) AND (grader_profile_id IN ( SELECT user_roles.private_profile_id
   FROM user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.class_id = grading_conflicts.class_id))))));



