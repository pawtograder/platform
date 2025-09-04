-- Update RLS policies for submission comment tables
-- INSTRUCTORS: can edit all comments
-- GRADERS: only allow update if author matches (authorizeforprofile(author))
-- STUDENTS: can edit their own comments IF the review is not completed

-- Drop existing update policies for all three submission comment tables
drop policy if exists "Only graders and instructors can update" on "public"."submission_comments";
drop policy if exists "Only graders and instructors can update" on "public"."submission_artifact_comments";
drop policy if exists "Update self only" on "public"."submission_file_comments";


-- Create new update policies that allow:
-- 1. Instructors to update any comment in their class
-- 2. Graders to only update comments they authored
-- 3. Students to update their own comments IF the associated review is not completed

create policy "Instructors can update all, graders and students only own comments with restrictions"
on "public"."submission_comments"
as permissive
for update
to public
using (
  authorizeforclassinstructor(class_id) OR 
  (authorizeforclassgrader(class_id) AND authorizeforprofile(author)) OR
  (authorizeforclass(class_id) AND authorizeforprofile(author) AND 
   EXISTS (
     SELECT 1 FROM submission_reviews sr 
     WHERE sr.id = submission_review_id 
     AND sr.completed_at IS NULL
   ))
)
with check (
  authorizeforclassinstructor(class_id) OR 
  (authorizeforclassgrader(class_id) AND authorizeforprofile(author)) OR
  (authorizeforclass(class_id) AND authorizeforprofile(author) AND 
   EXISTS (
     SELECT 1 FROM submission_reviews sr 
     WHERE sr.id = submission_review_id 
     AND sr.completed_at IS NULL
   ))
);

create policy "Instructors can update all, graders and students only own comments with restrictions"
on "public"."submission_artifact_comments"
as permissive
for update
to public
using (
  authorizeforclassinstructor(class_id) OR 
  (authorizeforclassgrader(class_id) AND authorizeforprofile(author)) OR
  (authorizeforclass(class_id) AND authorizeforprofile(author) AND 
   EXISTS (
     SELECT 1 FROM submission_reviews sr 
     WHERE sr.id = submission_review_id 
     AND sr.completed_at IS NULL
   ))
)
with check (
  authorizeforclassinstructor(class_id) OR 
  (authorizeforclassgrader(class_id) AND authorizeforprofile(author)) OR
  (authorizeforclass(class_id) AND authorizeforprofile(author) AND 
   EXISTS (
     SELECT 1 FROM submission_reviews sr 
     WHERE sr.id = submission_review_id 
     AND sr.completed_at IS NULL
   ))
);

create policy "Instructors can update all, graders and students only own comments with restrictions"
on "public"."submission_file_comments"
as permissive
for update
to public
using (
  authorizeforclassinstructor(class_id) OR 
  (authorizeforclassgrader(class_id) AND authorizeforprofile(author)) OR
  (authorizeforclass(class_id) AND authorizeforprofile(author) AND 
   EXISTS (
     SELECT 1 FROM submission_reviews sr 
     WHERE sr.id = submission_review_id 
     AND sr.completed_at IS NULL
   ))
)
with check (
  authorizeforclassinstructor(class_id) OR 
  (authorizeforclassgrader(class_id) AND authorizeforprofile(author)) OR
  (authorizeforclass(class_id) AND authorizeforprofile(author) AND 
   EXISTS (
     SELECT 1 FROM submission_reviews sr 
     WHERE sr.id = submission_review_id 
     AND sr.completed_at IS NULL
   ))
);