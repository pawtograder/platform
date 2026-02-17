-- Help Request Resolution Status
-- Adds resolution_status to help_requests table for tracking how requests were resolved
-- Allows students to indicate whether they solved it themselves, got help, ran out of time, etc.

-- 1. Create enum type for resolution status
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'help_request_resolution_status') THEN
    CREATE TYPE public.help_request_resolution_status AS ENUM (
      'self_solved',      -- Student solved the problem themselves
      'staff_helped',     -- Staff (TA/Instructor) helped resolve
      'peer_helped',      -- Another student or peer helped
      'no_time',          -- Student ran out of time to wait
      'other'             -- Other reason
    );
  END IF;
END $$;

-- 2. Add resolution_status column to help_requests table
ALTER TABLE public.help_requests 
ADD COLUMN IF NOT EXISTS resolution_status public.help_request_resolution_status;

-- 3. Add resolution_notes column for optional text explanation (especially for 'other')
ALTER TABLE public.help_requests 
ADD COLUMN IF NOT EXISTS resolution_notes TEXT;

-- 4. Create function to add system message when request is resolved with status
CREATE OR REPLACE FUNCTION public.add_resolution_system_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_status_text text;
  v_resolved_by_name text;
  v_message_text text;
BEGIN
  -- Only trigger when resolution_status is set and request is being resolved
  IF NEW.resolution_status IS NOT NULL 
     AND OLD.resolution_status IS NULL 
     AND NEW.status IN ('resolved', 'closed')
     AND OLD.status NOT IN ('resolved', 'closed') THEN
    
    -- Map resolution status to human-readable text
    v_status_text := CASE NEW.resolution_status
      WHEN 'self_solved' THEN 'solved the problem themselves'
      WHEN 'staff_helped' THEN 'was helped by staff'
      WHEN 'peer_helped' THEN 'was helped by a peer'
      WHEN 'no_time' THEN 'ran out of time to wait'
      WHEN 'other' THEN 'resolved for another reason'
      ELSE 'was resolved'
    END;

    -- Get the name of who resolved it
    IF NEW.resolved_by IS NOT NULL THEN
      SELECT name INTO v_resolved_by_name 
      FROM public.profiles 
      WHERE id = NEW.resolved_by;
    END IF;

    -- Construct the message
    IF v_resolved_by_name IS NOT NULL THEN
      v_message_text := format('📋 **Request Resolved**: %s %s', v_resolved_by_name, v_status_text);
    ELSE
      v_message_text := format('📋 **Request Resolved**: Student %s', v_status_text);
    END IF;

    -- Add resolution notes if provided
    IF NEW.resolution_notes IS NOT NULL AND NEW.resolution_notes != '' THEN
      v_message_text := v_message_text || format(E'\n> %s', NEW.resolution_notes);
    END IF;

    -- Insert system message into help_request_messages
    INSERT INTO public.help_request_messages (
      help_request_id,
      class_id,
      author,
      message,
      is_system_message
    ) VALUES (
      NEW.id,
      NEW.class_id,
      NEW.resolved_by,
      v_message_text,
      true
    );
  END IF;

  RETURN NEW;
END;
$$;

-- 5. Create trigger for adding resolution system message
DROP TRIGGER IF EXISTS help_requests_resolution_message_tr ON public.help_requests;

CREATE TRIGGER help_requests_resolution_message_tr
AFTER UPDATE OF resolution_status, status ON public.help_requests
FOR EACH ROW
EXECUTE FUNCTION public.add_resolution_system_message();

-- 6. Add is_system_message column to help_request_messages if it doesn't exist
ALTER TABLE public.help_request_messages 
ADD COLUMN IF NOT EXISTS is_system_message BOOLEAN DEFAULT FALSE;

-- 7. Update the help_request_feedback table to link with resolution (optional - for analytics)
-- This allows correlating feedback with how the request was resolved
-- No change needed to the table structure, but we can use a view for analytics
