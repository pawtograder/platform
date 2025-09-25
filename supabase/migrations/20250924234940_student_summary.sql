-- Create RPC to fetch a student's course summary as JSON
-- Function: public.get_student_summary(p_class_id bigint, p_student_profile_id uuid)

create or replace function public.get_student_summary(
  p_class_id bigint,
  p_student_profile_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_public_profile_id uuid;
  v_profile_ids uuid[];
begin
  -- Authorization: allow if caller is the student (private_profile) or staff (instructor/grader) in the class
  if not exists (
    select 1
    from public.user_privileges ur
    where ur.class_id = p_class_id
      and ur.user_id = auth.uid()
      and (
        ur.role in ('instructor','grader')
        or ur.private_profile_id = p_student_profile_id
      )
  ) then
    raise exception 'Access denied'
      using errcode = 'insufficient_privilege';
  end if;

  -- Resolve both profile IDs for the student in this class
  select up.public_profile_id
    into v_public_profile_id
    from public.user_privileges up
   where up.class_id = p_class_id
     and up.private_profile_id = p_student_profile_id
   limit 1;

  v_profile_ids := array_remove(ARRAY[p_student_profile_id, v_public_profile_id], NULL);

  -- Build JSON in parts
  with
  -- Recent help requests the student is a participant in this class (latest 50)
  help_requests as (
    select hr.id,
           hr.created_at,
           hr.help_queue,
           hr.request,
           hr.assignee,
           hr.resolved_by,
           hr.resolved_at,
           hr.is_private,
           hr.status
      from public.help_requests hr
      join public.help_request_students hrs on hrs.help_request_id = hr.id and hrs.class_id = hr.class_id
     where hr.class_id = p_class_id
       and hrs.profile_id = any (v_profile_ids)
     order by hr.created_at desc
     limit 50
  ),
  help_request_ids as (
    select id from help_requests
  ),
  -- Latest 50 messages authored by the student across all help requests in the class
  help_messages as (
    select hrm.id,
           hrm.created_at,
           hrm.author,
           hrm.message,
           hrm.instructors_only,
           hrm.help_request_id
      from public.help_request_messages hrm
     where hrm.class_id = p_class_id
       and hrm.author = any (v_profile_ids)
     order by hrm.created_at desc
     limit 50
  ),
  -- Recent discussion threads (student-authored) and replies (latest 50 each)
  discussion_posts as (
    select dt.id,
           dt.created_at,
           dt.subject,
           dt.body,
           dt.instructors_only,
           dt.parent,
           dt.root,
           dt.topic_id
      from public.discussion_threads dt
     where dt.class_id = p_class_id
       and dt.author = any (v_profile_ids)
       and dt.parent is null
     order by dt.created_at desc
     limit 50
  ),
  discussion_replies as (
    select dt.id,
           dt.created_at,
           dt.subject,
           dt.body,
           dt.instructors_only,
           dt.parent,
           dt.root,
           dt.topic_id
      from public.discussion_threads dt
     where dt.class_id = p_class_id
       and dt.author = any (v_profile_ids)
       and dt.parent is not null
     order by dt.created_at desc
     limit 50
  ),
  -- Assignment summary for released assignments
  assignments as (
    select a.id as assignment_id,
           a.title,
           a.release_date,
           public.calculate_final_due_date(a.id, p_student_profile_id, agm.assignment_group_id) as effective_due_date,
           s.id as submission_id,
           s.created_at as submission_timestamp,
           s.ordinal as submission_ordinal,
           sr.total_autograde_score as autograder_score,
           sr.total_score as total_score
      from public.assignments a
      left join public.assignment_groups_members agm
        on agm.assignment_id = a.id and agm.profile_id = any (v_profile_ids)
      left join public.submissions s
        on s.assignment_id = a.id
       and s.is_active = true
       and (
         (s.profile_id = any (v_profile_ids) and s.assignment_group_id is null)
         or (s.profile_id is null and s.assignment_group_id = agm.assignment_group_id)
       )
      left join public.submission_reviews sr on sr.id = s.grading_review_id
     where a.class_id = p_class_id
       and a.release_date is not null
       and a.release_date <= now()
  ),
  -- Private grades only
  private_grades as (
    select gcs.gradebook_column_id,
           gcs.score,
           gcs.score_override,
           gcs.released,
           gcs.incomplete_values
      from public.gradebook_column_students gcs
     where gcs.class_id = p_class_id
       and gcs.student_id = p_student_profile_id
       and gcs.is_private = true
  )
  select jsonb_build_object(
    'help_requests', coalesce(jsonb_agg(to_jsonb(help_requests) order by help_requests.created_at desc), '[]'::jsonb),
    'help_messages', coalesce((select jsonb_agg(to_jsonb(help_messages) order by help_messages.created_at desc) from help_messages), '[]'::jsonb),
    'discussion_posts', coalesce((select jsonb_agg(to_jsonb(discussion_posts) order by discussion_posts.created_at desc) from discussion_posts), '[]'::jsonb),
    'discussion_replies', coalesce((select jsonb_agg(to_jsonb(discussion_replies) order by discussion_replies.created_at desc) from discussion_replies), '[]'::jsonb),
    'assignments', coalesce((select jsonb_agg(to_jsonb(assignments) order by assignments.effective_due_date asc nulls last) from assignments), '[]'::jsonb),
    'grades_private', coalesce((select jsonb_agg(to_jsonb(private_grades)) from private_grades), '[]'::jsonb)
  ) into v_result
  from help_requests
  limit 1;

  -- If no help requests existed, still build result from empty selects
  if v_result is null then
    select jsonb_build_object(
      'help_requests', '[]'::jsonb,
      'help_messages', coalesce((select jsonb_agg(to_jsonb(help_messages) order by help_messages.created_at desc) from help_messages), '[]'::jsonb),
      'discussion_posts', coalesce((select jsonb_agg(to_jsonb(discussion_posts) order by discussion_posts.created_at desc) from discussion_posts), '[]'::jsonb),
      'discussion_replies', coalesce((select jsonb_agg(to_jsonb(discussion_replies) order by discussion_replies.created_at desc) from discussion_replies), '[]'::jsonb),
      'assignments', coalesce((select jsonb_agg(to_jsonb(assignments) order by assignments.effective_due_date asc nulls last) from assignments), '[]'::jsonb),
      'grades_private', coalesce((select jsonb_agg(to_jsonb(private_grades)) from private_grades), '[]'::jsonb)
    ) into v_result;
  end if;

  return v_result;
end;
$$;

alter function public.get_student_summary(p_class_id bigint, p_student_profile_id uuid) owner to postgres;
REVOKE ALL ON FUNCTION public.get_student_summary(bigint, uuid) FROM public;
GRANT ALL ON FUNCTION public.get_student_summary(bigint, uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.get_student_summary(bigint, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_student_summary(bigint, uuid) TO service_role;

comment on function public.get_student_summary(bigint, uuid) is 'Returns a JSON summary for a student in a class: recent help requests/messages, discussion posts/replies, released assignments with effective due date and latest submission (ordinal, timestamp) plus autograder and total scores, and private grades.';


-- Optimize RLS for this function
CREATE OR REPLACE FUNCTION "public"."get_gradebook_records_for_all_students_array"("class_id" bigint)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER  
SET search_path TO ''
AS $$
    -- Ultra-optimized version using arrays for maximum performance with massive datasets
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'private_profile_id', student_id::text,
            'entries', entries_array
        ) ORDER BY student_id
    ), '[]'::jsonb)
    FROM (
        SELECT 
            gcs.student_id,
                         jsonb_agg(
                 ARRAY[
                     gcs.id::text,
                     gcs.gradebook_column_id::text, 
                     gcs.is_private::text,
                     COALESCE(gcs.score::text, ''),
                     COALESCE(gcs.score_override::text, ''),
                     gcs.is_missing::text,
                     gcs.is_excused::text,
                     gcs.is_droppable::text,
                     gcs.released::text,
                     COALESCE(gcs.score_override_note, ''),
                     gcs.is_recalculating::text,
                     COALESCE(gcs.incomplete_values::text, '')
                 ] ORDER BY gc.sort_order ASC NULLS LAST, gc.id ASC
             ) as entries_array
        FROM public.gradebook_column_students gcs
        INNER JOIN public.gradebook_columns gc ON gc.id = gcs.gradebook_column_id
        WHERE gcs.class_id = get_gradebook_records_for_all_students_array.class_id
        and EXISTS (
          SELECT 1 FROM public.user_privileges up
          WHERE up.user_id = auth.uid()
            AND up.class_id = get_gradebook_records_for_all_students_array.class_id
            AND up.role IN ('instructor','grader')
        )
        GROUP BY gcs.student_id
    ) array_data;
$$;
