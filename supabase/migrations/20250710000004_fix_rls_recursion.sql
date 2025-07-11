-- Migration: Fix RLS recursion on help_request_students
-- Purpose: Replace the recursive SELECT policy on help_request_students with a
--          non-recursive version using a SECURITY DEFINER function.

-- 1. Create a SECURITY DEFINER function to check for help request membership.
--    This function can query help_request_students without triggering the RLS policy,
--    thus breaking the infinite recursion.
create or replace function public.is_user_in_help_request(p_help_request_id bigint)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.help_request_students
    where help_request_id = p_help_request_id
    and profile_id in (
      select private_profile_id from public.user_roles where user_id = auth.uid()
    )
  );
$$;

-- 2. Drop the old, infinite recursive policy.
drop policy "Students can view members of their help requests" on "public"."help_request_students";

-- 3. Create the new, non-recursive policy using the helper function.
--    This policy allows a user to see all members of a help request if they
--    are also a member of that request.
create policy "Students can view members of their help requests"
on "public"."help_request_students"
as permissive
for select
to authenticated
using (public.is_user_in_help_request(help_request_id));
