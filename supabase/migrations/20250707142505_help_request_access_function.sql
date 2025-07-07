-- Create reusable function to check if user can access a help request
-- This consolidates the access logic used across multiple RLS policies

create or replace function public.can_access_help_request(help_request_id bigint)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  help_request_row record;
begin
  -- Get the help request details
  select 
    hr.is_private,
    hr.class_id,
    hr.creator,
    hr.assignee
  into help_request_row
  from public.help_requests hr
  where hr.id = help_request_id;
  
  -- If help request doesn't exist, deny access
  if not found then
    return false;
  end if;
  
  -- Check access conditions:
  -- 1. Public help requests: user must be authorized for the class
  -- 2. Private help requests: user must be creator, assignee, or class grader
  -- 3. Class graders can always access help requests in their class
  return (
    -- Public help requests in user's class
    ((not help_request_row.is_private) and public.authorizeforclass(help_request_row.class_id))
    -- Private help requests where user is creator or assignee
    or (help_request_row.is_private and ((auth.uid() = help_request_row.creator) or (auth.uid() = help_request_row.assignee)))
    -- Class graders can access all help requests in their class
    or public.authorizeforclassgrader(help_request_row.class_id)
  );
end;
$$;

-- Update the existing help_request_messages RLS policy to use the new function
drop policy if exists "Users can view messages in help requests they can access" on "public"."help_request_messages";

create policy "Users can view messages in help requests they can access"
on "public"."help_request_messages"
as permissive
for select
to authenticated
using (public.can_access_help_request(help_request_id));

-- Update the help_request_message_read_receipts policies to use the same logic
drop policy if exists "Users can create read receipts" on "public"."help_request_message_read_receipts";
drop policy if exists "Users can view read receipts" on "public"."help_request_message_read_receipts";

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

comment on function public.can_access_help_request(bigint) is 
'Checks if the current user can access a help request based on privacy settings and user roles. Returns true if the user can access the help request, false otherwise.'; 