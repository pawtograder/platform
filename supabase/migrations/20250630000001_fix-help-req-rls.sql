drop policy "Users can view private help requests they created or are assign" on "public"."help_requests";

create policy "Users can view private help requests they created or are assign"
on "public"."help_requests"
as permissive
for select
to authenticated
using ((((NOT is_private) AND authorizeforclass(class_id)) OR (is_private AND (authorizeforprofile(creator) OR (( SELECT auth.uid() AS uid) = assignee))) OR authorizeforclassgrader(class_id)));

-- Fix: Allow students to update status of their own requests even when resolved_by is set
-- This prevents database inconsistencies where resolved_by is set but status isn't updated
drop policy if exists "students can set resolved" on "public"."help_requests";

create policy "students can update their own requests"
on "public"."help_requests"
as permissive
for update
to authenticated
using (authorizeforprofile(creator))
with check (
  -- Students can only update their own requests
  authorizeforprofile(creator)
  -- Note: We rely on application logic to prevent students from setting resolved_by
  -- Database triggers can be added separately if needed for additional enforcement
);



