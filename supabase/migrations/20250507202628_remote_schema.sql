drop policy "Enable users to view their own data only" on "public"."user_roles";

create policy "Enable users to view their own data only"
on "public"."user_roles"
as permissive
for select
to authenticated
using (((( SELECT auth.uid() AS uid) = user_id) OR authorizeforclassgrader((class_id)::bigint)));

create policy "Instructors can view groups"
on "public"."assignment_groups"
as permissive
for select
to authenticated
using( authorizeforclassinstructor(class_id));

create policy "Instructors can create groups"
on "public"."assignment_groups"
as permissive
for insert
to authenticated
with check (authorizeforclassinstructor(class_id));

create policy "Instructors can view group members"
on "public"."assignment_groups_members"
as permissive
for select
to authenticated
using( authorizeforclassinstructor(class_id));

create policy "Instructors can create group members"
on "public"."assignment_groups_members"
as permissive
for insert
to authenticated
with check (authorizeforclassinstructor(class_id));