-- Migration to optimize RLS performance by replacing auth.uid() with (select auth.uid())
-- This prevents auth.uid() from being executed on every row in RLS policies and functions

-- =============================================================================
-- Update authorize functions to use (select auth.uid()) for better performance
-- =============================================================================

-- Update authorize_for_discussion_thread function
CREATE OR REPLACE FUNCTION public.authorize_for_discussion_thread(discussion_thread_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
  declare
    bind_permissions INTEGER := 0;
  begin
    select count(*) into bind_permissions
    from public.discussion_threads as t
    inner join public.user_roles as r on (r.private_profile_id=t.author or r.public_profile_id=t.author)
    where r.user_id=(select auth.uid());

    if bind_permissions > 0 then
      return true;
    end if;

    return public.authorizeforclass((select class_id from public.discussion_threads where id=discussion_thread_id));
  end;
$function$;

-- Update authorize_for_submission function
CREATE OR REPLACE FUNCTION public.authorize_for_submission(submission_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
  declare
    bind_permissions INTEGER := 0;
  begin
    -- Check if user owns the submission
    select count(*) into bind_permissions
    from public.submissions as s
    inner join public.user_roles as r on r.private_profile_id=s.profile_id
    where r.user_id=(select auth.uid());

    if bind_permissions > 0 then
      return true;
    end if;

    -- Check if user is in the group for group submissions
    select count(*) into bind_permissions
    from public.submissions as s
    inner join public.assignment_groups_members mem on mem.assignment_group_id=s.assignment_group_id
    inner join public.user_roles as r on r.private_profile_id=mem.profile_id
    where r.user_id=(select auth.uid());
    if bind_permissions > 0 then
      return true;
    end if;

    return false;
  end;
$function$;

-- Update authorize_for_submission_review function
CREATE OR REPLACE FUNCTION public.authorize_for_submission_review(submission_review_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
    begin
        return (
            exists(
                select 1 from submission_reviews sr
                left join review_assignments ra
                on ra.submission_review_id = sr.id
            left join user_roles ur on ur.private_profile_id = ra.assignee_profile_id and ur.class_id=sr.class_id
            where sr.id=authorize_for_submission_review.submission_review_id and ((sr.released and authorize_for_submission(sr.submission_id)) or ur.user_id = (select auth.uid()))
        )
    );
    end;
$function$;

-- Update authorize_for_submission_review_writable function
CREATE OR REPLACE FUNCTION public.authorize_for_submission_review_writable(submission_review_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
    begin
        return (
            exists(
                select 1 from submission_reviews sr
                left join review_assignments ra
                on ra.submission_review_id = sr.id
            left join user_roles ur on ur.private_profile_id = ra.assignee_profile_id and ur.class_id=sr.class_id
            where sr.id=authorize_for_submission_review_writable.submission_review_id and sr.completed_at is null and ur.user_id = (select auth.uid())
        )
    );
    end;
$function$;

-- Update authorize_for_submission_reviewable function
CREATE OR REPLACE FUNCTION public.authorize_for_submission_reviewable(requested_submission_id bigint, requested_submission_review_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  bind_permissions int;
  jwtRoles public.user_roles;
begin
  if requested_submission_review_id is null then
  -- check for direct ownership of assignment
    select count(*)
    into bind_permissions
    from public.submissions as s
    inner join public.user_roles as r on r.private_profile_id=s.profile_id
    where r.user_id=(select auth.uid());
    if bind_permissions > 0 then
      return true;
    end if;

  -- check through assignment groups
    select count(*)
    into bind_permissions
    from public.submissions as s
    inner join public.assignment_groups_members mem on mem.assignment_group_id=s.assignment_group_id
    inner join public.user_roles as r on r.private_profile_id=mem.profile_id
    where r.user_id=(select auth.uid());
    if bind_permissions > 0 then
      return true;
    end if;
  else 
    -- check for direct ownership of assignment
    select count(*)
    into bind_permissions
    from public.submission_reviews as review
    inner join public.submissions as s on s.id=r.submission_id
    inner join public.user_roles as r on r.private_profile_id=s.profile_id
    where r.user_id=(select auth.uid()) and review.id=requested_submission_review_id and review.released;
    if bind_permissions > 0 then
      return true;
    end if;

  -- check through assignment groups
    select count(*)
    into bind_permissions
    from public.submission_reviews as review
    inner join public.submissions as s on s.id=r.submission_id
    inner join public.assignment_groups_members mem on mem.assignment_group_id=s.assignment_group_id
    inner join public.user_roles as r on r.private_profile_id=mem.profile_id
    where r.user_id=(select auth.uid()) and review.id=requested_submission_review_id  and review.released;
    if bind_permissions > 0 then
      return true;
    end if;
  end if;

  return false;
end;
$function$;

-- Update authorize_to_create_own_due_date_extension function
CREATE OR REPLACE FUNCTION public.authorize_to_create_own_due_date_extension(_student_id uuid, _assignment_group_id bigint, _assignment_id bigint, _class_id bigint, _creator_id uuid, _hours_to_extend integer, _tokens_consumed integer)
 RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  tokens_used_this_assignment int;
  tokens_used_all_assignments int;
  tokens_remaining int;
  tokens_needed int;
  max_tokens_for_assignment int;
  private_profile_id uuid;
  existing_negative_exception boolean;
begin

  -- Validate that the declared number of tokens consumed is correct
  tokens_needed := ceil(_hours_to_extend/24);
  if tokens_needed != _tokens_consumed then
    return false;
  end if;

  select public.user_roles.private_profile_id from public.user_roles where user_id = (select auth.uid()) and class_id = _class_id into private_profile_id;
  -- Make sure student is in the class and the creator of the extension
  if private_profile_id is null or private_profile_id != _creator_id then
    return false;
  end if;

  -- Check if there's already a negative exception for this student/assignment_group + assignment + class
  -- Prevent ANY additional exception in that case
    select exists (
      select 1 from public.assignment_due_date_exceptions adde
      where (
        (_student_id is not null and adde.student_id is not null and _student_id = adde.student_id) or
        (_assignment_group_id is not null and adde.assignment_group_id is not null and _assignment_group_id = adde.assignment_group_id)
      )
      and adde.assignment_id = _assignment_id 
      and adde.class_id = _class_id 
      and adde.hours < 0
    ) into existing_negative_exception;
    
    if existing_negative_exception then
      return false;
    end if;

  select late_tokens_per_student from public.classes where id = _class_id into tokens_remaining;

  -- Make sure that the student is in the assignment group or matches the student_id
  if _assignment_group_id is not null then
    if not exists (select 1 from public.assignment_groups_members where assignment_group_id = _assignment_group_id and profile_id = private_profile_id) then
      return false;
    end if;
    select coalesce(sum(tokens_consumed), 0) from public.assignment_due_date_exceptions where assignment_group_id = _assignment_group_id and assignment_id = _assignment_id into tokens_used_this_assignment;
  else
    if private_profile_id != _student_id then
      return false;
    end if;
      select coalesce(sum(tokens_consumed), 0) from public.assignment_due_date_exceptions where student_id = _student_id and assignment_id = _assignment_id into tokens_used_this_assignment;
  end if;

  -- Calculate total tokens used across all assignments for this student
  -- Join with assignment_groups_members to get all assignment groups the student is in
  select coalesce(sum(adde.tokens_consumed), 0) 
  from public.assignment_due_date_exceptions adde
  left join public.assignment_groups_members agm on agm.assignment_group_id = adde.assignment_group_id
  where adde.student_id = _student_id 
     or agm.profile_id = private_profile_id
  into tokens_used_all_assignments;

  if tokens_used_all_assignments > tokens_remaining then
    return false;
  end if;

  select max_late_tokens from public.assignments where id=_assignment_id into max_tokens_for_assignment;

  if tokens_used_this_assignment > max_tokens_for_assignment then
    return false;
  end if;

  return true;
end;
$function$;

-- Update authorizeforassignmentgroup function
CREATE OR REPLACE FUNCTION public.authorizeforassignmentgroup(_assignment_group_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$declare
  bind_permissions int;
begin
  select count(*) into bind_permissions
  from public.user_roles as r
  inner join public.assignment_groups_members m on m.profile_id=r.private_profile_id
  where m.assignment_group_id=_assignment_group_id and r.user_id=(select auth.uid());

  return bind_permissions > 0;
end;
$function$;

-- Update authorizeforclass function
CREATE OR REPLACE FUNCTION public.authorizeforclass(class__id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
  declare
    bind_permissions INTEGER := 0;
  begin
  select count(*) into bind_permissions
  from public.user_roles as r
  where class_id=class__id and user_id=(select auth.uid());

  return bind_permissions > 0;
  end;
$function$;

-- Update authorizeforclassgrader function
CREATE OR REPLACE FUNCTION public.authorizeforclassgrader(class__id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
  declare
    bind_permissions INTEGER := 0;
  begin
  select count(*) into bind_permissions
  from public.user_roles as r
  where class_id=class__id and user_id=(select auth.uid()) and (role='instructor' or role='grader');

  return bind_permissions > 0;
  end;
$function$;

-- Update authorizeforclassinstructor function
CREATE OR REPLACE FUNCTION public.authorizeforclassinstructor(class__id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
  declare
    bind_permissions INTEGER := 0;
  begin
  select count(*) into bind_permissions
  from public.user_roles as r
  where class_id=class__id and user_id=(select auth.uid()) and role='instructor';

  return bind_permissions > 0;
  end;
$function$;

-- Update authorizeforinstructororgraderofstudent function
CREATE OR REPLACE FUNCTION public.authorizeforinstructororgraderofstudent(_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
  declare
    bind_permissions INTEGER := 0;
  begin
  select count(*) into bind_permissions
  from public.user_roles as ourRole
  inner join public.user_roles as studentRole on ourRole.class_id=studentRole.class_id and studentRole.user_id=_user_id
  where ourRole.user_id=(select auth.uid()) and ourRole.role='instructor';

  return bind_permissions > 0;
  end;
$function$;

-- Update authorizeforinstructororgraderofstudentorgrader function
CREATE OR REPLACE FUNCTION public.authorizeforinstructororgraderofstudentorgrader(_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
  declare
    bind_permissions INTEGER := 0;
  begin
  select count(*) into bind_permissions
  from public.user_roles as ourRole
  inner join public.user_roles as studentRole on ourRole.class_id=studentRole.class_id and studentRole.user_id=_user_id
  where ourRole.user_id=(select auth.uid()) and (ourRole.role='instructor' or ourRole.role='grader');

  return bind_permissions > 0;
  end;
$function$;

-- Update authorize_for_poll function
CREATE OR REPLACE FUNCTION public.authorize_for_poll(poll_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
  declare
    poll record;
    roles record;
  begin
    -- Get poll information
    select * into poll from public.polls where id = poll_id;
    
    if not found then
      return false;
    end if;

    -- Get user's role in the class
    select 
      case when role = 'instructor' then true else false end as is_instructor
    into roles
    from 
      public.user_roles
    WHERE 
      user_id = (select auth.uid()) AND class_id = poll.class_id;

  if roles.is_instructor then
    return true;
  end if;

  -- If poll is not published, only instructors can see it
  if not poll.published then
    return false;
  end if;

  -- Check if user is enrolled in the class
  return public.authorizeforclass(poll.class_id);
  end;
$function$;

-- Update authorize_for_assignment_poll function
CREATE OR REPLACE FUNCTION public.authorize_for_assignment_poll(assignment_id bigint, class__id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
  declare
    is_instructor boolean := false;
  begin
    -- Get user's role in the class
    select 
      case when role = 'instructor' then true else false end
    into is_instructor
    from 
      user_roles
    WHERE 
      user_id = (select auth.uid()) AND class_id = class__id;

  if is_instructor then
    return true;
  end if;

  -- TODO: Add logic for students once polls are implemented
  -- For now, only instructors can access assignment polls
  
  return false;
  end;
$function$;

-- Update authorizeforprofile function
CREATE OR REPLACE FUNCTION public.authorizeforprofile(profile_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
  declare
    bind_permissions INTEGER := 0;
  begin
  select count(*) into bind_permissions
  from public.user_roles as r
  where (r.public_profile_id=profile_id OR r.private_profile_id=profile_id) and user_id=(select auth.uid());

  return bind_permissions > 0;
  end;
$function$;

-- =============================================================================
-- Update RLS policies to use (select auth.uid()) for better performance
-- =============================================================================

-- Update flashcard_decks policies
DROP POLICY IF EXISTS "Allow creator or instructor/grader to delete decks" ON "public"."flashcard_decks";
CREATE POLICY "Allow creator or instructor/grader to delete decks" ON "public"."flashcard_decks" FOR DELETE TO "authenticated" USING ((("creator_id" = (select "auth"."uid"())) OR "public"."authorizeforclassgrader"("class_id")));

DROP POLICY IF EXISTS "Allow creator or instructor/grader to update decks" ON "public"."flashcard_decks";
CREATE POLICY "Allow creator or instructor/grader to update decks" ON "public"."flashcard_decks" FOR UPDATE TO "authenticated" USING ((("creator_id" = (select "auth"."uid"())) OR "public"."authorizeforclassgrader"("class_id"))) WITH CHECK ((("creator_id" = (select "auth"."uid"())) OR "public"."authorizeforclassgrader"("class_id")));

DROP POLICY IF EXISTS "Allow instructors/graders to create decks" ON "public"."flashcard_decks";
CREATE POLICY "Allow instructors/graders to create decks" ON "public"."flashcard_decks" FOR INSERT TO "authenticated" WITH CHECK (("public"."authorizeforclassgrader"("class_id") AND ("creator_id" = (select "auth"."uid"()))));

-- Update flashcards policies
DROP POLICY IF EXISTS "Allow deck managers to create cards" ON "public"."flashcards";
CREATE POLICY "Allow deck managers to create cards" ON "public"."flashcards" FOR INSERT TO "authenticated" WITH CHECK ((("public"."authorizeforclassgrader"("class_id") OR (EXISTS ( SELECT 1
   FROM "public"."flashcard_decks" "fd"
  WHERE (("fd"."id" = "flashcards"."deck_id") AND ("fd"."creator_id" = (select "auth"."uid"())) AND ("fd"."class_id" = "flashcards"."class_id"))))) AND (EXISTS ( SELECT 1
   FROM "public"."flashcard_decks" "fd"
  WHERE (("fd"."id" = "flashcards"."deck_id") AND ("fd"."class_id" = "flashcards"."class_id"))))));

DROP POLICY IF EXISTS "Allow deck managers to delete cards" ON "public"."flashcards";
CREATE POLICY "Allow deck managers to delete cards" ON "public"."flashcards" FOR DELETE TO "authenticated" USING ((("public"."authorizeforclassgrader"("class_id") OR (EXISTS ( SELECT 1
   FROM "public"."flashcard_decks" "fd"
  WHERE (("fd"."id" = "flashcards"."deck_id") AND ("fd"."creator_id" = (select "auth"."uid"())) AND ("fd"."class_id" = "flashcards"."class_id"))))) AND (EXISTS ( SELECT 1
   FROM "public"."flashcard_decks" "fd"
  WHERE (("fd"."id" = "flashcards"."deck_id") AND ("fd"."class_id" = "flashcards"."class_id"))))));

DROP POLICY IF EXISTS "Allow deck managers to update cards" ON "public"."flashcards";
CREATE POLICY "Allow deck managers to update cards" ON "public"."flashcards" FOR UPDATE TO "authenticated" USING ((("public"."authorizeforclassgrader"("class_id") OR (EXISTS ( SELECT 1
   FROM "public"."flashcard_decks" "fd"
  WHERE (("fd"."id" = "flashcards"."deck_id") AND ("fd"."creator_id" = (select "auth"."uid"())) AND ("fd"."class_id" = "flashcards"."class_id"))))) AND (EXISTS ( SELECT 1
   FROM "public"."flashcard_decks" "fd"
  WHERE (("fd"."id" = "flashcards"."deck_id") AND ("fd"."class_id" = "flashcards"."class_id")))))) WITH CHECK ((("public"."authorizeforclassgrader"("class_id") OR (EXISTS ( SELECT 1
   FROM "public"."flashcard_decks" "fd"
  WHERE (("fd"."id" = "flashcards"."deck_id") AND ("fd"."creator_id" = (select "auth"."uid"())) AND ("fd"."class_id" = "flashcards"."class_id"))))) AND (EXISTS ( SELECT 1
   FROM "public"."flashcard_decks" "fd"
  WHERE (("fd"."id" = "flashcards"."deck_id") AND ("fd"."class_id" = "flashcards"."class_id"))))));

-- Update student flashcard progress policies
DROP POLICY IF EXISTS "Allow students to delete own progress" ON "public"."student_flashcard_deck_progress";
CREATE POLICY "Allow students to delete own progress" ON "public"."student_flashcard_deck_progress" FOR DELETE TO "authenticated" USING (("student_id" = (select "auth"."uid"())));

DROP POLICY IF EXISTS "Allow students to insert own progress" ON "public"."student_flashcard_deck_progress";
CREATE POLICY "Allow students to insert own progress" ON "public"."student_flashcard_deck_progress" FOR INSERT TO "authenticated" WITH CHECK ((("student_id" = (select "auth"."uid"())) AND "public"."authorizeforclass"("class_id") AND (EXISTS ( SELECT 1
   FROM "public"."flashcards" "fc"
  WHERE (("fc"."id" = "student_flashcard_deck_progress"."card_id") AND ("fc"."class_id" = "student_flashcard_deck_progress"."class_id"))))));

DROP POLICY IF EXISTS "Allow students to see own progress, instructors/graders to see " ON "public"."student_flashcard_deck_progress";
CREATE POLICY "Allow students to see own progress, instructors/graders to see " ON "public"."student_flashcard_deck_progress" FOR SELECT TO "authenticated" USING (((("student_id" = (select "auth"."uid"())) OR "public"."authorizeforclassgrader"("class_id")) AND (EXISTS ( SELECT 1
   FROM "public"."flashcards" "fc"
  WHERE (("fc"."id" = "student_flashcard_deck_progress"."card_id") AND ("fc"."class_id" = "student_flashcard_deck_progress"."class_id"))))));

DROP POLICY IF EXISTS "Allow students to update own progress" ON "public"."student_flashcard_deck_progress";
CREATE POLICY "Allow students to update own progress" ON "public"."student_flashcard_deck_progress" FOR UPDATE TO "authenticated" USING ((("student_id" = (select "auth"."uid"())) AND "public"."authorizeforclass"("class_id") AND (EXISTS ( SELECT 1
   FROM "public"."flashcards" "fc"
  WHERE (("fc"."id" = "student_flashcard_deck_progress"."card_id") AND ("fc"."class_id" = "student_flashcard_deck_progress"."class_id")))))) WITH CHECK ((("student_id" = (select "auth"."uid"())) AND "public"."authorizeforclass"("class_id") AND (EXISTS ( SELECT 1
   FROM "public"."flashcards" "fc"
  WHERE (("fc"."id" = "student_flashcard_deck_progress"."card_id") AND ("fc"."class_id" = "student_flashcard_deck_progress"."class_id"))))));

-- Update flashcard interaction logs policies
DROP POLICY IF EXISTS "Allow students to insert own interaction logs" ON "public"."flashcard_interaction_logs";
CREATE POLICY "Allow students to insert own interaction logs" ON "public"."flashcard_interaction_logs" FOR INSERT TO "authenticated" WITH CHECK ((("student_id" = (select "auth"."uid"())) AND "public"."authorizeforclass"("class_id") AND (EXISTS ( SELECT 1
   FROM "public"."flashcard_decks" "fd"
  WHERE (("fd"."id" = "flashcard_interaction_logs"."deck_id") AND ("fd"."class_id" = "flashcard_interaction_logs"."class_id")))) AND (("card_id" IS NULL) OR (EXISTS ( SELECT 1
   FROM "public"."flashcards" "fc"
  WHERE (("fc"."id" = "flashcard_interaction_logs"."card_id") AND ("fc"."deck_id" = "flashcard_interaction_logs"."deck_id") AND ("fc"."class_id" = "flashcard_interaction_logs"."class_id")))))));

DROP POLICY IF EXISTS "Allow students to see own logs, instructors/graders to see clas" ON "public"."flashcard_interaction_logs";
CREATE POLICY "Allow students to see own logs, instructors/graders to see clas" ON "public"."flashcard_interaction_logs" FOR SELECT TO "authenticated" USING (((("student_id" = (select "auth"."uid"())) OR "public"."authorizeforclassgrader"("class_id")) AND (EXISTS ( SELECT 1
   FROM "public"."flashcard_decks" "fd"
  WHERE (("fd"."id" = "flashcard_interaction_logs"."deck_id") AND ("fd"."class_id" = "flashcard_interaction_logs"."class_id")))) AND (("card_id" IS NULL) OR (EXISTS ( SELECT 1
   FROM "public"."flashcards" "fc"
  WHERE (("fc"."id" = "flashcard_interaction_logs"."card_id") AND ("fc"."class_id" = "flashcard_interaction_logs"."class_id")))))));

-- Update review assignment rubric parts policies
DROP POLICY IF EXISTS "Assignees can view rubric parts for their reviews" ON "public"."review_assignment_rubric_parts";
CREATE POLICY "Assignees can view rubric parts for their reviews" ON "public"."review_assignment_rubric_parts" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."review_assignments" "ra"
  WHERE (("ra"."id" = "review_assignment_rubric_parts"."review_assignment_id") AND ("ra"."assignee_profile_id" = ( SELECT "user_roles"."private_profile_id"
           FROM "public"."user_roles"
          WHERE (("user_roles"."user_id" = (select "auth"."uid"())) AND ("user_roles"."class_id" = "review_assignment_rubric_parts"."class_id"))))))));

-- Update tags policies
DROP POLICY IF EXISTS "Everyone in the class can view class tags" ON "public"."tags";
CREATE POLICY "Everyone in the class can view class tags" ON "public"."tags" FOR SELECT TO "authenticated" USING (("public"."authorizeforclass"("class_id") AND ("visible" OR ((select "auth"."uid"()) = "creator_id"))));

DROP POLICY IF EXISTS "graders and instructors can delete class tags" ON "public"."tags";
CREATE POLICY "graders and instructors can delete class tags" ON "public"."tags" FOR DELETE TO "authenticated" USING ((("public"."authorizeforclassgrader"("class_id") OR "public"."authorizeforclassinstructor"("class_id")) AND ("visible" OR ((select "auth"."uid"()) = "creator_id"))));

DROP POLICY IF EXISTS "graders and instructors can insert to class tags" ON "public"."tags";
CREATE POLICY "graders and instructors can insert to class tags" ON "public"."tags" FOR INSERT TO "authenticated" WITH CHECK ((("public"."authorizeforclassgrader"("class_id") OR "public"."authorizeforclassinstructor"("class_id")) AND ("visible" OR ((select "auth"."uid"()) = "creator_id"))));

DROP POLICY IF EXISTS "graders and instructors can update class tags" ON "public"."tags";
CREATE POLICY "graders and instructors can update class tags" ON "public"."tags" FOR UPDATE TO "authenticated" USING ((("public"."authorizeforclassgrader"("class_id") OR "public"."authorizeforclassinstructor"("class_id")) AND ("visible" OR ((select "auth"."uid"()) = "creator_id"))));

-- Update grading conflicts policies
DROP POLICY IF EXISTS "Grader can view conflicts where they are the grader" ON "public"."grading_conflicts";
CREATE POLICY "Grader can view conflicts where they are the grader" ON "public"."grading_conflicts" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_roles"
  WHERE (("user_roles"."user_id" = (select "auth"."uid"())) AND ("user_roles"."private_profile_id" = "grading_conflicts"."grader_profile_id") AND ("user_roles"."class_id" = "grading_conflicts"."class_id") AND ("user_roles"."role" = 'grader'::"public"."app_role")))));

DROP POLICY IF EXISTS "Grader can update conflicts where they are the grader" ON "public"."grading_conflicts";
CREATE POLICY "Grader can update conflicts where they are the grader" ON "public"."grading_conflicts" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_roles"
  WHERE ("user_roles"."user_id" = (select "auth"."uid"())))));

DROP POLICY IF EXISTS "Instructor can view all conflicts in their class" ON "public"."grading_conflicts";
CREATE POLICY "Instructor can view all conflicts in their class" ON "public"."grading_conflicts" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_roles"
  WHERE (("user_roles"."user_id" = (select "auth"."uid"())) AND ("user_roles"."class_id" = "grading_conflicts"."class_id")))));

-- Update user_roles policies
DROP POLICY IF EXISTS "Instructors can remove user roles in their class" ON "public"."user_roles";
CREATE POLICY "Instructors can remove user roles in their class" ON "public"."user_roles" FOR DELETE TO "authenticated" USING (("public"."authorizeforclassinstructor"(("class_id")::bigint) AND (("role" <> 'instructor'::"public"."app_role") OR ("user_id" = (select "auth"."uid"())))));

DROP POLICY IF EXISTS "Instructors can update user roles in their class" ON "public"."user_roles";
CREATE POLICY "Instructors can update user roles in their class" ON "public"."user_roles" FOR UPDATE TO "authenticated" USING (("public"."authorizeforclassinstructor"(("class_id")::bigint) AND (("role" <> 'instructor'::"public"."app_role") OR ("user_id" = (select "auth"."uid"()))))) WITH CHECK ("public"."authorizeforclassinstructor"(("class_id")::bigint));

-- Update help request students policies
DROP POLICY IF EXISTS "Students can join their own help requests" ON "public"."help_request_students";
CREATE POLICY "Students can join their own help requests" ON "public"."help_request_students" FOR INSERT TO "authenticated" WITH CHECK (((EXISTS ( SELECT 1
   FROM "public"."help_request_students" "existing_hrs"
     JOIN "public"."user_roles" "ur" ON (("ur"."private_profile_id" = "existing_hrs"."profile_id")))
  WHERE (("existing_hrs"."help_request_id" = "help_request_students"."help_request_id") AND ("ur"."user_id" = (select "auth"."uid"())) AND "public"."authorizeforprofile"("existing_hrs"."profile_id")))) AND "public"."authorizeforprofile"("profile_id")));

DROP POLICY IF EXISTS "Students can leave help requests they are a part of" ON "public"."help_request_students";
CREATE POLICY "Students can leave help requests they are a part of" ON "public"."help_request_students" FOR DELETE TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM "public"."help_request_students" "existing_association"
     JOIN "public"."user_roles" "ur" ON (("ur"."private_profile_id" = "existing_association"."profile_id")))
  WHERE (("existing_association"."help_request_id" = "help_request_students"."help_request_id") AND ("ur"."user_id" = (select "auth"."uid"())) AND ("ur"."class_id" = "help_request_students"."class_id"))))) AND "public"."authorizeforprofile"("profile_id"));

-- Update notification preferences policies
DROP POLICY IF EXISTS "Users can manage their own preferences" ON "public"."notification_preferences";
CREATE POLICY "Users can manage their own preferences" ON "public"."notification_preferences" TO "authenticated" USING (((select "auth"."uid"()) = "user_id")) WITH CHECK (((select "auth"."uid"()) = "user_id"));

-- Update users policies
DROP POLICY IF EXISTS "instructors and graders can view for students in class" ON "public"."users";
CREATE POLICY "instructors and graders can view for students in class" ON "public"."users" FOR SELECT USING (("public"."authorizeforinstructororgraderofstudent"("user_id") OR ((select "auth"."uid"()) = "user_id")));

-- =============================================================================
-- Update other functions that use auth.uid() in triggers and other contexts
-- =============================================================================

-- Update audit triggers to use (select auth.uid()) for better performance
-- Note: These are in trigger functions so the performance impact is minimal,
-- but we update them for consistency

-- Update create_gradebook_compute_trigger function
CREATE OR REPLACE FUNCTION public.create_gradebook_compute_trigger()
 RETURNS "trigger"
 LANGUAGE "plpgsql" SECURITY DEFINER
AS $function$
DECLARE
    this_assignment assignments%ROWTYPE;
    current_user_id uuid;
BEGIN
   -- Get current user ID, handling null case
      current_user_id := (select auth.uid());

   -- TODO: make this work for "draft" (ignore trigger on insert, catch on update)
   if NEW.status = 'draft' then
        return NEW;
   end if;

   -- Get assignment details
   SELECT * INTO this_assignment
   FROM assignments 
   WHERE id = NEW.assignment_id;

   -- Authorization check for manual submissions
   IF current_user_id IS NOT NULL THEN
    IF NOT EXISTS (
        SELECT 1 
        FROM user_roles 
        WHERE role = 'student'
        AND class_id = this_assignment.class_id
        AND user_id = (select auth.uid())
    ) THEN
        RETURN json_build_object('success', false, 'error', 'Not authorized');
    END IF;
   END IF;

   -- Queue background job for gradebook computation
   perform public.create_gradebook_update_background_task(this_assignment.class_id);

   RETURN NEW;
END;
$function$;

-- Update sync_staff_github_team function
CREATE OR REPLACE FUNCTION public.sync_staff_github_team(class_id text)
 RETURNS "json"
 LANGUAGE "plpgsql" SECURITY DEFINER
AS $function$
DECLARE
  result json;
BEGIN
  -- Authorization check: only instructors can manually call this function
  -- Note: This check is bypassed when called from triggers (system context)
  IF (select auth.uid()) IS NOT NULL AND NOT public.authorizeforclassinstructor(class_id::bigint) THEN
    RAISE EXCEPTION 'Access denied: Only instructors can sync staff GitHub team for class %', class_id;
  END IF;

  -- Call the edge function
  SELECT content::json INTO result
  FROM http((
    'POST',
    current_setting('app.base_url') || '/functions/v1/autograder-sync-staff-team',
    ARRAY[http_header('authorization', 'Bearer ' || current_setting('app.service_role_key'))],
    'application/json',
    json_build_object('class_id', class_id)::text
  )::http_request);

  RETURN result;
END;
$function$;

-- Update sync_student_github_team function
CREATE OR REPLACE FUNCTION public.sync_student_github_team(class_id text)
 RETURNS "json"
 LANGUAGE "plpgsql" SECURITY DEFINER
AS $function$
DECLARE
  result json;
BEGIN
  -- Authorization check: only instructors can manually call this function
  -- Note: This check is bypassed when called from triggers (system context)
  IF (select auth.uid()) IS NOT NULL AND NOT public.authorizeforclassinstructor(class_id::bigint) THEN
    RAISE EXCEPTION 'Access denied: Only instructors can sync student GitHub team for class %', class_id;
  END IF;

  -- Call the edge function to sync the student team
  SELECT content::json INTO result
  FROM http((
    'POST',
    current_setting('app.base_url') || '/functions/v1/autograder-sync-student-team',
    ARRAY[http_header('authorization', 'Bearer ' || current_setting('app.service_role_key'))],
    'application/json',
    json_build_object('class_id', class_id)::text
  )::http_request);

  RETURN result;
END;
$function$;

-- =============================================================================
-- Complete migration
-- =============================================================================

-- Add a comment to indicate this migration is complete
COMMENT ON SCHEMA public IS 'RLS auth.uid() performance optimization completed - replaced direct auth.uid() calls with (select auth.uid()) for better performance';
