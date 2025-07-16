-- Migration: Fix help_request_students RLS policy for group help requests
-- Purpose: Allow students to add other students to help requests when they are also
--          part of that help request, enabling group help request creation while
--          maintaining security for existing requests.

drop policy if exists "Students can add themselves to help requests" on "public"."help_request_students";

-- Create a new INSERT policy that allows students to add other students
-- during initial help request creation or when they're already part of the request
create policy "Students can add students to help requests they're part of"
on "public"."help_request_students"
as permissive
for insert
to authenticated
with check (
  -- Staff can add anyone to requests in their class
  authorizeforclassgrader(class_id)
  OR
  -- Students can add themselves to requests in their class
  (authorizeforprofile(profile_id) and authorizeforclass(class_id))
  OR
  -- Students can add other students to help requests in two scenarios:
  -- 1. During initial creation (help request created within last 2 minutes)
  -- 2. When they are already associated with that help request
  (
    authorizeforclass(class_id) 
    AND 
    (
      -- Scenario 1: Help request was just created (initial setup)
      exists (
        select 1 
        from public.help_requests hr
        where hr.id = help_request_students.help_request_id
        and hr.created_at > (now() - interval '2 minutes')
        and hr.class_id = help_request_students.class_id
      )
      OR
      -- Scenario 2: Current user is already associated with this help request
      exists (
        select 1 
        from public.help_request_students existing_association
        join public.user_roles ur on ur.private_profile_id = existing_association.profile_id
        where existing_association.help_request_id = help_request_students.help_request_id
        and ur.user_id = auth.uid()
        and ur.class_id = help_request_students.class_id
      )
    )
  )
);

-- Also update the DELETE policy to allow students to remove other students 
-- from help requests when they are part of that help request
drop policy if exists "Students can remove themselves from help requests" on "public"."help_request_students";

create policy "Students can remove students from help requests they're part of"
on "public"."help_request_students"
as permissive
for delete
to authenticated
using (
  -- Staff can remove anyone from requests in their class
  authorizeforclassgrader(class_id)
  OR
  -- Students can remove themselves from requests
  authorizeforprofile(profile_id)
  OR
  -- Students can remove other students from help requests if they themselves are associated with that request
  (
    authorizeforclass(class_id)
    AND
    exists (
      select 1 
      from public.help_request_students existing_association
      join public.user_roles ur on ur.private_profile_id = existing_association.profile_id
      where existing_association.help_request_id = help_request_students.help_request_id
      and ur.user_id = auth.uid()
      and ur.class_id = help_request_students.class_id
    )
  )
);

comment on policy "Students can add students to help requests they're part of" on "public"."help_request_students" is 
'Allows students to add other students to help requests during initial creation or when they are already associated with that help request. This enables group help request creation while preventing unauthorized modifications.';

comment on policy "Students can remove students from help requests they're part of" on "public"."help_request_students" is 
'Allows students to remove other students from help requests when they themselves are associated with that help request. This enables proper editing of group help requests while maintaining security.'; 