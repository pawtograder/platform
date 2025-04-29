create policy "Only graders and instructors can update"
on "public"."submission_artifact_comments"
as permissive
for update
to public
using (authorizeforclassgrader(class_id));


create policy "insert for self"
on "public"."submission_artifact_comments"
as permissive
for insert
to public
with check ((authorizeforprofile(author) AND (authorizeforclassgrader(class_id) OR (authorizeforclassgrader(class_id) OR ((submission_review_id IS NULL) AND authorize_for_submission(submission_id))))));


create policy "students view own, instructors and graders view all"
on "public"."submission_artifact_comments"
as permissive
for select
to public
using ((authorizeforclassgrader(class_id) OR (released AND authorize_for_submission(submission_id))));



