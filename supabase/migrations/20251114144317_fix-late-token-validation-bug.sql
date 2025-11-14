-- Fix bug in authorize_to_create_own_due_date_extension function
-- The function was checking historical token usage but not including tokens_needed
-- in the validation checks, allowing users to exceed max_late_tokens limits.
--
-- Bug: Lines 73 and 79 checked tokens_used_* > limit without adding tokens_needed
-- Fix: Add tokens_needed to both checks to prevent exceeding limits

CREATE OR REPLACE FUNCTION public.authorize_to_create_own_due_date_extension(_student_id uuid, _assignment_group_id bigint, _assignment_id bigint, _class_id bigint, _creator_id uuid, _hours_to_extend integer, _tokens_consumed integer)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
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

  select public.user_roles.private_profile_id from public.user_roles where user_id = auth.uid() and class_id = _class_id into private_profile_id;
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

  -- FIX: Include tokens_needed in the check to prevent exceeding per-student token limit
  if tokens_used_all_assignments + tokens_needed > tokens_remaining then
    return false;
  end if;

  select max_late_tokens from public.assignments where id=_assignment_id into max_tokens_for_assignment;

  -- FIX: Include tokens_needed in the check to prevent exceeding per-assignment token limit
  if tokens_used_this_assignment + tokens_needed > max_tokens_for_assignment then
    return false;
  end if;

  return true;
end;
$function$;

