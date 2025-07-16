-- Migration: Comprehensive fix for help request RLS policies
-- Purpose: Fix infinite recursion issues and ensure proper visibility of help requests
-- - Public help requests visible to all class members
-- - Private help requests only visible to staff and associated students
-- - help_request_students visibility aligned with help_request visibility
-- - No recursive policy dependencies

-- Drop existing problematic policies
drop policy if exists "Users can view private help requests they created or are assign" on "public"."help_requests";
drop policy if exists "Students can view members of their help requests" on "public"."help_request_students";
drop policy if exists "Insert for own class" on "public"."help_requests";
drop policy if exists "Students can update their own requests" on "public"."help_requests";
drop policy if exists "Instructors and Graders have full access" on "public"."help_request_students";
drop policy if exists "Students can add themselves to a help request" on "public"."help_request_students";
drop policy if exists "Students can remove themselves from a help request" on "public"."help_request_students";

-- Drop the problematic function if it exists
drop function if exists public.is_user_in_help_request(bigint);

-- Create SECURITY DEFINER function to check if user is associated with a help request
-- This breaks recursion by using SECURITY DEFINER to bypass RLS
create or replace function public.user_is_in_help_request(p_help_request_id bigint, p_user_id uuid default auth.uid())
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.help_request_students hrs
    where hrs.help_request_id = p_help_request_id
    and hrs.profile_id in (
      select ur.private_profile_id 
      from public.user_roles ur 
      where ur.user_id = p_user_id
    )
  );
$$;

-- Create SECURITY DEFINER function to check if a help request is private
create or replace function public.help_request_is_private(p_help_request_id bigint)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select hr.is_private
  from public.help_requests hr
  where hr.id = p_help_request_id;
$$;

-- Create comprehensive help_requests SELECT policy
create policy "Students can view help requests in their class"
on "public"."help_requests"
as permissive
for select
to authenticated
using (
  -- Always allow staff to see all requests in their class
  authorizeforclassgrader(class_id)
  OR
  -- Allow students in the same class to see public requests
  (not is_private and authorizeforclass(class_id))
  OR
  -- Allow assigned staff to see private requests
  (is_private and auth.uid() = assignee)
  OR
  -- Allow students to see private requests they're part of (using SECURITY DEFINER function)
  (is_private and public.user_is_in_help_request(id))
);

-- Create help_requests INSERT policy
create policy "Students can create help requests in their class"
on "public"."help_requests"
as permissive
for insert
to authenticated
with check (
  authorizeforclass(class_id) and assignee is null
);

-- Create help_requests UPDATE policy for students
create policy "Students can update their own help requests"
on "public"."help_requests"
as permissive
for update
to authenticated
using (
  -- Staff can update any request in their class
  authorizeforclassgrader(class_id)
  OR
  -- Students can update requests they're part of (using SECURITY DEFINER function)
  public.user_is_in_help_request(id)
)
with check (
  -- Staff can update any request in their class
  authorizeforclassgrader(class_id)
  OR
  -- Students can update requests they're part of (using SECURITY DEFINER function)
  public.user_is_in_help_request(id)
);

-- Create help_requests DELETE policy (staff only)
create policy "Staff can delete help requests in their class"
on "public"."help_requests"
as permissive
for delete
to authenticated
using (authorizeforclassgrader(class_id));

-- Create help_request_students SELECT policy
create policy "Students can view help request members"
on "public"."help_request_students"
as permissive
for select
to authenticated
using (
  -- Staff can see all members in their class
  authorizeforclassgrader(class_id)
  OR
  -- Students can see members of public requests in their class
  (not public.help_request_is_private(help_request_id) and authorizeforclass(class_id))
  OR
  -- Students can see members of private requests they're part of
  (public.help_request_is_private(help_request_id) and public.user_is_in_help_request(help_request_id))
);

-- Create help_request_students INSERT policy  
create policy "Students can add themselves to help requests"
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
);

-- Create help_request_students UPDATE policy (staff only)
create policy "Staff can update help request memberships"
on "public"."help_request_students"
as permissive
for update
to authenticated
using (authorizeforclassgrader(class_id))
with check (authorizeforclassgrader(class_id));

-- Create help_request_students DELETE policy
create policy "Students can remove themselves from help requests"
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
);

comment on function public.user_is_in_help_request(bigint, uuid) is 
'SECURITY DEFINER function to check if a user is associated with a help request. Breaks RLS recursion by bypassing policies when checking help_request_students table.';

comment on function public.help_request_is_private(bigint) is 
'SECURITY DEFINER function to check if a help request is private. Breaks RLS recursion by bypassing policies when checking help_requests table.'; 