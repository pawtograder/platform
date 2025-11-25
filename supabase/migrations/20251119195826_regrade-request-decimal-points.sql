-- Migration to support decimal values for regrade request points
-- Changes resolved_points and closed_points from integer to numeric
-- Updates update_regrade_request_status and update_regrade_request_points functions

-- Drop old functions with integer parameter types
DROP FUNCTION IF EXISTS public.update_regrade_request_status(bigint, regrade_status, uuid, integer, integer);
DROP FUNCTION IF EXISTS public.update_regrade_request_points(bigint, uuid, integer, integer);

-- First, alter the table columns to support decimal values
ALTER TABLE public.submission_regrade_requests
    ALTER COLUMN resolved_points TYPE numeric USING resolved_points::numeric,
    ALTER COLUMN closed_points TYPE numeric USING closed_points::numeric;

-- Create update_regrade_request_status function with numeric parameter types
CREATE OR REPLACE FUNCTION public.update_regrade_request_status(
    regrade_request_id bigint,
    new_status regrade_status,
    profile_id uuid,
    resolved_points numeric DEFAULT NULL,
    closed_points numeric DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
    current_request record;
    param_resolved_points numeric;
    param_closed_points numeric;
begin
    param_resolved_points := resolved_points;
    param_closed_points := closed_points;
    
    -- Get the current regrade request
    select *
    into current_request
    from public.submission_regrade_requests
    where id = regrade_request_id;
    
    if not found then
        raise exception 'Regrade request not found';
    end if;
    
    -- Validate resolved_points parameter for resolved status
    if new_status = 'resolved' and resolved_points is null then
        raise exception 'resolved_points parameter is required when status is resolved';
    end if;
    
    -- Validate closed_points parameter for closed status
    if new_status = 'closed' and closed_points is null then
        raise exception 'closed_points parameter is required when status is closed';
    end if;
    
    -- Validate state transitions and permissions
    case new_status
        when 'opened' then
            -- Can only open from draft, and only by submission owner
            if current_request.status != 'draft' then
                raise exception 'Can only open regrade requests that are in draft status';
            end if;
            if not authorizeforprofile(profile_id) then
                raise exception 'Only submission owners can open regrade requests';
            end if;
            
            -- Update with opened timestamp
            update public.submission_regrade_requests
            set status = new_status,
                opened_at = now(),
                last_updated_at = now()
            where id = regrade_request_id;
            
            -- Notify the author of the comment that triggered this regrade request
            insert into public.notifications (class_id, subject, body, style, user_id)
            select 
                distinct on (ur.user_id)
                current_request.class_id,
                '{}'::jsonb as subject,
                jsonb_build_object(
                    'type', 'regrade_request',
                    'action', 'comment_challenged',
                    'regrade_request_id', regrade_request_id,
                    'submission_id', current_request.submission_id,
                    'assignment_id', current_request.assignment_id,
                    'opened_by', profile_id,
                    'opened_by_name', (select name from public.profiles where id = profile_id)
                ) as body,
                'info' as style,
                ur.user_id
            from public.user_roles ur
            where ur.class_id = current_request.class_id
              and ur.private_profile_id = (
                -- Get comment author based on which type of comment this regrade request refers to
                case 
                    when current_request.submission_file_comment_id is not null then
                        (select author from public.submission_file_comments where id = current_request.submission_file_comment_id)
                    when current_request.submission_comment_id is not null then
                        (select author from public.submission_comments where id = current_request.submission_comment_id)
                    when current_request.submission_artifact_comment_id is not null then
                        (select author from public.submission_artifact_comments where id = current_request.submission_artifact_comment_id)
                end
              );
            
        when 'resolved' then
            -- Can only resolve from opened, and only by class graders
            if current_request.status != 'opened' then
                raise exception 'Can only resolve regrade requests that are opened';
            end if;
            if not authorizeforprofile(profile_id) then
                raise exception 'Unauthorized to act as this profile';
            end if;
            if not authorizeforclassgrader(current_request.class_id) then
                raise exception 'Only graders can resolve regrade requests';
            end if;
            
            -- Update with resolved info
            update public.submission_regrade_requests
            set status = new_status,
                resolved_by = profile_id,
                resolved_at = now(),
                resolved_points = param_resolved_points,
                last_updated_at = now()
            where id = regrade_request_id;
            
            -- Update the original comment's points
            if current_request.submission_file_comment_id is not null then
                update public.submission_file_comments
                set points = param_resolved_points
                where id = current_request.submission_file_comment_id;
            elsif current_request.submission_comment_id is not null then
                update public.submission_comments
                set points = param_resolved_points
                where id = current_request.submission_comment_id;
            elsif current_request.submission_artifact_comment_id is not null then
                update public.submission_artifact_comments
                set points = param_resolved_points
                where id = current_request.submission_artifact_comment_id;
            end if;
            
        when 'escalated' then
            -- Can only escalate from resolved, and only by submission owner
            if current_request.status != 'resolved' then
                raise exception 'Can only escalate regrade requests that are resolved';
            end if;
            if not authorizeforprofile(profile_id) then
                raise exception 'Only submission owners can escalate regrade requests';
            end if;
            
            -- Update with escalated info
            update public.submission_regrade_requests
            set status = new_status,
                escalated_by = profile_id,
                escalated_at = now(),
                last_updated_at = now()
            where id = regrade_request_id;
            
        when 'closed' then
            -- Can close from resolved, escalated, or opened, but only by class instructors
            if current_request.status not in ('resolved', 'escalated', 'opened') then
                raise exception 'Can only close regrade requests that are resolved, escalated, or opened';
            end if;
            if not public.authorizeforprofile(profile_id) then
                raise exception 'Unauthorized to act as this profile';
            end if;
            if not public.authorizeforclassinstructor(current_request.class_id) then
                raise exception 'Only instructors can close regrade requests';
            end if;
            
            -- Update with closed info
            update public.submission_regrade_requests
            set status = new_status,
                closed_by = profile_id,
                closed_at = now(),
                closed_points = param_closed_points,
                last_updated_at = now()
            where id = regrade_request_id;
            
            -- Update the original comment's points
            if current_request.submission_file_comment_id is not null then
                update public.submission_file_comments
                set points = param_closed_points
                where id = current_request.submission_file_comment_id;
            elsif current_request.submission_comment_id is not null then
                update public.submission_comments
                set points = param_closed_points
                where id = current_request.submission_comment_id;
            elsif current_request.submission_artifact_comment_id is not null then
                update public.submission_artifact_comments
                set points = param_closed_points
                where id = current_request.submission_artifact_comment_id;
            end if;
            
        when 'draft' then
            raise exception 'Cannot transition back to draft status';
            
        else
            raise exception 'Invalid status: %', new_status;
    end case;
    
    -- Send notifications to all students connected to the submission
    insert into public.notifications (class_id, subject, body, style, user_id)
    select 
        current_request.class_id,
        '{}'::jsonb as subject,
        jsonb_build_object(
            'type', 'regrade_request',
            'action', 'status_change',
            'regrade_request_id', regrade_request_id,
            'old_status', current_request.status,
            'new_status', new_status,
            'submission_id', current_request.submission_id,
            'assignment_id', current_request.assignment_id,
            'updated_by', profile_id,
            'updated_by_name', (select name from public.profiles where id = profile_id)
        ) as body,
        'info' as style,
        ur.user_id
    from public.user_roles ur
    where ur.class_id = current_request.class_id
      and ur.role = 'student'
      and ur.private_profile_id != profile_id
      and ur.private_profile_id in (
        -- Get submission owner profile
        select s.profile_id 
        from public.submissions s 
        where s.id = current_request.submission_id
        
        union
        
        -- Get all group members if submission belongs to a group
        select agm.profile_id
        from public.submissions s
        inner join public.assignment_groups_members agm 
            on agm.assignment_group_id = s.assignment_group_id
        where s.id = current_request.submission_id
          and s.assignment_group_id is not null
      );
    
    -- If status is escalated, also notify all instructors
    if new_status = 'escalated' then
        insert into public.notifications (class_id, subject, body, style, user_id)
        select 
            current_request.class_id,
            '{}'::jsonb as subject,
            jsonb_build_object(
                'type', 'regrade_request',
                'action', 'escalated',
                'regrade_request_id', regrade_request_id,
                'old_status', current_request.status,
                'new_status', new_status,
                'submission_id', current_request.submission_id,
                'assignment_id', current_request.assignment_id,
                'escalated_by', profile_id,
                'escalated_by_name', (select name from public.profiles where id = profile_id)
            ) as body,
            'warning' as style,
            ur.user_id
        from public.user_roles ur
        where ur.class_id = current_request.class_id
          and ur.role = 'instructor';
    end if;
    
    return true;
end;
$function$;

-- Create update_regrade_request_points function with numeric parameter types
CREATE OR REPLACE FUNCTION public.update_regrade_request_points(
    regrade_request_id bigint,
    profile_id uuid,
    resolved_points numeric DEFAULT NULL,
    closed_points numeric DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
declare
    current_request record;
    param_resolved_points numeric;
    param_closed_points numeric;
begin
    param_resolved_points := resolved_points;
    param_closed_points := closed_points;
    
    -- Get the current regrade request
    select *
    into current_request
    from public.submission_regrade_requests
    where id = regrade_request_id;
    
    if not found then
        raise exception 'Regrade request not found';
    end if;
    
    -- Only instructors can edit points
    if not authorizeforprofile(profile_id) then
        raise exception 'Unauthorized to act as this profile';
    end if;
    if not authorizeforclassinstructor(current_request.class_id) then
        raise exception 'Only instructors can edit regrade request points';
    end if;
    
    -- Validate that we're only updating points for appropriate statuses
    if resolved_points is not null and current_request.status not in ('resolved', 'escalated', 'closed') then
        raise exception 'Can only update resolved_points for requests that have been resolved';
    end if;
    
    if closed_points is not null and current_request.status != 'closed' then
        raise exception 'Can only update closed_points for requests that have been closed';
    end if;
    
    -- Ensure at least one points parameter is provided
    if resolved_points is null and closed_points is null then
        raise exception 'Either resolved_points or closed_points must be provided';
    end if;
    
    -- Update the regrade request points
    if resolved_points is not null then
        update public.submission_regrade_requests
        set resolved_points = param_resolved_points,
            last_updated_at = now()
        where id = regrade_request_id;
        
        -- Update the original comment's points to match
        if current_request.submission_file_comment_id is not null then
            update public.submission_file_comments
            set points = param_resolved_points
            where id = current_request.submission_file_comment_id;
        elsif current_request.submission_comment_id is not null then
            update public.submission_comments
            set points = param_resolved_points
            where id = current_request.submission_comment_id;
        elsif current_request.submission_artifact_comment_id is not null then
            update public.submission_artifact_comments
            set points = param_resolved_points
            where id = current_request.submission_artifact_comment_id;
        end if;
    end if;
    
    if closed_points is not null then
        update public.submission_regrade_requests
        set closed_points = param_closed_points,
            last_updated_at = now()
        where id = regrade_request_id;
        
        -- Update the original comment's points to match the final decision
        if current_request.submission_file_comment_id is not null then
            update public.submission_file_comments
            set points = param_closed_points
            where id = current_request.submission_file_comment_id;
        elsif current_request.submission_comment_id is not null then
            update public.submission_comments
            set points = param_closed_points
            where id = current_request.submission_comment_id;
        elsif current_request.submission_artifact_comment_id is not null then
            update public.submission_artifact_comments
            set points = param_closed_points
            where id = current_request.submission_artifact_comment_id;
        end if;
    end if;
    
    return true;
end;
$$;

-- Grant permissions to the updated functions
GRANT ALL ON FUNCTION "public"."update_regrade_request_status"(bigint, regrade_status, uuid, numeric, numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."update_regrade_request_status"(bigint, regrade_status, uuid, numeric, numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_regrade_request_status"(bigint, regrade_status, uuid, numeric, numeric) TO "service_role";

GRANT ALL ON FUNCTION "public"."update_regrade_request_points"("regrade_request_id" bigint, "profile_id" uuid, "resolved_points" numeric, "closed_points" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."update_regrade_request_points"("regrade_request_id" bigint, "profile_id" uuid, "resolved_points" numeric, "closed_points" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_regrade_request_points"("regrade_request_id" bigint, "profile_id" uuid, "resolved_points" numeric, "closed_points" numeric) TO "service_role";

-- Update comments
COMMENT ON FUNCTION "public"."update_regrade_request_status"(bigint, regrade_status, uuid, numeric, numeric) IS 'Updated to include assignment_id and user names in regrade request notifications for better email templates. Now supports decimal values for points.';
COMMENT ON FUNCTION "public"."update_regrade_request_points"("regrade_request_id" bigint, "profile_id" uuid, "resolved_points" numeric, "closed_points" numeric) IS 'Allows instructors to edit resolved_points or closed_points on regrade requests without changing the status. Used for correcting TA decisions or modifying instructor escalation decisions. Now supports decimal values for points.';

