-- Migration: Fix help request notification triggers for group support
-- Purpose: Update triggers for help request notifications to work with the new
--          many-to-many help_request_students relationship.

-- 1. Drop the old trigger on help_requests for creation events.
--    This is being replaced by a trigger on help_request_students.
DROP TRIGGER IF EXISTS help_request_created_trigger ON public.help_requests;
DROP FUNCTION IF EXISTS public.trigger_help_request_created();

-- 2. Update the trigger function for help_request updates.
--    It now fetches one of the students from the group to act as the "creator" for the notification.
CREATE OR REPLACE FUNCTION public.trigger_help_request_updated()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  queue_name text;
  creator_profile_id uuid;
  creator_name text;
  assignee_name text;
  request_preview text;
BEGIN
  -- Only proceed if status or assignee changed
  IF OLD.status IS NOT DISTINCT FROM NEW.status AND OLD.assignee IS NOT DISTINCT FROM NEW.assignee THEN
    RETURN NEW;
  END IF;
  
  SELECT name INTO queue_name FROM public.help_queues WHERE id = NEW.help_queue;
  
  -- Get one student from the group to represent the "creator" for the notification
  SELECT profile_id INTO creator_profile_id FROM public.help_request_students WHERE help_request_id = NEW.id LIMIT 1;
  SELECT name INTO creator_name FROM public.profiles WHERE id = creator_profile_id;
  
  request_preview := LEFT(NEW.request, 100);
  IF LENGTH(NEW.request) > 100 THEN
    request_preview := request_preview || '...';
  END IF;
  
  -- Handle assignment changes
  IF OLD.assignee IS DISTINCT FROM NEW.assignee AND NEW.assignee IS NOT NULL THEN
    SELECT name INTO assignee_name FROM public.profiles WHERE id = NEW.assignee;
    
    PERFORM public.create_help_request_notification(
      NEW.class_id, 'help_request', NEW.id, NEW.help_queue,
      COALESCE(queue_name, 'Unknown Queue'), creator_profile_id,
      COALESCE(creator_name, 'Unknown User'), NEW.assignee,
      COALESCE(assignee_name, 'Unknown User'), NEW.status, request_preview,
      NEW.is_private, 'assigned'
    );
  END IF;
  
  -- Handle status changes  
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF NEW.assignee IS NOT NULL THEN
      SELECT name INTO assignee_name FROM public.profiles WHERE id = NEW.assignee;
    END IF;
    
    PERFORM public.create_help_request_notification(
      NEW.class_id, 'help_request', NEW.id, NEW.help_queue,
      COALESCE(queue_name, 'Unknown Queue'), creator_profile_id,
      COALESCE(creator_name, 'Unknown User'), NEW.assignee,
      assignee_name, NEW.status, request_preview,
      NEW.is_private, 'status_changed'
    );
  END IF;
  
  RETURN NEW;
END;
$$;

-- 3. Create a new trigger function that fires when a student is added to a help request.
CREATE OR REPLACE FUNCTION public.trigger_help_request_student_added()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  student_count int;
  queue_name text;
  creator_name text;
  request_preview text;
  help_request public.help_requests%ROWTYPE;
BEGIN
  -- Check if this is the first student being added to this help request
  SELECT count(*) INTO student_count FROM public.help_request_students WHERE help_request_id = NEW.help_request_id;
  
  IF student_count = 1 THEN
    -- This is the "creation" event from a notification perspective
    SELECT * INTO help_request FROM public.help_requests WHERE id = NEW.help_request_id;
    
    SELECT name INTO queue_name FROM public.help_queues WHERE id = help_request.help_queue;
    SELECT name INTO creator_name FROM public.profiles WHERE id = NEW.profile_id;
    
    request_preview := LEFT(help_request.request, 100);
    IF LENGTH(help_request.request) > 100 THEN
      request_preview := request_preview || '...';
    END IF;
    
    PERFORM public.create_help_request_notification(
      help_request.class_id,
      'help_request',
      help_request.id,
      help_request.help_queue,
      COALESCE(queue_name, 'Unknown Queue'),
      NEW.profile_id, -- The first student is the "creator"
      COALESCE(creator_name, 'Unknown User'),
      NULL,
      NULL,
      help_request.status,
      request_preview,
      help_request.is_private,
      'created'
    );
  END IF;
  
  RETURN NEW;
END;
$$;

-- 4. Create the new trigger on the help_request_students table.
DROP TRIGGER IF EXISTS help_request_student_added_trigger ON public.help_request_students;
CREATE TRIGGER help_request_student_added_trigger
  AFTER INSERT ON public.help_request_students
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_help_request_student_added(); 