drop policy "Graders can CRUD self-assignments" on "public"."help_queue_assignments";

drop policy "Instructors can CRUD queues" on "public"."help_queue_assignments";

create policy "Instructors and graders can CRUD help queue assignments"
on "public"."help_queue_assignments"
as permissive
for all
to authenticated
using (authorizeforclassgrader(class_id))
with check (authorizeforclassgrader(class_id));



