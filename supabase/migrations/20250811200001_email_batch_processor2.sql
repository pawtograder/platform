-- Migration to fix notification data and due date logic
-- This migration applies changes that were incorrectly made to older migrations
-- Originally in commits 73e48cc and 27ab60532

-- Update regrade request notifications to include assignment_id and user names
-- This enhances the notification data for better email templates

-- First, update the function that creates regrade request notifications when they are opened
CREATE OR REPLACE FUNCTION public.update_regrade_request_status(
    regrade_request_id bigint,
    new_status regrade_status,
    profile_id uuid,
    resolved_points integer DEFAULT NULL,
    closed_points integer DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
    current_request record;
    param_resolved_points integer;
    param_closed_points integer;
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

-- Update the regrade request comment notification function
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
    where ur.class_id = NEW.class_id
      and ur.private_profile_id in (
        -- Get assignee of the regrade request
        select regrade_request_record.assignee
        
        union
        
        -- Get submission owner profile
        select s.profile_id 
        from public.submissions s 
        where s.id = regrade_request_record.submission_id
        
        union
        
        -- Get all group members if submission belongs to a group
        select agm.profile_id
        from public.submissions s
        inner join public.assignment_groups_members agm 
            on agm.assignment_group_id = s.assignment_group_id
        where s.id = regrade_request_record.submission_id
          and s.assignment_group_id is not null
        
        union
        
        -- Get all previous comment authors from this regrade request
        select author from public.submission_regrade_request_comments 
        where submission_regrade_request_id = NEW.submission_regrade_request_id
      )
      and ur.private_profile_id != NEW.author; -- Exclude the new comment author
    
    return NEW;
end;
$function$;

-- Update help request notifications to include request subject and body
-- This updates the help_request_notification function to include additional fields

-- Find and update the help_request_notification function to include request subject and body
CREATE OR REPLACE FUNCTION "public"."help_request_notification"(
    "p_help_request_id" bigint, 
    "p_action" text, 
    "p_class_id" bigint, 
    "p_help_queue_id" bigint, 
    "p_help_queue_name" text, 
    "p_creator_profile_id" uuid, 
    "p_creator_name" text, 
    "p_assignee_profile_id" uuid, 
    "p_assignee_name" text, 
    "p_status" text, 
    "p_request_preview" text, 
    "p_is_private" boolean
) 
RETURNS void 
LANGUAGE "plpgsql" SECURITY DEFINER
AS $$
DECLARE
    target_user_id UUID;
    user_role TEXT;
BEGIN
  -- Create notification for all help queue watchers first (common body)
  if p_action in ('created', 'status_changed', 'assigned') then
    insert into public.notifications (class_id, subject, body, style, user_id)
    select 
      p_class_id,
      '{}'::jsonb as subject,
      jsonb_build_object(
      'type', 'help_request',
      'action', p_action,
      'help_request_id', p_help_request_id,
      'help_queue_id', p_help_queue_id,
      'help_queue_name', p_help_queue_name,
      'creator_profile_id', p_creator_profile_id,
      'creator_name', p_creator_name,
      'assignee_profile_id', p_assignee_profile_id,
      'assignee_name', p_assignee_name,
      'status', p_status,
      'request_preview', p_request_preview,
      'request_subject', COALESCE((select name from public.help_request_templates hrt where hrt.id = (select template_id from public.help_requests where id = p_help_request_id)), 'General'),
      'request_body', (select request from public.help_requests where id = p_help_request_id),
      'is_private', p_is_private
    ),
    'info' as style,
    hqw.user_id
    from public.help_queue_watchers hqw
    where hqw.help_queue_id = p_help_queue_id
      and (
        -- For private requests, only notify if watcher is instructor/grader, creator, or assignee
        (not p_is_private) 
        or (p_is_private and exists (
          select 1 from public.user_roles ur 
          where ur.user_id = hqw.user_id 
            and ur.class_id = p_class_id 
            and ur.role in ('instructor', 'grader')
        ))
        or (p_is_private and exists (
          select 1 from public.user_roles ur 
          where ur.user_id = hqw.user_id 
            and ur.class_id = p_class_id 
            and ur.private_profile_id = p_creator_profile_id
        ))
        or (p_is_private and p_assignee_profile_id is not null and exists (
          select 1 from public.user_roles ur 
          where ur.user_id = hqw.user_id 
            and ur.class_id = p_class_id 
            and ur.private_profile_id = p_assignee_profile_id
        ))
      );
  end if;

  -- For 'created' action, notify all eligible users and auto-create watchers
  if p_action = 'created' then
    -- Send notifications to eligible users (not restricted to watchers for creation)
    for target_user_id, user_role in
      select distinct ur.user_id, ur.role
      from public.user_roles ur
      where ur.class_id = p_class_id
        and (
          -- For private requests, only notify instructors, graders, creator, and assignee
          (p_is_private and ur.role in ('instructor', 'grader'))
          or (p_is_private and ur.private_profile_id = p_creator_profile_id)
          or (p_is_private and p_assignee_profile_id is not null and ur.private_profile_id = p_assignee_profile_id)
          -- For public requests, notify everyone in the class
          or (not p_is_private)
        )
        and not exists (
          -- Don't send duplicate notifications to users who are already watchers
          select 1 from public.help_queue_watchers hqw
          where hqw.help_queue_id = p_help_queue_id and hqw.user_id = ur.user_id
        )
    loop
      -- Insert notification
      insert into public.notifications (class_id, subject, body, style, user_id)
      values (
        p_class_id,
        '{}'::jsonb,
        jsonb_build_object(
          'type', 'help_request',
          'action', p_action,
          'help_request_id', p_help_request_id,
          'help_queue_id', p_help_queue_id,
          'help_queue_name', p_help_queue_name,
          'creator_profile_id', p_creator_profile_id,
          'creator_name', p_creator_name,
          'assignee_profile_id', p_assignee_profile_id,
          'assignee_name', p_assignee_name,
          'status', p_status,
          'request_preview', p_request_preview,
          'request_subject', COALESCE((select name from public.help_request_templates hrt where hrt.id = (select template_id from public.help_requests where id = p_help_request_id)), 'General'),
          'request_body', (select request from public.help_requests where id = p_help_request_id),
          'is_private', p_is_private
        ),
        'info',
        target_user_id
      );

      -- Auto-create watcher for instructors and graders on new help requests
      if user_role in ('instructor', 'grader') then
        insert into public.help_queue_watchers (help_queue_id, user_id, class_id)
        values (p_help_queue_id, target_user_id, p_class_id)
        on conflict (help_queue_id, user_id) do nothing;
      end if;
    end loop;
  end if;
END;
$$;

-- Fix the due date logic for review assignments
-- Update the check_assignment_deadlines_passed function to use the correct ON CONFLICT clause

CREATE OR REPLACE FUNCTION "public"."check_assignment_deadlines_passed"() 
RETURNS void
LANGUAGE "plpgsql" SECURITY DEFINER
AS $$
BEGIN
    -- First, create any missing submission reviews for students whose lab-based due dates have passed
    INSERT INTO submission_reviews (total_score, released, tweak, class_id, submission_id, name, rubric_id)
    SELECT DISTINCT
        0, false, 0, a.class_id, s.id, 'Self Review', a.self_review_rubric_id
    FROM assignments a
    JOIN assignment_self_review_settings ars ON ars.id = a.self_review_setting_id
    JOIN profiles prof ON prof.class_id = a.class_id AND prof.is_private_profile = true
    JOIN user_roles ur ON ur.private_profile_id = prof.id AND ur.role = 'student'
    JOIN submissions s ON (
        (s.profile_id = prof.id OR s.assignment_group_id IN (
            SELECT agm.assignment_group_id 
            FROM assignment_groups_members agm 
            WHERE agm.profile_id = prof.id AND agm.assignment_id = a.id
        ))
        AND s.assignment_id = a.id 
        AND s.is_active = true
    )
    LEFT JOIN assignment_groups_members agm ON agm.profile_id = prof.id AND agm.assignment_id = a.id
    WHERE a.archived_at IS NULL
    AND ars.enabled = true
    AND a.self_review_rubric_id IS NOT NULL
    AND public.calculate_final_due_date(a.id, prof.id, agm.assignment_group_id) <= NOW()
    AND NOT EXISTS (
        SELECT 1 FROM review_assignments ra 
        WHERE ra.assignment_id = a.id AND ra.assignee_profile_id = prof.id
    )
    AND NOT EXISTS (
        SELECT 1 FROM submission_reviews sr 
        WHERE sr.submission_id = s.id 
        AND sr.class_id = a.class_id 
        AND sr.rubric_id = a.self_review_rubric_id
    );

    -- Then, insert review assignments for students who need them but don't have them yet
    INSERT INTO review_assignments (
        due_date,
        assignee_profile_id,
        submission_id,
        submission_review_id,
        assignment_id,
        rubric_id,
        class_id
    )
    SELECT DISTINCT
        public.calculate_final_due_date(a.id, prof.id, agm.assignment_group_id) + (INTERVAL '1 hour' * ars.deadline_offset),
        prof.id,
        s.id,
        sr.id,
        a.id,
        a.self_review_rubric_id,
        a.class_id
    FROM assignments a
    JOIN assignment_self_review_settings ars ON ars.id = a.self_review_setting_id
    JOIN profiles prof ON prof.class_id = a.class_id AND prof.is_private_profile = true
    JOIN user_roles ur ON ur.private_profile_id = prof.id AND ur.role = 'student'
    JOIN submissions s ON (
        (s.profile_id = prof.id OR s.assignment_group_id IN (
            SELECT agm.assignment_group_id 
            FROM assignment_groups_members agm 
            WHERE agm.profile_id = prof.id AND agm.assignment_id = a.id
        ))
        AND s.assignment_id = a.id 
        AND s.is_active = true
    )
    LEFT JOIN assignment_groups_members agm ON agm.profile_id = prof.id AND agm.assignment_id = a.id
    JOIN submission_reviews sr ON (
        sr.submission_id = s.id 
        AND sr.class_id = a.class_id 
        AND sr.rubric_id = a.self_review_rubric_id
    )
    WHERE a.archived_at IS NULL
    AND ars.enabled = true
    AND public.calculate_final_due_date(a.id, prof.id, agm.assignment_group_id) <= NOW()
    AND NOT EXISTS (
        SELECT 1 FROM review_assignments ra 
        WHERE ra.assignment_id = a.id AND ra.assignee_profile_id = prof.id
    )
    ON CONFLICT (submission_review_id, assignee_profile_id) DO NOTHING;
END;
$$;

-- Grant necessary permissions
GRANT ALL ON FUNCTION "public"."update_regrade_request_status"(bigint, regrade_status, uuid, integer, integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_regrade_request_status"(bigint, regrade_status, uuid, integer, integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."notify_regrade_request_participants"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."notify_regrade_request_participants"() TO "service_role";
GRANT ALL ON FUNCTION "public"."help_request_notification"(bigint, text, bigint, bigint, text, uuid, text, uuid, text, text, text, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."help_request_notification"(bigint, text, bigint, bigint, text, uuid, text, uuid, text, text, text, boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."check_assignment_deadlines_passed"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."check_assignment_deadlines_passed"() TO "service_role";

-- Add comments to document what this migration does
COMMENT ON FUNCTION "public"."update_regrade_request_status"(bigint, regrade_status, uuid, integer, integer) IS 'Updated to include assignment_id and user names in regrade request notifications for better email templates';
COMMENT ON FUNCTION "public"."notify_regrade_request_participants"() IS 'Updated to include assignment_id and comment author name in regrade request comment notifications';
COMMENT ON FUNCTION "public"."help_request_notification"(bigint, text, bigint, bigint, text, uuid, text, uuid, text, text, text, boolean) IS 'Updated to include request_subject and request_body in help request notifications';
COMMENT ON FUNCTION "public"."check_assignment_deadlines_passed"() IS 'Updated ON CONFLICT clause to use (submission_review_id, assignee_profile_id) instead of (submission_id, rubric_id)';
