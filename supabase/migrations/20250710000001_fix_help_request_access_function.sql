-- Migration: Fix help request access function for group support
-- Purpose: Update the can_access_help_request function to work with the new
--          help_request_students many-to-many relationship instead of the removed creator column
-- Affected: public.can_access_help_request function
-- Dependencies: Requires help_request_students table from hr-groups migration

-- Update the help request access function to work with the new many-to-many relationship
create or replace function public.can_access_help_request(help_request_id bigint)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  help_request_row record;
  user_is_student boolean := false;
begin
  -- Get the help request details (note: no more creator column)
  select 
    hr.is_private,
    hr.class_id,
    hr.assignee
  into help_request_row
  from public.help_requests hr
  where hr.id = help_request_id;
  
  -- If help request doesn't exist, deny access
  if not found then
    return false;
  end if;
  
  -- Check if current user is a student in this help request
  select exists(
    select 1 
    from public.help_request_students hrs 
    where hrs.help_request_id = can_access_help_request.help_request_id 
      and hrs.profile_id in (
        select private_profile_id 
        from public.user_roles 
        where user_id = (select auth.uid())
      )
  ) into user_is_student;
  
  -- Check access conditions:
  -- 1. Public help requests: user must be authorized for the class
  -- 2. Private help requests: user must be a student in the request, assignee, or class grader
  -- 3. Class graders can always access help requests in their class
  return (
    -- Public help requests in user's class
    ((not help_request_row.is_private) and public.authorizeforclass(help_request_row.class_id))
    -- Private help requests where user is a student in the request or assignee
    or (help_request_row.is_private and (user_is_student or ((select auth.uid()) = help_request_row.assignee)))
    -- Class graders can access all help requests in their class
    or public.authorizeforclassgrader(help_request_row.class_id)
  );
end;
$$;

-- Update the function comment to reflect the new logic
comment on function public.can_access_help_request(bigint) is 
'Checks if the current user can access a help request based on privacy settings and user roles. Works with the many-to-many help_request_students relationship. Returns true if the user can access the help request, false otherwise.'; 