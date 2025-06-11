
drop policy "students view own, instructors and graders view all" on "public"."submission_artifact_comments";

drop policy "students view own, instructors and graders view all" on "public"."submission_comments";

drop policy "students view own, instructors and graders view all" on "public"."submission_file_comments";

create policy "students view own, instructors and graders view all"
on "public"."submission_artifact_comments"
as permissive
for select
to public
using ((authorizeforclassgrader(class_id) OR (released AND authorize_for_submission(submission_id)) OR authorize_for_submission_review(submission_review_id)));


create policy "students view own, instructors and graders view all"
on "public"."submission_comments"
as permissive
for select
to public
using ((authorizeforclassgrader(class_id) OR (released AND authorize_for_submission(submission_id)) OR authorize_for_submission_review(submission_review_id)));


create policy "students view own, instructors and graders view all"
on "public"."submission_file_comments"
as permissive
for select
to public
using ((authorizeforclassgrader(class_id) OR (released AND authorize_for_submission(submission_id)) OR authorize_for_submission_review(submission_review_id)));


ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."submission_reviews";
ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."review_assignments";