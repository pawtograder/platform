create policy "Instructors can update student profiles in their class"
on "public"."profiles"
as permissive
for update
to authenticated
using (authorizeforclassinstructor(class_id))
with check (authorizeforclassinstructor(class_id));



