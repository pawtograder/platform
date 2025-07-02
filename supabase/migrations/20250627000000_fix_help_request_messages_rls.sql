-- Fix help_request_messages RLS policy to align with help_requests visibility
-- Students should be able to see messages in public help requests, not just their own messages

-- Drop the old restrictive policy
drop policy "instructors and graders view all, students view own" on "public"."help_request_messages";

-- Create new policy that aligns with help_requests visibility model
create policy "Users can view messages in help requests they can access"
on "public"."help_request_messages"
as permissive
for select
to authenticated
using (
  -- Can see messages if they can see the help request
  EXISTS (
    SELECT 1 FROM help_requests hr 
    WHERE hr.id = help_request_messages.help_request_id
    AND (
      -- Public requests in their class
      ((NOT hr.is_private) AND authorizeforclass(hr.class_id))
      -- Private requests they created or are assigned to  
      OR (hr.is_private AND ((auth.uid() = hr.creator) OR (auth.uid() = hr.assignee)))
      -- Instructors/graders can see all
      OR authorizeforclassgrader(hr.class_id)
    )
  )
); 