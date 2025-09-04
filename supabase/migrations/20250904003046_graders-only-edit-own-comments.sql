-- Update RLS policies for submission comment tables
-- GRADERS: only allow update if author matches (authorizeforprofile(author))
-- INSTRUCTORS: can still edit all comments

-- Drop existing update policies for all three submission comment tables
drop policy if exists "Only graders and instructors can update" on "public"."submission_comments";
drop policy if exists "Only graders and instructors can update" on "public"."submission_artifact_comments";
drop policy if exists "Update self only" on "public"."submission_file_comments";


-- Create new update policies that allow:
-- 1. Instructors to update any comment in their class
-- 2. Graders to only update comments they authored

create policy "Instructors can update all, graders only own comments"
on "public"."submission_comments"
as permissive
for update
to public
using (authorizeforclassinstructor(class_id) OR (authorizeforclassgrader(class_id) AND authorizeforprofile(author)))
with check (authorizeforclassinstructor(class_id) OR (authorizeforclassgrader(class_id) AND authorizeforprofile(author)));

create policy "Instructors can update all, graders only own comments"
on "public"."submission_artifact_comments"
as permissive
for update
to public
using (authorizeforclassinstructor(class_id) OR (authorizeforclassgrader(class_id) AND authorizeforprofile(author)))
with check (authorizeforclassinstructor(class_id) OR (authorizeforclassgrader(class_id) AND authorizeforprofile(author)));

create policy "Instructors can update all, graders only own comments"
on "public"."submission_file_comments"
as permissive
for update
to public
using (authorizeforclassinstructor(class_id) OR (authorizeforclassgrader(class_id) AND authorizeforprofile(author)))
with check (authorizeforclassinstructor(class_id) OR (authorizeforclassgrader(class_id) AND authorizeforprofile(author)));