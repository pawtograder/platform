CREATE OR REPLACE FUNCTION "public"."authorizeforinstructororgraderofstudent"("_user_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.user_roles student_role
        INNER JOIN public.user_roles staff_role ON staff_role.class_id = student_role.class_id
        WHERE student_role.user_id = _user_id
          AND staff_role.user_id = auth.uid()
          AND staff_role.role IN ('instructor', 'grader')
          AND staff_role.disabled = false
    );
$$;

drop policy "students view all non-private in their class, instructors and g" on "public"."discussion_threads";
drop function public.authorize_for_private_discussion_thread(root bigint);

CREATE OR REPLACE FUNCTION public.authorize_for_private_discussion_thread(p_root bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  bind_permissions int;
  jwtRoles public.user_roles;
begin
  -- check for direct ownership of assignment
    select count(*)
    into bind_permissions
    from public.discussion_threads as t
    inner join public.user_roles as r on (r.private_profile_id=t.author or r.public_profile_id=t.author)
    where r.user_id=auth.uid() and t.root is not null and t.root = p_root;

    if bind_permissions > 0 then
      return true;
    end if;

  return false;
end;
$function$
;

create policy "students view all non-private in their class, instructors and g"
on "public"."discussion_threads"
as permissive
for select
to public
using (((authorizeforclass(class_id) AND (instructors_only = false)) OR authorizeforclassgrader(class_id) OR authorizeforprofile(author) OR (instructors_only AND authorize_for_private_discussion_thread(root))));

-- Add pinned column to discussion_threads
ALTER TABLE "public"."discussion_threads" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;

-- Create policy to allow instructors and graders to update pinned status
create policy "instructors and graders can update pinned status"
on "public"."discussion_threads"
as permissive
for update
to public
using (authorizeforclassgrader(class_id))
with check (authorizeforclassgrader(class_id));

-- Update RLS policies: Change from "Graders instructors update all, students update only before com"
-- to "Only instructors update all, graders have same rules as students"

-- submission_artifact_comments
DROP POLICY "Graders instructors update all, students update only before com" ON "public"."submission_artifact_comments";
CREATE POLICY "Instructors update all, graders and students update only before com" ON "public"."submission_artifact_comments" FOR UPDATE USING (("public"."authorizeforclassinstructor"("class_id") OR ("public"."authorizeforprofile"("author") AND "public"."authorize_for_submission_review_writable"("submission_review_id"))));

-- submission_comments  
DROP POLICY "Graders instructors update all, students update only before com" ON "public"."submission_comments";
CREATE POLICY "Instructors update all, graders and students update only before com" ON "public"."submission_comments" FOR UPDATE USING (("public"."authorizeforclassinstructor"("class_id") OR ("public"."authorizeforprofile"("author") AND "public"."authorize_for_submission_review_writable"("submission_review_id"))));

-- submission_file_comments
DROP POLICY "Graders instructors update all, students update only before com" ON "public"."submission_file_comments"; 
CREATE POLICY "Instructors update all, graders and students update only before com" ON "public"."submission_file_comments" FOR UPDATE USING (("public"."authorizeforclassinstructor"("class_id") OR ("public"."authorizeforprofile"("author") AND "public"."authorize_for_submission_review_writable"("submission_review_id"))));


