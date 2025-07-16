-- Migration: Add realtime broadcast triggers for chat messages and read receipts
-- Purpose: Automatically broadcast chat events when database rows are inserted
-- This replaces manual broadcasting from the client-side React hook

-- Function to broadcast help request messages
create or replace function public.broadcast_help_request_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  user_profile record;
  broadcast_payload jsonb;
begin
  -- Get user profile information for the message author
  select 
    profiles.name,
    users.user_id as auth_user_id
  into user_profile
  from public.profiles
  left join public.user_roles on profiles.id = user_roles.private_profile_id
  left join public.users on user_roles.user_id = users.user_id
  where profiles.id = new.author
  limit 1;

  -- Construct the broadcast payload matching the frontend BroadcastMessage interface
  broadcast_payload := jsonb_build_object(
    'id', new.id::text,
    'content', new.message,
    'user', jsonb_build_object(
      'id', coalesce(user_profile.auth_user_id, new.author),
      'name', coalesce(user_profile.name, 'Unknown User')
    ),
    'createdAt', new.created_at,
    'replyToMessageId', new.reply_to_message_id,
    'helpRequestId', new.help_request_id,
    'classId', new.class_id
  );

  -- Log the broadcast attempt (for debugging)
  raise notice 'Broadcasting message: id=%, author=%, help_request_id=%, payload=%', 
    new.id, new.author, new.help_request_id, broadcast_payload;

  -- Broadcast the message to the help request channel
  begin
    perform realtime.send(
      broadcast_payload,
      'message', -- event name
      'help_request_' || new.help_request_id::text, -- topic/channel name
      false -- public flag
    );
  exception when others then
    -- Log broadcast errors but don't fail the transaction
    raise warning 'Failed to broadcast message: %, Error: %', broadcast_payload, sqlerrm;
  end;

  return new;
end;
$$;

-- Function to broadcast read receipts
create or replace function public.broadcast_read_receipt()
returns trigger
language plpgsql
security definer                    
set search_path = ''
as $$
declare
  user_profile record;
  broadcast_payload jsonb;
  help_request_id bigint;
begin
  -- Get user profile information for the receipt viewer
  select 
    profiles.name,
    users.user_id as auth_user_id
  into user_profile
  from public.profiles
  left join public.user_roles on profiles.id = user_roles.private_profile_id
  left join public.users on user_roles.user_id = users.user_id
  where profiles.id = new.viewer_id
  limit 1;

  -- Get the help request ID from the message to determine the correct channel
  select hrm.help_request_id into help_request_id
  from public.help_request_messages hrm
  where hrm.id = new.message_id;

  -- Log if we can't find the help request ID (for debugging)
  if help_request_id is null then
    raise warning 'Could not find help_request_id for message_id: %, viewer_id: %', new.message_id, new.viewer_id;
    return new; -- Still return successfully to not block the insert
  end if;

  -- Construct the broadcast payload matching the frontend BroadcastReadReceipt interface
  broadcast_payload := jsonb_build_object(
    'id', new.id::text,
    'messageId', new.message_id,
    'userId', coalesce(user_profile.auth_user_id, new.viewer_id),
    'userName', coalesce(user_profile.name, 'Unknown User'),
    'classId', new.class_id,
    'createdAt', new.created_at
  );

  -- Log the broadcast attempt (for debugging)
  raise notice 'Broadcasting read receipt: message_id=%, viewer_id=%, help_request_id=%, payload=%', 
    new.message_id, new.viewer_id, help_request_id, broadcast_payload;

  -- Broadcast the read receipt to the help request channel
  begin
    perform realtime.send(
      broadcast_payload,
      'read_receipt', -- event name
      'help_request_' || help_request_id::text, -- topic/channel name
      false -- public flag
    );
  exception when others then
    -- Log broadcast errors but don't fail the transaction
    raise warning 'Failed to broadcast read receipt: %, Error: %', broadcast_payload, sqlerrm;
  end;

  return new;
end;
$$;

-- Create trigger for help request messages
create trigger broadcast_help_request_message_trigger
after insert on public.help_request_messages
for each row
execute function public.broadcast_help_request_message();

-- Create trigger for read receipts
create trigger broadcast_read_receipt_trigger
after insert on public.help_request_message_read_receipts
for each row
execute function public.broadcast_read_receipt();

-- Add comments explaining the triggers
comment on function public.broadcast_help_request_message() is 'Automatically broadcasts help request messages to realtime channels when inserted into the database';
comment on function public.broadcast_read_receipt() is 'Automatically broadcasts read receipts to realtime channels when inserted into the database';
comment on trigger broadcast_help_request_message_trigger on public.help_request_messages is 'Triggers realtime broadcast when a new help request message is inserted';
comment on trigger broadcast_read_receipt_trigger on public.help_request_message_read_receipts is 'Triggers realtime broadcast when a new read receipt is inserted'; 