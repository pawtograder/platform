-- Fix notify_regrade_request_participants to handle pseudonymous grading
-- When graders/instructors use their public_profile_id (pseudonym) in comments,
-- the notification logic needs to find users by matching both public and private profile IDs

CREATE OR REPLACE FUNCTION public.notify_regrade_request_participants()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
    regrade_request_record record;
begin
    -- Get the regrade request details
    select *
    into regrade_request_record
    from public.submission_regrade_requests
    where id = NEW.submission_regrade_request_id;
    
    -- If no regrade request found, exit early (shouldn't happen due to FK constraint)
    if not found then
        return NEW;
    end if;
    
    -- Notify all participants except the comment author
    -- Filter out staff with Discord linked who have defaulted to 'none'
    -- Updated to handle both private and public profile IDs for pseudonymous grading
    insert into public.notifications (class_id, subject, body, style, user_id)
    select distinct
        NEW.class_id,
        '{}'::jsonb as subject,
        jsonb_build_object(
            'type', 'regrade_request',
            'action', 'new_comment',
            'regrade_request_id', regrade_request_record.id,
            'submission_id', regrade_request_record.submission_id,
            'assignment_id', regrade_request_record.assignment_id,
            'comment_author', NEW.author,
            'comment_author_name', (select name from public.profiles where id = NEW.author),
            'comment_id', NEW.id
        ) as body,
        'info' as style,
        ur.user_id
    from public.user_roles ur
    left join public.notification_preferences np
      on np.user_id = ur.user_id and np.class_id = NEW.class_id
    left join public.users u
      on u.user_id = ur.user_id
    where ur.class_id = NEW.class_id
      -- Match users by either their private or public profile ID
      and (ur.private_profile_id in (
        -- Get assignee of the regrade request (could be private or public profile)
        select regrade_request_record.assignee
        
        union
        
        -- Get submission owner profile (always private)
        select s.profile_id 
        from public.submissions s 
        where s.id = regrade_request_record.submission_id
        
        union
        
        -- Get all group members if submission belongs to a group (always private)
        select agm.profile_id
        from public.submissions s
        inner join public.assignment_groups_members agm 
            on agm.assignment_group_id = s.assignment_group_id
        where s.id = regrade_request_record.submission_id
          and s.assignment_group_id is not null
        
        union
        
        -- Get all previous comment authors from this regrade request (could be private or public)
        select author from public.submission_regrade_request_comments 
        where submission_regrade_request_id = NEW.submission_regrade_request_id
      )
      -- Also check public_profile_id for pseudonymous matching
      or ur.public_profile_id in (
        select regrade_request_record.assignee
        union
        select author from public.submission_regrade_request_comments 
        where submission_regrade_request_id = NEW.submission_regrade_request_id
      ))
      -- Exclude the new comment author - check both private and public profile IDs
      and ur.private_profile_id != NEW.author
      and ur.public_profile_id != NEW.author
      -- For staff (instructor/grader), check preferences - default to 'none' if Discord linked
      and (
        ur.role NOT IN ('instructor', 'grader')
        or coalesce(
          np.regrade_request_notification::text,
          CASE 
            WHEN u.discord_id IS NOT NULL AND ur.role IN ('instructor', 'grader') THEN 'none'
            ELSE 'all'
          END
        ) <> 'none'
      );
    
    return NEW;
end;
$function$;

COMMENT ON FUNCTION public.notify_regrade_request_participants() IS 
'Notifies participants in a regrade request when a new comment is added. Updated to support pseudonymous grading where graders/instructors may use their public_profile_id instead of private_profile_id.';
