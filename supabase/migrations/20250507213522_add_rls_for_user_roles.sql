create policy "Instructors can add any user role in their class"
on "public"."user_roles"
as permissive
for insert
to authenticated
with check (authorizeforclassinstructor((class_id)::bigint));


create policy "Instructors can remove user roles in their class"
on "public"."user_roles"
as permissive
for delete
to authenticated
using ((authorizeforclassinstructor((class_id)::bigint) AND ((role <> 'instructor'::app_role) OR (user_id = auth.uid()))));


create policy "Instructors can update user roles in their class"
on "public"."user_roles"
as permissive
for update
to authenticated
using ((authorizeforclassinstructor((class_id)::bigint) AND ((role <> 'instructor'::app_role) OR (user_id = auth.uid()))))
with check (authorizeforclassinstructor((class_id)::bigint));



