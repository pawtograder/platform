drop policy "graders and instructors can view class tags" on "public"."tags";

drop policy "graders and instructors can delete class tags" on "public"."tags";

drop policy "graders and instructors can insert to class tags" on "public"."tags";

drop policy "graders and instructors can update class tags" on "public"."tags";

-- Added authenticated to all policies

create policy "Everyone in the class can view class tags"
on "public"."tags"
as permissive
for select
to authenticated
using ((authorizeforclass(class_id) AND (visible OR (auth.uid() = creator_id))));


create policy "graders and instructors can delete class tags"
on "public"."tags"
as permissive
for delete
to authenticated
using (((authorizeforclassgrader(class_id) OR authorizeforclassinstructor(class_id)) AND (visible OR (auth.uid() = creator_id))));


create policy "graders and instructors can insert to class tags"
on "public"."tags"
as permissive
for insert
to authenticated
with check (((authorizeforclassgrader(class_id) OR authorizeforclassinstructor(class_id)) AND (visible OR (auth.uid() = creator_id))));


create policy "graders and instructors can update class tags"
on "public"."tags"
as permissive
for update
to authenticated
using (((authorizeforclassgrader(class_id) OR authorizeforclassinstructor(class_id)) AND (visible OR (auth.uid() = creator_id))));



