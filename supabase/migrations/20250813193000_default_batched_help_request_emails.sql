--
-- Migration: default_batched_help_request_emails
-- Purpose:
--   - Change default behavior for help request notifications so that on creation
--     we notify instructors and graders only (not the entire class)
--   - Enrich help request notification payloads with request_subject and request_body
--   - Reduce duplicate notifications by avoiding overlap with watcher-based flows
--   - Enable future batched email digests to consume these notifications cleanly
--
-- Notes:
--   - This migration updates the existing function public.create_help_request_notification
--   - The emailer will aggregate these notifications for instructors/graders
--     into a digest instead of sending individual immediate emails
--   - Rationale: Prevent inbox flooding and align with default "digest" preferences
--

create or replace function public.create_help_request_notification(
  p_class_id bigint,
  p_notification_type text,
  p_help_request_id bigint,
  p_help_queue_id bigint,
  p_help_queue_name text,
  p_creator_profile_id uuid,
  p_creator_name text,
  p_assignee_profile_id uuid default null::uuid,
  p_assignee_name text default null::text,
  p_status public.help_request_status default null::public.help_request_status,
  p_request_preview text default ''::text,
  p_is_private boolean default false,
  p_action text default 'created'::text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  notification_body jsonb;
begin
  if p_notification_type = 'help_request' then
    notification_body := jsonb_build_object(
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
      -- Enrich with subject/body for email templates and digests
      'request_subject', coalesce(
        (
          select hrt.name
          from public.help_request_templates hrt
          where hrt.id = (
            select hr.template_id from public.help_requests hr where hr.id = p_help_request_id
          )
        ),
        'General'
      ),
      'request_body', (
        select hr.request from public.help_requests hr where hr.id = p_help_request_id
      ),
      'is_private', p_is_private
    );
  end if;

  -- On creation: notify instructors and graders only (do NOT blast the entire class)
  if p_action = 'created' then
    insert into public.notifications (user_id, class_id, subject, body)
    select distinct
      ur.user_id,
      p_class_id,
      jsonb_build_object('text', 'Help Request ' || p_action),
      notification_body
    from public.user_roles ur
    where ur.class_id = p_class_id
      and ur.role in ('instructor', 'grader');

    -- Ensure the creator is watching their own request
    insert into public.help_request_watchers (user_id, help_request_id, class_id, enabled)
    select ur.user_id, p_help_request_id, p_class_id, true
    from public.user_roles ur
    where ur.private_profile_id = p_creator_profile_id
      and ur.class_id = p_class_id
    on conflict (user_id, help_request_id) do nothing;

  else
    -- For assignment/status changes: notify watchers
    insert into public.notifications (user_id, class_id, subject, body)
    select 
      hrw.user_id,
      p_class_id,
      jsonb_build_object('text', 'Help Request ' || p_action),
      notification_body
    from public.help_request_watchers hrw
    join public.user_roles ur on ur.user_id = hrw.user_id and ur.class_id = p_class_id
    where hrw.help_request_id = p_help_request_id
      and hrw.enabled = true
      and (
        -- For private requests, only notify instructors, graders, creator, and assignee
        (p_is_private and ur.role in ('instructor', 'grader'))
        or (p_is_private and ur.private_profile_id = p_creator_profile_id)
        or (p_is_private and ur.private_profile_id = p_assignee_profile_id)
        -- For public requests, notify all watching users
        or not p_is_private
      );
  end if;
end;
$$;

comment on function public.create_help_request_notification(
  bigint, text, bigint, bigint, text, uuid, text, uuid, text, public.help_request_status, text, boolean, text
) is 'On creation, only notify instructors and graders; enrich payload with subject/body; watcher-based notifications used for updates.';


