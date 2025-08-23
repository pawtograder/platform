-- System Notification Management Functions
-- Provides admin-only functions for efficiently creating system notifications with audience targeting

-- 1. Create system notification function with bulk INSERT...SELECT for performance
CREATE OR REPLACE FUNCTION public.create_system_notification(
    p_title text,
    p_message text,
    p_display text DEFAULT 'default',
    p_severity text DEFAULT 'info',
    p_icon text DEFAULT NULL,
    p_persistent boolean DEFAULT false,
    p_expires_at timestamp with time zone DEFAULT NULL,
    p_campaign_id text DEFAULT NULL,
    p_track_engagement boolean DEFAULT false,
    p_max_width text DEFAULT NULL,
    p_position text DEFAULT 'bottom',
    p_backdrop_dismiss boolean DEFAULT true,
    -- Audience targeting parameters
    p_target_roles public.app_role[] DEFAULT NULL,
    p_target_course_ids bigint[] DEFAULT NULL,
    p_target_user_ids uuid[] DEFAULT NULL,
    p_created_by uuid DEFAULT auth.uid()
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_notification_count bigint := 0;
    v_system_notification_body jsonb;
    v_audience_filter jsonb := '{}';
BEGIN
    -- Check admin authorization
    IF NOT public.authorize_for_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Access denied: Admin role required'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    
    -- Validate required parameters
    IF p_title IS NULL OR trim(p_title) = '' THEN
        RAISE EXCEPTION 'Notification title is required'
            USING ERRCODE = 'check_violation';
    END IF;
    
    IF p_message IS NULL OR trim(p_message) = '' THEN
        RAISE EXCEPTION 'Notification message is required'
            USING ERRCODE = 'check_violation';
    END IF;
    
    -- Validate display mode
    IF p_display NOT IN ('default', 'modal', 'banner') THEN
        RAISE EXCEPTION 'Invalid display mode. Must be: default, modal, or banner'
            USING ERRCODE = 'check_violation';
    END IF;
    
    -- Validate severity
    IF p_severity NOT IN ('info', 'success', 'warning', 'error') THEN
        RAISE EXCEPTION 'Invalid severity. Must be: info, success, warning, or error'
            USING ERRCODE = 'check_violation';
    END IF;
    
    -- Build audience filter for the notification body
    IF p_target_roles IS NOT NULL OR p_target_course_ids IS NOT NULL OR p_target_user_ids IS NOT NULL THEN
        v_audience_filter := jsonb_build_object(
            'roles', COALESCE(to_jsonb(p_target_roles), 'null'::jsonb),
            'course_ids', COALESCE(to_jsonb(p_target_course_ids), 'null'::jsonb),
            'user_ids', COALESCE(to_jsonb(p_target_user_ids), 'null'::jsonb)
        );
        -- Remove null values
        SELECT jsonb_strip_nulls(v_audience_filter) INTO v_audience_filter;
    END IF;
    
    -- Build the system notification body
    v_system_notification_body := jsonb_build_object(
        'type', 'system',
        'title', trim(p_title),
        'message', trim(p_message),
        'display', p_display,
        'severity', p_severity
    );
    
    -- Add optional properties
    IF p_icon IS NOT NULL AND trim(p_icon) != '' THEN
        v_system_notification_body := v_system_notification_body || jsonb_build_object('icon', trim(p_icon));
    END IF;
    
    IF p_persistent = true THEN
        v_system_notification_body := v_system_notification_body || jsonb_build_object('persistent', true);
    END IF;
    
    IF p_expires_at IS NOT NULL THEN
        v_system_notification_body := v_system_notification_body || jsonb_build_object('expires_at', p_expires_at::text);
    END IF;
    
    IF p_campaign_id IS NOT NULL AND trim(p_campaign_id) != '' THEN
        v_system_notification_body := v_system_notification_body || jsonb_build_object('campaign_id', trim(p_campaign_id));
    END IF;
    
    IF p_track_engagement = true THEN
        v_system_notification_body := v_system_notification_body || jsonb_build_object('track_engagement', true);
    END IF;
    
    IF p_max_width IS NOT NULL AND trim(p_max_width) != '' THEN
        v_system_notification_body := v_system_notification_body || jsonb_build_object('max_width', trim(p_max_width));
    END IF;
    
    IF p_display = 'banner' AND p_position IS NOT NULL THEN
        v_system_notification_body := v_system_notification_body || jsonb_build_object('position', p_position);
    END IF;
    
    IF p_display = 'modal' THEN
        v_system_notification_body := v_system_notification_body || jsonb_build_object('backdrop_dismiss', p_backdrop_dismiss);
    END IF;
    
    -- Add audience filter if specified
    IF jsonb_typeof(v_audience_filter) = 'object' AND v_audience_filter != '{}' THEN
        v_system_notification_body := v_system_notification_body || jsonb_build_object('audience', v_audience_filter);
    END IF;
    
    -- Use bulk INSERT...SELECT for performance based on targeting criteria
    
    IF p_target_user_ids IS NOT NULL THEN
        -- Target specific users
        INSERT INTO public.notifications (user_id, class_id, subject, body, created_at)
        SELECT 
            target_user.user_id,
            ur.class_id,
            jsonb_build_object('title', trim(p_title)),
            v_system_notification_body,
            now()
        FROM unnest(p_target_user_ids) AS target_user(user_id)
        JOIN public.user_roles ur ON ur.user_id = target_user.user_id
        WHERE (p_target_roles IS NULL OR ur.role = ANY(p_target_roles))
          AND (p_target_course_ids IS NULL OR ur.class_id = ANY(p_target_course_ids))
          AND (ur.disabled IS NULL OR ur.disabled = FALSE)
        GROUP BY target_user.user_id, ur.class_id; -- Avoid duplicates if user has multiple roles
        
        GET DIAGNOSTICS v_notification_count = ROW_COUNT;
        
    ELSIF p_target_roles IS NOT NULL OR p_target_course_ids IS NOT NULL THEN
        -- Target by roles and/or courses
        INSERT INTO public.notifications (user_id, class_id, subject, body, created_at)
        SELECT DISTINCT
            ur.user_id,
            ur.class_id,
            jsonb_build_object('title', trim(p_title)),
            v_system_notification_body,
            now()
        FROM public.user_roles ur
        WHERE (p_target_roles IS NULL OR ur.role = ANY(p_target_roles))
          AND (p_target_course_ids IS NULL OR ur.class_id = ANY(p_target_course_ids))
          AND (ur.disabled IS NULL OR ur.disabled = FALSE);
        
        GET DIAGNOSTICS v_notification_count = ROW_COUNT;
        
    ELSE
        -- Target all users (global notification)
        INSERT INTO public.notifications (user_id, class_id, subject, body, created_at)
        SELECT DISTINCT
            ur.user_id,
            ur.class_id,
            jsonb_build_object('title', trim(p_title)),
            v_system_notification_body,
            now()
        FROM public.user_roles ur
        WHERE (ur.disabled IS NULL OR ur.disabled = FALSE);
        
        GET DIAGNOSTICS v_notification_count = ROW_COUNT;
    END IF;
    
    -- Return the number of notifications created
    RETURN v_notification_count;
END;
$$;

-- 2. Bulk delete system notifications by campaign
CREATE OR REPLACE FUNCTION public.delete_system_notifications_by_campaign(
    p_campaign_id text,
    p_deleted_by uuid DEFAULT auth.uid()
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_deleted_count bigint := 0;
BEGIN
    -- Check admin authorization
    IF NOT public.authorize_for_admin(p_deleted_by) THEN
        RAISE EXCEPTION 'Access denied: Admin role required'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    
    IF p_campaign_id IS NULL OR trim(p_campaign_id) = '' THEN
        RAISE EXCEPTION 'Campaign ID is required'
            USING ERRCODE = 'check_violation';
    END IF;
    
    -- Delete notifications with matching campaign_id in body
    DELETE FROM public.notifications 
    WHERE body->>'type' = 'system'
      AND body->>'campaign_id' = trim(p_campaign_id);
    
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    
    RETURN v_deleted_count;
END;
$$;

-- 3. Get system notification statistics for admin dashboard
CREATE OR REPLACE FUNCTION public.get_system_notification_stats(
    p_requested_by uuid DEFAULT auth.uid()
)
RETURNS TABLE(
    total_notifications bigint,
    active_notifications bigint,
    notifications_by_severity jsonb,
    notifications_by_display jsonb,
    recent_campaigns jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    -- Check admin authorization
    IF NOT public.authorize_for_admin() THEN
        RAISE EXCEPTION 'Access denied: Admin role required'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    
    RETURN QUERY
    SELECT 
        -- Total system notifications
        (SELECT count(*)::bigint 
         FROM public.notifications 
         WHERE body->>'type' = 'system') as total_notifications,
        
        -- Active (unread) system notifications
        (SELECT count(*)::bigint 
         FROM public.notifications 
         WHERE body->>'type' = 'system' AND viewed_at IS NULL) as active_notifications,
        
        -- Notifications grouped by severity
        (SELECT jsonb_object_agg(severity, count)
         FROM (
             SELECT 
                 COALESCE(body->>'severity', 'info') as severity,
                 count(*)::bigint as count
             FROM public.notifications 
             WHERE body->>'type' = 'system'
             GROUP BY COALESCE(body->>'severity', 'info')
         ) severity_stats) as notifications_by_severity,
        
        -- Notifications grouped by display mode
        (SELECT jsonb_object_agg(display_mode, count)
         FROM (
             SELECT 
                 COALESCE(body->>'display', 'default') as display_mode,
                 count(*)::bigint as count
             FROM public.notifications 
             WHERE body->>'type' = 'system'
             GROUP BY COALESCE(body->>'display', 'default')
         ) display_stats) as notifications_by_display,
        
        -- Recent campaigns (last 30 days)
        (SELECT jsonb_agg(jsonb_build_object('campaign_id', campaign_id, 'count', count, 'last_created', last_created))
         FROM (
             SELECT 
                 body->>'campaign_id' as campaign_id,
                 count(*)::bigint as count,
                 max(created_at) as last_created
             FROM public.notifications 
             WHERE body->>'type' = 'system' 
               AND body->>'campaign_id' IS NOT NULL
               AND created_at >= now() - interval '30 days'
             GROUP BY body->>'campaign_id'
             ORDER BY max(created_at) DESC
             LIMIT 10
         ) campaign_stats) as recent_campaigns;
END;
$$;

-- Grant execute permissions to authenticated users (authorization is handled within functions)
GRANT EXECUTE ON FUNCTION public.create_system_notification(
    text, text, text, text, text, boolean, timestamp with time zone, text, boolean, text, text, boolean,
    public.app_role[], bigint[], uuid[], uuid
) TO authenticated;

GRANT EXECUTE ON FUNCTION public.delete_system_notifications_by_campaign(text, uuid) TO authenticated;

GRANT EXECUTE ON FUNCTION public.get_system_notification_stats(uuid) TO authenticated;

-- Add RLS policies for admin CRUD operations on notifications
-- Enable RLS on notifications table if not already enabled
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- Admin can view all system notifications
CREATE POLICY "Admins can view all system notifications" ON public.notifications
FOR SELECT
USING (
  body->>'type' = 'system' 
  AND public.authorize_for_admin(auth.uid())
);

-- Admin can delete system notifications
CREATE POLICY "Admins can delete system notifications" ON public.notifications
FOR DELETE
USING (
  body->>'type' = 'system' 
  AND public.authorize_for_admin(auth.uid())
);

-- Admin can update system notifications  
CREATE POLICY "Admins can update system notifications" ON public.notifications
FOR UPDATE
USING (
  body->>'type' = 'system' 
  AND public.authorize_for_admin(auth.uid())
)
WITH CHECK (
  body->>'type' = 'system' 
  AND public.authorize_for_admin(auth.uid())
);

-- Add comments to document the functions
COMMENT ON FUNCTION public.create_system_notification IS 
'Creates system notifications with efficient bulk INSERT...SELECT operations. Supports role, course, and user targeting. Admin authorization required.';

COMMENT ON FUNCTION public.delete_system_notifications_by_campaign IS 
'Bulk deletes system notifications by campaign ID. Admin authorization required.';

COMMENT ON FUNCTION public.get_system_notification_stats IS 
'Returns comprehensive statistics about system notifications for the admin dashboard. Admin authorization required.';

-- 4. Create system_settings table for key-value configuration storage
CREATE TABLE IF NOT EXISTS public.system_settings (
    key text PRIMARY KEY,
    value jsonb NOT NULL DEFAULT '{}',
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid REFERENCES public.users(user_id),
    updated_by uuid REFERENCES public.users(user_id)
);

-- Enable RLS on system_settings
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

-- Only admins can access system settings
CREATE POLICY "Admins can view all system settings" ON public.system_settings
FOR SELECT
USING (public.authorize_for_admin(auth.uid()));

CREATE POLICY "Admins can insert system settings" ON public.system_settings
FOR INSERT
WITH CHECK (public.authorize_for_admin(auth.uid()));

CREATE POLICY "Admins can update system settings" ON public.system_settings
FOR UPDATE
USING (public.authorize_for_admin(auth.uid()))
WITH CHECK (public.authorize_for_admin(auth.uid()));

CREATE POLICY "Admins can delete system settings" ON public.system_settings
FOR DELETE
USING (public.authorize_for_admin(auth.uid()));

-- Add trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    NEW.updated_by = auth.uid();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_system_settings_updated_at 
    BEFORE UPDATE ON public.system_settings 
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 5. Function to send welcome message to new user
CREATE OR REPLACE FUNCTION public.send_signup_welcome_message(
    p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_welcome_setting jsonb;
    v_notification_body jsonb;
    v_user_role_count integer;
BEGIN
    -- Check if user has any roles (i.e., has completed signup process)
    SELECT count(*)::integer INTO v_user_role_count
    FROM public.user_roles
    WHERE user_id = p_user_id;
    
    -- Only send welcome message if user has at least one role
    IF v_user_role_count = 0 THEN
        RETURN false;
    END IF;
    
    -- Get signup welcome message setting
    SELECT value INTO v_welcome_setting
    FROM public.system_settings
    WHERE key = 'signup_welcome_message';
    
    -- If no welcome message configured, return
    IF v_welcome_setting IS NULL THEN
        RETURN false;
    END IF;
    
    -- Build notification body from the setting
    v_notification_body := v_welcome_setting || jsonb_build_object('type', 'system');
    
    -- Insert welcome notification for the new user
    INSERT INTO public.notifications (user_id, class_id, subject, body, created_at)
    SELECT 
        p_user_id,
        ur.class_id,
        jsonb_build_object('title', v_welcome_setting->>'title'),
        v_notification_body,
        now()
    FROM public.user_roles ur
    WHERE ur.user_id = p_user_id
    LIMIT 1; -- Just need one notification per user
    
    RETURN true;
EXCEPTION
    WHEN OTHERS THEN
        -- Log error but don't fail user creation
        RETURN false;
END;
$$;

-- 6. Trigger to automatically send welcome message when user gets their first role
CREATE OR REPLACE FUNCTION public.trigger_signup_welcome_message()
RETURNS TRIGGER AS $$
BEGIN
    -- Check if this is the user's first role
    IF NOT EXISTS (
        SELECT 1 FROM public.user_roles 
        WHERE user_id = NEW.user_id 
        AND id != NEW.id
    ) THEN
        -- Send welcome message asynchronously (don't block if it fails)
        PERFORM public.send_signup_welcome_message(NEW.user_id);
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger on user_roles insert
CREATE TRIGGER send_welcome_message_on_first_role
    AFTER INSERT ON public.user_roles
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_signup_welcome_message();

-- Grant permissions
GRANT EXECUTE ON FUNCTION public.send_signup_welcome_message(uuid) TO authenticated;

-- Add comments
COMMENT ON TABLE public.system_settings IS 
'Key-value storage for system configuration settings. Admin access only.';

COMMENT ON FUNCTION public.send_signup_welcome_message IS 
'Sends configured welcome message to a new user if signup_welcome_message is configured.';

COMMENT ON FUNCTION public.trigger_signup_welcome_message IS 
'Trigger function to automatically send welcome message when user gets their first role.';

-- 7. Update submissionreviewrecompute function to include tweak and only autograde for grading reviews
CREATE OR REPLACE FUNCTION "public"."submissionreviewrecompute"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  calculated_score numeric;
  calculated_autograde_score numeric;
  the_submission submissions%ROWTYPE;
  existing_submission_review_id int8;
  is_grading_review boolean;
  current_tweak numeric;
begin
  calculated_score=0;
  calculated_autograde_score=0;
  
  -- Avoid re-entrant work when our own UPDATEs fire triggers
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;
  
  if 'rubric_check_id' = any(select jsonb_object_keys(to_jsonb(new))) then 
    if  NEW.rubric_check_id is null and (OLD is null OR OLD.rubric_check_id is null) then 
     return NEW;
    end if;
  end if;

  if 'submission_review_id' = any(select jsonb_object_keys(to_jsonb(new))) then 
    -- If the field is there but null, we don't have anything to update.
    if NEW.submission_review_id is null then
      return NEW;
    end if;
    -- The submission review we are calculating is the one on the row
    existing_submission_review_id = NEW.submission_review_id;
  else
    -- The submission review we are calculating is the one on the assignment, make sure it exists
    select grading_review_id into existing_submission_review_id from public.submissions where id=NEW.submission_id;
  end if;

  -- CRITICAL: Add advisory lock to prevent race conditions during concurrent score updates
  -- This ensures only one trigger can update the same submission_review at a time
  perform pg_advisory_xact_lock(existing_submission_review_id);

  -- Check if this is the grading review (connected to a grading review rubric)
  select EXISTS(select 1 from submissions where grading_review_id = existing_submission_review_id) into is_grading_review;

  -- Only include autograde score if this is the grading review
  if is_grading_review then
    select sum(t.score) into calculated_autograde_score from grader_results r 
      inner join grader_result_tests t on t.grader_result_id=r.id
      where r.submission_id=NEW.submission_id;
  end if;

  -- Calculate manual grading score from all comment types
  select sum(score) into calculated_score from (
    select c.id,c.name,
    case
      when c.is_additive then LEAST(COALESCE(sum(comments.points),0),c.total_points)
      else GREATEST(c.total_points - COALESCE(sum(comments.points),0), 0)
      end as score
    from public.submission_reviews sr
    inner join public.rubric_criteria c on c.rubric_id=sr.rubric_id
    inner join public.rubric_checks ch on ch.rubric_criteria_id=c.id
      left join (select sum(sc.points) as points,sc.rubric_check_id from submission_comments sc where sc.submission_review_id=existing_submission_review_id and sc.deleted_at is null and sc.points is not null group by sc.rubric_check_id
      UNION ALL
      select sum(sfc.points) as points,sfc.rubric_check_id from submission_file_comments sfc where sfc.submission_review_id=existing_submission_review_id and sfc.deleted_at is null and sfc.points is not null group by sfc.rubric_check_id
      UNION all
      select sum(sac.points) as points,sac.rubric_check_id from submission_artifact_comments sac where sac.submission_review_id=existing_submission_review_id and sac.deleted_at is null and sac.points is not null group by sac.rubric_check_id
      ) as comments on comments.rubric_check_id=ch.id
    where sr.id=existing_submission_review_id 
     group by c.id) as combo;

  -- Get the current tweak value
  select tweak into current_tweak from submission_reviews where id = existing_submission_review_id;

  -- Handle null scores
  if calculated_score is null then
    calculated_score = 0;
  end if;
  if calculated_autograde_score is null then
    calculated_autograde_score = 0;
  end if;
  if current_tweak is null then
    current_tweak = 0;
  end if;

  -- Update the submission review with the calculated total score including tweak
  -- The advisory lock ensures this update is atomic and prevents lost updates
  UPDATE public.submission_reviews 
  SET total_score=calculated_score+calculated_autograde_score+current_tweak,
      total_autograde_score=calculated_autograde_score 
  WHERE id=existing_submission_review_id;

  return NEW;
end;
$$;

-- 8. Create trigger for submission_reviews tweak changes to recalculate total_score
CREATE OR REPLACE TRIGGER "submission_review_tweak_recalculate_total_score" 
    AFTER UPDATE OF "tweak" ON "public"."submission_reviews" 
    FOR EACH ROW EXECUTE FUNCTION "public"."submissionreviewrecompute"();

-- Grant execute permissions on the updated function
GRANT EXECUTE ON FUNCTION "public"."submissionreviewrecompute"() TO authenticated;
GRANT EXECUTE ON FUNCTION "public"."submissionreviewrecompute"() TO service_role;

-- Add comments for the new functionality
COMMENT ON FUNCTION "public"."submissionreviewrecompute" IS 
'Recalculates submission review total scores including manual grading, autograde (only for grading reviews), and instructor tweaks. Uses advisory locks to prevent race conditions.';

COMMENT ON TRIGGER "submission_review_tweak_recalculate_total_score" ON "public"."submission_reviews" IS 
'Automatically recalculates total_score when instructor tweak is modified.';
