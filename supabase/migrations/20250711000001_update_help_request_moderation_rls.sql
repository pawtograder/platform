-- add delete rls policy for help_request_moderation that only allows instructors to delete
-- modify the select rls policy to allow students to view their own moderation records

-- drop the existing select policy so we can recreate it with the updated logic
drop policy "Graders can view moderation records" on "public"."help_request_moderation";

-- create updated select policy that properly maps auth.uid() to profile_id
-- this allows:
-- 1. graders to view all moderation records in their class (authorizeforclassgrader)
-- 2. students to view their own moderation records by mapping auth.uid() -> user_roles -> private_profile_id
create policy "Graders can view moderation records and students can view their own"
on "public"."help_request_moderation"
as permissive
for select
to authenticated
using (
  authorizeforclassgrader(class_id) 
  OR 
  student_profile_id in (
    select private_profile_id 
    from user_roles 
    where user_id = auth.uid()
  )
); 

-- create delete policy that only allows instructors to delete moderation records
create policy "Instructors can delete moderation records"
on "public"."help_request_moderation"
as permissive
for delete
to authenticated
using (authorizeforclassinstructor(class_id)); 