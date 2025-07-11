-- Migration: Update can_access_help_request function for new help request model
-- Purpose: Update the function to work with help_request_students many-to-many relationship
-- and avoid RLS recursion issues

-- Drop policies that depend on the function first
drop policy if exists "Users can view messages in help requests they can access" on "public"."help_request_messages";
drop policy if exists "Users can create read receipts for accessible help requests" on "public"."help_request_message_read_receipts";
drop policy if exists "Users can view read receipts for accessible help requests" on "public"."help_request_message_read_receipts";

-- Drop and recreate the function with updated logic
drop function if exists public.can_access_help_request(bigint);

create or replace function public.can_access_help_request(help_request_id bigint)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select
    case 
      when hr.is_private = false then
        -- Public help requests: user must be authorized for the class
        public.authorizeforclass(hr.class_id)
      when hr.is_private = true then
        -- Private help requests: user must be assignee, class grader, or student member
        (auth.uid() = hr.assignee) 
        or public.authorizeforclassgrader(hr.class_id)
        or public.user_is_in_help_request(hr.id)
      else
        -- Default deny
        false
    end
  from public.help_requests hr
  where hr.id = help_request_id;
$$;

comment on function public.can_access_help_request(bigint) is 
'SECURITY DEFINER function to check if current user can access a help request. Uses the updated help_request_students relationship and avoids RLS recursion.';

-- Recreate the policies that depend on this function
create policy "Users can view messages in help requests they can access"
on "public"."help_request_messages"
as permissive
for select
to authenticated
using (public.can_access_help_request(help_request_id));

create policy "Users can create read receipts for accessible help requests"
on "public"."help_request_message_read_receipts"
as permissive
for insert
to authenticated
with check (
  public.can_access_help_request(
    (select help_request_id from public.help_request_messages where id = message_id)
  )
);

create policy "Users can view read receipts for accessible help requests"
on "public"."help_request_message_read_receipts"
as permissive
for select
to authenticated
using (
  public.can_access_help_request(
    (select help_request_id from public.help_request_messages where id = message_id)
  )
); 