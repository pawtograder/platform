drop policy if exists "Instructors can view groups" on "public"."assignment_groups";

drop policy if exists "Instructors can create groups" on "public"."assignment_groups";

drop policy if exists "Instructors can view group members" on "public"."assignment_groups_members";

drop policy if exists "Instructors can create group members" on "public"."assignment_groups_members";

drop policy if exists "Allow all to view name_generation_words" on "public"."name_generation_words"; 

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

create policy "Allow all to view name_generation_words"
on "public"."name_generation_words"
as permissive
for select
to authenticated
using (true);