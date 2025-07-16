-- Fix notification functions to use SECURITY DEFINER
-- This allows the functions to insert notifications with elevated permissions

-- Function to create help request notifications (with SECURITY DEFINER)
create or replace function create_help_request_notification(
  p_class_id bigint,
  p_notification_type text,
  p_help_request_id bigint,
  p_help_queue_id bigint,
  p_help_queue_name text,
  p_creator_profile_id uuid,
  p_creator_name text,
  p_assignee_profile_id uuid default null,
  p_assignee_name text default null,
  p_status help_request_status default null,
  p_request_preview text default '',
  p_is_private boolean default false,
  p_action text default 'created'
) returns void
language plpgsql
security definer  -- Run with function owner's permissions
set search_path = ''  -- Security best practice
as $$
declare
  notification_body jsonb;
  target_user_id uuid;
  user_role text;
begin
  -- Build notification body based on type
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
      'is_private', p_is_private
    );
  end if;

  -- Send notifications to different user groups based on action and privacy
  for target_user_id, user_role in
    select distinct ur.user_id, ur.role
    from public.user_roles ur
    where ur.class_id = p_class_id
      and (
        -- For private requests, only notify instructors, graders, creator, and assignee
        (p_is_private and ur.role in ('instructor', 'grader'))
        or (p_is_private and ur.private_profile_id = p_creator_profile_id)
        or (p_is_private and ur.private_profile_id = p_assignee_profile_id)
        -- For public requests, notify everyone except the creator for 'created' action
        or (not p_is_private and (p_action != 'created' or ur.private_profile_id != p_creator_profile_id))
      )
  loop
    insert into public.notifications (user_id, class_id, subject, body)
    values (
      target_user_id,
      p_class_id,
      jsonb_build_object('text', 'Help Request ' || p_action),
      notification_body
    );
  end loop;
end;
$$;

-- Function to create help request message notifications (with SECURITY DEFINER)
create or replace function create_help_request_message_notification(
  p_class_id bigint,
  p_help_request_id bigint,
  p_help_queue_id bigint,
  p_help_queue_name text,
  p_message_id bigint,
  p_author_profile_id uuid,
  p_author_name text,
  p_message_preview text,
  p_help_request_creator_profile_id uuid,
  p_help_request_creator_name text,
  p_is_private boolean default false
) returns void
language plpgsql
security definer  -- Run with function owner's permissions
set search_path = ''  -- Security best practice
as $$
declare
  notification_body jsonb;
  target_user_id uuid;
  user_role text;
  ta_is_working boolean;
begin
  -- Build notification body
  notification_body := jsonb_build_object(
    'type', 'help_request_message',
    'help_request_id', p_help_request_id,
    'help_queue_id', p_help_queue_id,
    'help_queue_name', p_help_queue_name,
    'message_id', p_message_id,
    'author_profile_id', p_author_profile_id,
    'author_name', p_author_name,
    'message_preview', p_message_preview,
    'help_request_creator_profile_id', p_help_request_creator_profile_id,
    'help_request_creator_name', p_help_request_creator_name,
    'is_private', p_is_private
  );

  -- Send notifications based on privacy and user roles
  for target_user_id, user_role in
    select distinct ur.user_id, ur.role
    from public.user_roles ur
    left join public.help_queue_assignments hqa on hqa.ta_profile_id = ur.private_profile_id 
      and hqa.help_queue_id = p_help_queue_id 
      and hqa.is_active = true
    where ur.class_id = p_class_id
      and ur.private_profile_id != p_author_profile_id -- Don't notify the message author
      and (
        -- Always notify instructors and graders
        ur.role in ('instructor', 'grader')
        -- Always notify the help request creator
        or ur.private_profile_id = p_help_request_creator_profile_id
        -- For public requests, notify students too (unless private)
        or (not p_is_private and ur.role = 'student')
        -- Notify TAs who are actively working this queue
        or hqa.id is not null
      )
  loop
    insert into public.notifications (user_id, class_id, subject, body)
    values (
      target_user_id,
      p_class_id,
      jsonb_build_object('text', 'New message in help request'),
      notification_body
    );
  end loop;
end;
$$;

-- Update trigger functions to also use SECURITY DEFINER for consistency
create or replace function trigger_help_request_created() 
returns trigger 
language plpgsql
security definer
set search_path = ''
as $$
declare
  queue_name text;
  creator_name text;
  request_preview text;
begin
  -- Get queue name
  select name into queue_name from public.help_queues where id = new.help_queue;
  
  -- Get creator name
  select name into creator_name from public.profiles where id = new.creator;
  
  -- Create preview of request (first 100 characters)
  request_preview := left(new.request, 100);
  if length(new.request) > 100 then
    request_preview := request_preview || '...';
  end if;
  
  -- Create notification
  perform public.create_help_request_notification(
    new.class_id,
    'help_request',
    new.id,
    new.help_queue,
    coalesce(queue_name, 'Unknown Queue'),
    new.creator,
    coalesce(creator_name, 'Unknown User'),
    null,
    null,
    new.status,
    request_preview,
    new.is_private,
    'created'
  );
  
  return new;
end;
$$;

create or replace function trigger_help_request_updated() 
returns trigger 
language plpgsql
security definer
set search_path = ''
as $$
declare
  queue_name text;
  creator_name text;
  assignee_name text;
  request_preview text;
begin
  -- Only proceed if status or assignee changed
  if old.status = new.status and old.assignee = new.assignee then
    return new;
  end if;
  
  -- Get related data
  select name into queue_name from public.help_queues where id = new.help_queue;
  select name into creator_name from public.profiles where id = new.creator;
  
  request_preview := left(new.request, 100);
  if length(new.request) > 100 then
    request_preview := request_preview || '...';
  end if;
  
  -- Handle assignment changes
  if old.assignee is distinct from new.assignee and new.assignee is not null then
    select name into assignee_name from public.profiles where id = new.assignee;
    
    perform public.create_help_request_notification(
      new.class_id,
      'help_request',
      new.id,
      new.help_queue,
      coalesce(queue_name, 'Unknown Queue'),
      new.creator,
      coalesce(creator_name, 'Unknown User'),
      new.assignee,
      coalesce(assignee_name, 'Unknown User'),
      new.status,
      request_preview,
      new.is_private,
      'assigned'
    );
  end if;
  
  -- Handle status changes  
  if old.status != new.status then
    if new.assignee is not null then
      select name into assignee_name from public.profiles where id = new.assignee;
    end if;
    
    perform public.create_help_request_notification(
      new.class_id,
      'help_request',
      new.id,
      new.help_queue,
      coalesce(queue_name, 'Unknown Queue'),
      new.creator,
      coalesce(creator_name, 'Unknown User'),
      new.assignee,
      assignee_name,
      new.status,
      request_preview,
      new.is_private,
      'status_changed'
    );
  end if;
  
  return new;
end;
$$;

create or replace function trigger_help_request_message_created() 
returns trigger 
language plpgsql
security definer
set search_path = ''
as $$
declare
  help_request_row public.help_requests%rowtype;
  queue_name text;
  author_name text;
  creator_name text;
  message_preview text;
begin
  -- Get help request details
  select * into help_request_row from public.help_requests where id = new.help_request_id;
  
  -- Get related data
  select name into queue_name from public.help_queues where id = help_request_row.help_queue;
  select name into author_name from public.profiles where id = new.author;
  select name into creator_name from public.profiles where id = help_request_row.creator;
  
  -- Create message preview
  message_preview := left(new.message, 100);
  if length(new.message) > 100 then
    message_preview := message_preview || '...';
  end if;
  
  -- Create notification
  perform public.create_help_request_message_notification(
    new.class_id,
    new.help_request_id,
    help_request_row.help_queue,
    coalesce(queue_name, 'Unknown Queue'),
    new.id,
    new.author,
    coalesce(author_name, 'Unknown User'),
    message_preview,
    help_request_row.creator,
    coalesce(creator_name, 'Unknown User'),
    help_request_row.is_private
  );
  
  return new;
end;
$$; 