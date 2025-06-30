-- Migration for help request notifications
-- This creates functions and triggers to automatically generate notifications for help request events

-- Function to create help request notifications
CREATE OR REPLACE FUNCTION create_help_request_notification(
  p_class_id bigint,
  p_notification_type text,
  p_help_request_id bigint,
  p_help_queue_id bigint,
  p_help_queue_name text,
  p_creator_profile_id uuid,
  p_creator_name text,
  p_assignee_profile_id uuid DEFAULT NULL,
  p_assignee_name text DEFAULT NULL,
  p_status help_request_status DEFAULT NULL,
  p_request_preview text DEFAULT '',
  p_is_private boolean DEFAULT false,
  p_action text DEFAULT 'created'
) RETURNS void AS $$
DECLARE
  notification_body jsonb;
  target_user_id uuid;
  user_role text;
BEGIN
  -- Build notification body based on type
  IF p_notification_type = 'help_request' THEN
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
  END IF;

  -- Send notifications to different user groups based on action and privacy
  FOR target_user_id, user_role IN
    SELECT DISTINCT ur.user_id, ur.role
    FROM user_roles ur
    WHERE ur.class_id = p_class_id
      AND (
        -- For private requests, only notify instructors, graders, creator, and assignee
        (p_is_private AND ur.role IN ('instructor', 'grader'))
        OR (p_is_private AND ur.private_profile_id = p_creator_profile_id)
        OR (p_is_private AND ur.private_profile_id = p_assignee_profile_id)
        -- For public requests, notify everyone except the creator for 'created' action
        OR (NOT p_is_private AND (p_action != 'created' OR ur.private_profile_id != p_creator_profile_id))
      )
  LOOP
    INSERT INTO notifications (user_id, class_id, subject, body)
    VALUES (
      target_user_id,
      p_class_id,
      jsonb_build_object('text', 'Help Request ' || p_action),
      notification_body
    );
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Function to create help request message notifications
CREATE OR REPLACE FUNCTION create_help_request_message_notification(
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
  p_is_private boolean DEFAULT false
) RETURNS void AS $$
DECLARE
  notification_body jsonb;
  target_user_id uuid;
  user_role text;
  ta_is_working boolean;
BEGIN
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
  FOR target_user_id, user_role IN
    SELECT DISTINCT ur.user_id, ur.role
    FROM user_roles ur
    LEFT JOIN help_queue_assignments hqa ON hqa.ta_profile_id = ur.private_profile_id 
      AND hqa.help_queue_id = p_help_queue_id 
      AND hqa.is_active = true
    WHERE ur.class_id = p_class_id
      AND ur.private_profile_id != p_author_profile_id -- Don't notify the message author
      AND (
        -- Always notify instructors and graders
        ur.role IN ('instructor', 'grader')
        -- Always notify the help request creator
        OR ur.private_profile_id = p_help_request_creator_profile_id
        -- For public requests, notify students too (unless private)
        OR (NOT p_is_private AND ur.role = 'student')
        -- Notify TAs who are actively working this queue
        OR hqa.id IS NOT NULL
      )
  LOOP
    INSERT INTO notifications (user_id, class_id, subject, body)
    VALUES (
      target_user_id,
      p_class_id,
      jsonb_build_object('text', 'New message in help request'),
      notification_body
    );
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Trigger function for new help requests
CREATE OR REPLACE FUNCTION trigger_help_request_created() RETURNS trigger AS $$
DECLARE
  queue_name text;
  creator_name text;
  request_preview text;
BEGIN
  -- Get queue name
  SELECT name INTO queue_name FROM help_queues WHERE id = NEW.help_queue;
  
  -- Get creator name
  SELECT name INTO creator_name FROM profiles WHERE id = NEW.creator;
  
  -- Create preview of request (first 100 characters)
  request_preview := LEFT(NEW.request, 100);
  IF LENGTH(NEW.request) > 100 THEN
    request_preview := request_preview || '...';
  END IF;
  
  -- Create notification
  PERFORM create_help_request_notification(
    NEW.class_id,
    'help_request',
    NEW.id,
    NEW.help_queue,
    COALESCE(queue_name, 'Unknown Queue'),
    NEW.creator,
    COALESCE(creator_name, 'Unknown User'),
    NULL,
    NULL,
    NEW.status,
    request_preview,
    NEW.is_private,
    'created'
  );
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger function for help request status changes
CREATE OR REPLACE FUNCTION trigger_help_request_updated() RETURNS trigger AS $$
DECLARE
  queue_name text;
  creator_name text;
  assignee_name text;
  request_preview text;
BEGIN
  -- Only proceed if status or assignee changed
  IF OLD.status = NEW.status AND OLD.assignee = NEW.assignee THEN
    RETURN NEW;
  END IF;
  
  -- Get related data
  SELECT name INTO queue_name FROM help_queues WHERE id = NEW.help_queue;
  SELECT name INTO creator_name FROM profiles WHERE id = NEW.creator;
  
  request_preview := LEFT(NEW.request, 100);
  IF LENGTH(NEW.request) > 100 THEN
    request_preview := request_preview || '...';
  END IF;
  
  -- Handle assignment changes
  IF OLD.assignee IS DISTINCT FROM NEW.assignee AND NEW.assignee IS NOT NULL THEN
    SELECT name INTO assignee_name FROM profiles WHERE id = NEW.assignee;
    
    PERFORM create_help_request_notification(
      NEW.class_id,
      'help_request',
      NEW.id,
      NEW.help_queue,
      COALESCE(queue_name, 'Unknown Queue'),
      NEW.creator,
      COALESCE(creator_name, 'Unknown User'),
      NEW.assignee,
      COALESCE(assignee_name, 'Unknown User'),
      NEW.status,
      request_preview,
      NEW.is_private,
      'assigned'
    );
  END IF;
  
  -- Handle status changes  
  IF OLD.status != NEW.status THEN
    IF NEW.assignee IS NOT NULL THEN
      SELECT name INTO assignee_name FROM profiles WHERE id = NEW.assignee;
    END IF;
    
    PERFORM create_help_request_notification(
      NEW.class_id,
      'help_request',
      NEW.id,
      NEW.help_queue,
      COALESCE(queue_name, 'Unknown Queue'),
      NEW.creator,
      COALESCE(creator_name, 'Unknown User'),
      NEW.assignee,
      assignee_name,
      NEW.status,
      request_preview,
      NEW.is_private,
      'status_changed'
    );
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger function for new help request messages
CREATE OR REPLACE FUNCTION trigger_help_request_message_created() RETURNS trigger AS $$
DECLARE
  help_request_row help_requests%ROWTYPE;
  queue_name text;
  author_name text;
  creator_name text;
  message_preview text;
BEGIN
  -- Get help request details
  SELECT * INTO help_request_row FROM help_requests WHERE id = NEW.help_request_id;
  
  -- Get related data
  SELECT name INTO queue_name FROM help_queues WHERE id = help_request_row.help_queue;
  SELECT name INTO author_name FROM profiles WHERE id = NEW.author;
  SELECT name INTO creator_name FROM profiles WHERE id = help_request_row.creator;
  
  -- Create message preview
  message_preview := LEFT(NEW.message, 100);
  IF LENGTH(NEW.message) > 100 THEN
    message_preview := message_preview || '...';
  END IF;
  
  -- Create notification
  PERFORM create_help_request_message_notification(
    NEW.class_id,
    NEW.help_request_id,
    help_request_row.help_queue,
    COALESCE(queue_name, 'Unknown Queue'),
    NEW.id,
    NEW.author,
    COALESCE(author_name, 'Unknown User'),
    message_preview,
    help_request_row.creator,
    COALESCE(creator_name, 'Unknown User'),
    help_request_row.is_private
  );
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers
DROP TRIGGER IF EXISTS help_request_created_trigger ON help_requests;
CREATE TRIGGER help_request_created_trigger
  AFTER INSERT ON help_requests
  FOR EACH ROW
  EXECUTE FUNCTION trigger_help_request_created();

DROP TRIGGER IF EXISTS help_request_updated_trigger ON help_requests;  
CREATE TRIGGER help_request_updated_trigger
  AFTER UPDATE ON help_requests
  FOR EACH ROW
  EXECUTE FUNCTION trigger_help_request_updated();

DROP TRIGGER IF EXISTS help_request_message_created_trigger ON help_request_messages;
CREATE TRIGGER help_request_message_created_trigger
  AFTER INSERT ON help_request_messages
  FOR EACH ROW
  EXECUTE FUNCTION trigger_help_request_message_created(); 