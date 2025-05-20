drop policy "Enable users to view their own data only" on "public"."user_roles";

create policy "Enable users to view their own data only"
on "public"."user_roles"
as permissive
for select
to authenticated
using (((( SELECT auth.uid() AS uid) = user_id) OR authorizeforclassgrader((class_id)::bigint)));



