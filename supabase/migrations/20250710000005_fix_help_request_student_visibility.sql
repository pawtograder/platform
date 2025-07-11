-- Migration: Fix help request student visibility
-- Purpose:
-- 1. Update `is_user_in_help_request` to be class-specific to avoid cross-class data leakage.
-- 2. Update the RLS policy on `help_request_students` to allow students to see members
--    of any public help request, not just their own. This is needed for the office
--    hours queue overview page.

-- 1. Update the helper function to be class-specific.
create or replace function public.is_user_in_help_request(p_help_request_id bigint)
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
      where ur.user_id = auth.uid()
      and ur.class_id = (select class_id from public.help_requests where id = p_help_request_id)
    )
  );
$$;

-- 2. Drop the old, overly restrictive SELECT policy.
drop policy "Students can view members of their help requests" on "public"."help_request_students";

-- 3. Create the new policy that allows viewing members of public requests.
create policy "Students can view members of their help requests"
on "public"."help_request_students"
as permissive
for select
to authenticated
using (
    -- User is part of the request (works for private and public requests)
    public.is_user_in_help_request(help_request_id)
    OR
    -- Request is public, so any class member can see the students.
    (
        authorizeforclass(class_id) AND
        EXISTS (
            SELECT 1 FROM public.help_requests hr
            WHERE hr.id = help_request_students.help_request_id AND hr.is_private = false
        )
    )
); 