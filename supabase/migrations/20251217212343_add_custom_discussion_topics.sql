alter table "public"."discussion_topics" add column "assignment_id" bigint;

alter table "public"."discussion_topics" add column "instructor_created" boolean not null default false;

alter table "public"."discussion_topics" add constraint "discussion_topics_assignment_id_fkey" FOREIGN KEY (assignment_id) REFERENCES public.assignments(id) ON UPDATE CASCADE ON DELETE SET NULL not valid;

alter table "public"."discussion_topics" validate constraint "discussion_topics_assignment_id_fkey";


  create policy "Instructors can create topics in their class"
  on "public"."discussion_topics"
  as permissive
  for insert
  to authenticated
with check (public.authorizeforclassinstructor(class_id) AND instructor_created = true);



  create policy "Instructors can delete topics in their class"
  on "public"."discussion_topics"
  as permissive
  for delete
  to authenticated
using (public.authorizeforclassinstructor(class_id) AND instructor_created = true);



  create policy "Instructors can update topics in their class"
  on "public"."discussion_topics"
  as permissive
  for update
  to authenticated
using (public.authorizeforclassinstructor(class_id))
with check (public.authorizeforclassinstructor(class_id) AND instructor_created = true);



