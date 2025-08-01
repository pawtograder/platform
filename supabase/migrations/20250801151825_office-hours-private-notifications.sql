-- Add created_by to help_requests table
ALTER TABLE "public"."help_requests" ADD COLUMN "created_by" uuid;

-- Add help_request_id to help_request_message_read_receipts table
ALTER TABLE "public"."help_request_message_read_receipts" ADD COLUMN "help_request_id" bigint;

-- Add foreign key constraints
ALTER TABLE "public"."help_requests" 
ADD CONSTRAINT "help_requests_created_by_fkey"
FOREIGN KEY (created_by) REFERENCES profiles(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "public"."help_request_message_read_receipts" 
ADD CONSTRAINT "help_request_message_read_receipts_help_request_id_fkey"
FOREIGN KEY (help_request_id) REFERENCES help_requests(id) ON UPDATE CASCADE ON DELETE CASCADE;

-- Drop existing RLS policies for help_requests
DROP POLICY IF EXISTS "Students can view help requests in their class" ON "public"."help_requests";

-- Create new RLS policy for help_requests that includes created_by access
CREATE POLICY "Students can view help requests in their class with creator access"
ON "public"."help_requests"
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (
  authorizeforclassgrader(class_id) OR 
  ((NOT is_private) AND authorizeforclass(class_id)) OR 
  (is_private AND (authorizeforprofile(assignee))) OR 
  (is_private AND user_is_in_help_request(id)) OR
  (is_private AND authorizeforprofile(created_by))
);

-- Drop existing RLS policies for help_request_message_read_receipts
DROP POLICY IF EXISTS "Users can create read receipts for accessible help requests" ON "public"."help_request_message_read_receipts";
DROP POLICY IF EXISTS "Users can view read receipts for accessible help requests" ON "public"."help_request_message_read_receipts";

-- Create more efficient RLS policies for help_request_message_read_receipts using direct help_request_id
CREATE POLICY "Users can create read receipts for accessible help requests via help_request_id"
ON "public"."help_request_message_read_receipts"
AS PERMISSIVE
FOR INSERT
TO authenticated
WITH CHECK (can_access_help_request(help_request_id));

CREATE POLICY "Users can view read receipts for accessible help requests via help_request_id"
ON "public"."help_request_message_read_receipts"
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (can_access_help_request(help_request_id));

-- Update the broadcast function to handle help_request_message_read_receipts more efficiently
CREATE OR REPLACE FUNCTION public.broadcast_help_request_data_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    help_request_id BIGINT;
    class_id BIGINT;
    row_id BIGINT;
    main_payload JSONB;
BEGIN
    -- Get the help_request_id and class_id based on the table
    IF TG_TABLE_NAME = 'help_requests' THEN
        IF TG_OP = 'INSERT' THEN
            help_request_id := NEW.id;
            class_id := NEW.class_id;
            row_id := NEW.id;
        ELSIF TG_OP = 'UPDATE' THEN
            help_request_id := NEW.id;
            class_id := NEW.class_id;
            row_id := NEW.id;
        ELSIF TG_OP = 'DELETE' THEN
            help_request_id := OLD.id;
            class_id := OLD.class_id;
            row_id := OLD.id;
        END IF;
    ELSE
        -- For related tables, get help_request_id from the appropriate column
        IF TG_TABLE_NAME = 'help_request_message_read_receipts' THEN
            -- For read receipts, use direct help_request_id if available, otherwise lookup via message_id
            IF TG_OP = 'INSERT' THEN
                help_request_id := COALESCE(NEW.help_request_id, (
                    SELECT hrm.help_request_id
                    FROM public.help_request_messages hrm
                    WHERE hrm.id = NEW.message_id
                ));
                class_id := NEW.class_id;
                row_id := NEW.id;
            ELSIF TG_OP = 'UPDATE' THEN
                help_request_id := COALESCE(NEW.help_request_id, (
                    SELECT hrm.help_request_id
                    FROM public.help_request_messages hrm
                    WHERE hrm.id = NEW.message_id
                ));
                class_id := NEW.class_id;
                row_id := NEW.id;
            ELSIF TG_OP = 'DELETE' THEN
                help_request_id := COALESCE(OLD.help_request_id, (
                    SELECT hrm.help_request_id
                    FROM public.help_request_messages hrm
                    WHERE hrm.id = OLD.message_id
                ));
                class_id := OLD.class_id;
                row_id := OLD.id;
            END IF;
        ELSE
            -- For other related tables, get help_request_id from the direct column
            IF TG_OP = 'INSERT' THEN
                help_request_id := NEW.help_request_id;
                class_id := NEW.class_id;
                row_id := NEW.id;
            ELSIF TG_OP = 'UPDATE' THEN
                help_request_id := COALESCE(NEW.help_request_id, OLD.help_request_id);
                class_id := COALESCE(NEW.class_id, OLD.class_id);
                row_id := NEW.id;
            ELSIF TG_OP = 'DELETE' THEN
                help_request_id := OLD.help_request_id;
                class_id := OLD.class_id;
                row_id := OLD.id;
            END IF;
        END IF;
    END IF;

    -- Only broadcast if we have valid help_request_id and class_id
    IF help_request_id IS NOT NULL AND class_id IS NOT NULL THEN
        -- Create payload with help request specific information
        main_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', row_id,
            'help_request_id', help_request_id,
            'class_id', class_id,
            'data', CASE 
                WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
                ELSE to_jsonb(NEW)
            END,
            'timestamp', NOW()
        );

        -- Broadcast to main help request channel
        PERFORM realtime.send(
            main_payload,
            'broadcast',
            'help_request:' || help_request_id,
            true
        );
    END IF;

    -- Return the appropriate record
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$function$;

-- Update help_request_students RLS policy for insert operations
DROP POLICY IF EXISTS "Students can add students to help requests they're part of" ON "public"."help_request_students";

-- Create new RLS policy for help_request_students that allows insert if:
-- 1. User is a grader/instructor for the class
-- 2. User is authorized for the profile of the creator (created_by) of the associated help request
-- 3. User is authorized for the profile of any existing student associated with the help request
CREATE POLICY "Students can add students to help requests they have access to"
ON "public"."help_request_students"
AS PERMISSIVE
FOR INSERT
TO authenticated
WITH CHECK (
  authorizeforclassgrader(class_id) OR
  (
    SELECT authorizeforprofile(hr.created_by)
    FROM help_requests hr
    WHERE hr.id = help_request_students.help_request_id
  ) OR
  EXISTS (
    SELECT 1
    FROM help_request_students existing_hrs
    JOIN user_roles ur ON ur.private_profile_id = existing_hrs.profile_id
    WHERE existing_hrs.help_request_id = help_request_students.help_request_id
      AND ur.user_id = auth.uid()
      AND authorizeforprofile(existing_hrs.profile_id)
  )
);

-- Update user_is_in_help_request function to also check created_by field
CREATE OR REPLACE FUNCTION public.user_is_in_help_request(p_help_request_id bigint, p_user_id uuid DEFAULT auth.uid())
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from public.help_request_students hrs
    where hrs.help_request_id = p_help_request_id
    and hrs.profile_id in (
      select ur.private_profile_id
      from public.user_roles ur
      where ur.user_id = p_user_id
    )
  ) OR exists (
    select 1
    from public.help_requests hr
    join public.user_roles ur on ur.private_profile_id = hr.created_by
    where hr.id = p_help_request_id
    and ur.user_id = p_user_id
  );
$function$;