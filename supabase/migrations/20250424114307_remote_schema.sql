drop policy "Graders and instructors insert" on "public"."assignment_due_date_exceptions";

drop policy "visible to instructors graders and self" on "public"."grader_result_tests";

revoke delete on table "public"."user_roles" from "anon";

revoke insert on table "public"."user_roles" from "anon";

revoke references on table "public"."user_roles" from "anon";

revoke select on table "public"."user_roles" from "anon";

revoke trigger on table "public"."user_roles" from "anon";

revoke truncate on table "public"."user_roles" from "anon";

revoke update on table "public"."user_roles" from "anon";

alter table "public"."classes" add column "features" jsonb;

create policy "Graders and instructors insert"
on "public"."assignment_due_date_exceptions"
as permissive
for insert
to authenticated
with check (((authorizeforprofile(creator_id) AND authorizeforclassgrader(class_id)) OR authorize_to_create_own_due_date_extension(student_id, assignment_group_id, assignment_id, class_id, creator_id, hours, tokens_consumed)));


create policy "visible to instructors graders and self"
on "public"."grader_result_tests"
as permissive
for select
to public
using ((authorizeforclassgrader(class_id) OR ((is_released AND authorizeforprofile(student_id)) OR authorizeforassignmentgroup(assignment_group_id))));

