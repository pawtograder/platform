drop policy "authorizeforclass" on "public"."rubrics";

drop policy "students view own, instructors and graders view all" on "public"."submission_artifact_comments";

drop policy "students view own, instructors and graders view all" on "public"."submission_comments";

drop policy "students view own, instructors and graders view all" on "public"."submission_file_comments";

create policy "Instructors can manage grading conflicts"
on "public"."grading_conflicts"
as permissive
for all
to authenticated
using (authorizeforclassinstructor(class_id))
with check (authorizeforclassinstructor(class_id));


create policy "Assignees can view rubric parts for their reviews"
on "public"."review_assignment_rubric_parts"
as permissive
for select
to authenticated
using ((EXISTS ( SELECT 1
   FROM review_assignments ra
  WHERE ((ra.id = review_assignment_rubric_parts.review_assignment_id) AND (ra.assignee_profile_id = ( SELECT user_roles.private_profile_id
           FROM user_roles
          WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.class_id = review_assignment_rubric_parts.class_id))))))));


create policy "Instructors can manage review assignment rubric parts"
on "public"."review_assignment_rubric_parts"
as permissive
for all
to authenticated
using (authorizeforclassinstructor(class_id))
with check (authorizeforclassinstructor(class_id));


create policy "Assignees can view their own review assignments"
on "public"."review_assignments"
as permissive
for select
to authenticated
using ((assignee_profile_id = ( SELECT user_roles.private_profile_id
   FROM user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.class_id = review_assignments.class_id)))));


create policy "Instructors can manage review assignments"
on "public"."review_assignments"
as permissive
for all
to authenticated
using (authorizeforclassinstructor(class_id))
with check (authorizeforclassinstructor(class_id));


create policy "Instructors can manage rubric check references"
on "public"."rubric_check_references"
as permissive
for all
to authenticated
using (authorizeforclassinstructor(class_id))
with check (authorizeforclassinstructor(class_id));


create policy "Users in class can view rubric check references"
on "public"."rubric_check_references"
as permissive
for select
to authenticated
using (authorizeforclass(class_id));


create policy "authorizeforclass"
on "public"."rubrics"
as permissive
for select
to public
using ((authorizeforclass(class_id) AND (authorizeforclassgrader(class_id) OR COALESCE((review_round <> 'meta-grading-review'::review_round), true))));


create policy "students view own, instructors and graders view all"
on "public"."submission_artifact_comments"
as permissive
for select
to public
using ((authorizeforclassgrader(class_id) OR (released AND authorize_for_submission(submission_id) AND (eventually_visible = true))));


create policy "students view own, instructors and graders view all"
on "public"."submission_comments"
as permissive
for select
to public
using ((authorizeforclassgrader(class_id) OR (released AND authorize_for_submission(submission_id) AND (eventually_visible = true))));


create policy "students view own, instructors and graders view all"
on "public"."submission_file_comments"
as permissive
for select
to public
using ((authorizeforclassgrader(class_id) OR (released AND authorize_for_submission(submission_id) AND (eventually_visible = true))));



