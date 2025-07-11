-- Migration: Fix help request message notification trigger for group support
-- Purpose: Update the trigger for new help request messages to work with the new
--          many-to-many help_request_students relationship.

-- 1. Update the trigger function for help_request_messages inserts.
--    It now fetches one of the students from the group to act as the "creator" for the notification.
CREATE OR REPLACE FUNCTION public.trigger_help_request_message_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  help_request_row public.help_requests%ROWTYPE;
  queue_name text;
  author_name text;
  creator_profile_id uuid;
  creator_name text;
  message_preview text;
BEGIN
  -- Get help request details
  SELECT * INTO help_request_row FROM public.help_requests WHERE id = NEW.help_request_id;
  
  -- Get one student from the group to represent the "creator" for the notification
  SELECT profile_id INTO creator_profile_id FROM public.help_request_students WHERE help_request_id = NEW.help_request_id LIMIT 1;
  
  -- Get related data
  SELECT name INTO queue_name FROM public.help_queues WHERE id = help_request_row.help_queue;
  SELECT name INTO author_name FROM public.profiles WHERE id = NEW.author;
  SELECT name INTO creator_name FROM public.profiles WHERE id = creator_profile_id;
  
  -- Create message preview
  message_preview := LEFT(NEW.message, 100);
  IF LENGTH(NEW.message) > 100 THEN
    message_preview := message_preview || '...';
  END IF;
  
  -- Create notification
  PERFORM public.create_help_request_message_notification(
    NEW.class_id,
    NEW.help_request_id,
    help_request_row.help_queue,
    COALESCE(queue_name, 'Unknown Queue'),
    NEW.id,
    NEW.author,
    COALESCE(author_name, 'Unknown User'),
    message_preview,
    creator_profile_id,
    COALESCE(creator_name, 'Unknown User'),
    help_request_row.is_private
  );
  
  RETURN NEW;
END;
$$; 