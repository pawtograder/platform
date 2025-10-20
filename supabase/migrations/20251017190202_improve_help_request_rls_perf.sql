-- ============================================================================
-- SECURITY DEFINER FUNCTIONS FOR RLS (to avoid circular dependencies)
-- ============================================================================

-- Function to check if a user can add students to a help request
-- This bypasses RLS to avoid circular dependency with help_requests table
CREATE OR REPLACE FUNCTION check_can_add_to_help_request(
  p_help_request_id bigint,
  p_user_id uuid,
  p_class_id bigint
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_staff boolean;
  v_is_private boolean;
  v_is_creator boolean;
  v_is_member boolean;
  v_private_profile_id uuid;
  v_public_profile_id uuid;
BEGIN
  -- Get user's role and profile IDs
  SELECT 
    role IN ('instructor', 'grader', 'admin'),
    private_profile_id,
    public_profile_id
  INTO v_is_staff, v_private_profile_id, v_public_profile_id
  FROM user_privileges
  WHERE user_id = p_user_id AND class_id = p_class_id
  LIMIT 1;

  -- Staff can add to any help request
  IF v_is_staff THEN
    RETURN true;
  END IF;

  -- For students, check help request privacy (bypass RLS with SECURITY DEFINER)
  SELECT is_private INTO v_is_private
  FROM help_requests
  WHERE id = p_help_request_id;

  -- Anyone can add to non-private help requests
  IF NOT v_is_private THEN
    RETURN true;
  END IF;

  -- For private help requests, check if user is creator
  SELECT EXISTS (
    SELECT 1 FROM help_requests
    WHERE id = p_help_request_id
      AND (created_by = v_private_profile_id OR created_by = v_public_profile_id)
  ) INTO v_is_creator;

  IF v_is_creator THEN
    RETURN true;
  END IF;

  -- Check if user is already a member of the private help request
  SELECT EXISTS (
    SELECT 1 FROM help_request_students
    WHERE help_request_id = p_help_request_id
      AND (profile_id = v_private_profile_id OR profile_id = v_public_profile_id)
  ) INTO v_is_member;

  RETURN v_is_member;
END;
$$;

-- Function to check if a user can remove students from a help request
-- This bypasses RLS to avoid circular dependency with help_requests table
CREATE OR REPLACE FUNCTION check_can_remove_from_help_request(
  p_help_request_id bigint,
  p_profile_id_to_remove uuid,
  p_user_id uuid,
  p_class_id bigint
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_staff boolean;
  v_is_removing_self boolean;
  v_is_member boolean;
  v_private_profile_id uuid;
  v_public_profile_id uuid;
BEGIN
  -- Get user's role and profile IDs
  SELECT 
    role IN ('instructor', 'grader', 'admin'),
    private_profile_id,
    public_profile_id
  INTO v_is_staff, v_private_profile_id, v_public_profile_id
  FROM user_privileges
  WHERE user_id = p_user_id AND class_id = p_class_id
  LIMIT 1;

  -- Staff can remove anyone
  IF v_is_staff THEN
    RETURN true;
  END IF;

  -- Check if user is removing themselves
  v_is_removing_self := (p_profile_id_to_remove = v_private_profile_id OR p_profile_id_to_remove = v_public_profile_id);
  
  IF v_is_removing_self THEN
    RETURN true;
  END IF;

  -- For removing others, check if user is a member of the help request
  SELECT EXISTS (
    SELECT 1 FROM help_request_students
    WHERE help_request_id = p_help_request_id
      AND (profile_id = v_private_profile_id OR profile_id = v_public_profile_id)
  ) INTO v_is_member;

  -- Members can remove others from the same help request
  RETURN v_is_member;
END;
$$;

-- ============================================================================
-- OPTIMIZE HELP_REQUEST_STUDENTS POLICIES
-- ============================================================================

-- Drop all existing policies to prevent circular dependencies
DROP POLICY IF EXISTS "Students can view help request members" ON "public"."help_request_students";
DROP POLICY IF EXISTS "Students can add students to help requests they have access to" ON "public"."help_request_students";
DROP POLICY IF EXISTS "Students can remove students from help requests they're part of" ON "public"."help_request_students";
DROP POLICY IF EXISTS "Staff can update help request memberships" ON "public"."help_request_students";

-- SELECT: Simplified policy - anyone in the class can see all help_request_students
-- This is safe because:
-- 1. Seeing who's in a help request doesn't leak sensitive info
-- 2. The help_requests RLS policy controls access to actual metadata
-- 3. Students won't see help request details if they can't access the help request itself
-- 4. This breaks the circular RLS dependency with help_requests
CREATE POLICY "Students can view help request members" 
ON "public"."help_request_students" 
FOR SELECT 
TO "authenticated" 
USING (
  EXISTS (
    SELECT 1
    FROM "public"."user_privileges" "up"
    WHERE "up"."user_id" = "auth"."uid"()
      AND "up"."class_id" = "help_request_students"."class_id"
  )
);

-- INSERT: Use SECURITY DEFINER function to check access without circular dependency
-- Logic:
-- 1. Staff can add anyone
-- 2. Students can add to non-private help requests
-- 3. Students can add to private help requests if they're the creator or already a member
CREATE POLICY "Students can add students to help requests they have access to" 
ON "public"."help_request_students" 
FOR INSERT 
TO "authenticated" 
WITH CHECK (
  check_can_add_to_help_request(
    help_request_students.help_request_id,
    auth.uid(),
    help_request_students.class_id
  )
);

-- DELETE: Use SECURITY DEFINER function to check access without circular dependency
-- Logic:
-- 1. Staff can remove anyone
-- 2. Students can remove themselves
-- 3. Students who are members can remove others from the same help request
CREATE POLICY "Students can remove students from help requests they're part of" 
ON "public"."help_request_students" 
FOR DELETE 
TO "authenticated" 
USING (
  check_can_remove_from_help_request(
    help_request_students.help_request_id,
    help_request_students.profile_id,
    auth.uid(),
    help_request_students.class_id
  )
);

-- UPDATE: Staff only
CREATE POLICY "Staff can update help request memberships" 
ON "public"."help_request_students" 
FOR UPDATE 
TO "authenticated" 
USING (
  EXISTS (
    SELECT 1
    FROM "public"."user_privileges" "up"
    WHERE "up"."user_id" = "auth"."uid"()
      AND "up"."class_id" = "help_request_students"."class_id"
      AND "up"."role" IN ('instructor', 'grader', 'admin')
  )
) 
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM "public"."user_privileges" "up"
    WHERE "up"."user_id" = "auth"."uid"()
      AND "up"."class_id" = "help_request_students"."class_id"
      AND "up"."role" IN ('instructor', 'grader', 'admin')
  )
);

-- ============================================================================
-- OPTIMIZE HELP_REQUESTS SELECT POLICY
-- ============================================================================
DROP POLICY IF EXISTS "Students can view help requests in their class with creator acc" ON "public"."help_requests";

-- Create optimized policy with only one auth.uid() call and no function calls
-- Logic:
-- 1. Graders/Instructors can see all help requests in their classes
-- 2. Students can see non-private help requests in their classes
-- 3. Students can see private help requests they created, are assigned to, or are members of
CREATE POLICY "Students can view help requests in their class with creator acc"
ON "public"."help_requests"
FOR SELECT
TO "authenticated"
USING (
  EXISTS (
    SELECT 1
    FROM "public"."user_privileges" "up"
    LEFT JOIN "public"."help_request_students" "hrs_member"
      ON "hrs_member"."help_request_id" = "help_requests"."id"
      AND "hrs_member"."profile_id" IN ("up"."private_profile_id", "up"."public_profile_id")
    WHERE "up"."user_id" = "auth"."uid"()
      AND "up"."class_id" = "help_requests"."class_id"
      AND (
        -- Graders/instructors can see all
        "up"."role" IN ('instructor', 'grader', 'admin')
        OR
        -- Students can see non-private help requests
        ("up"."role" = 'student' AND "help_requests"."is_private" = false)
        OR
        -- Students can see private help requests they're involved in
        (
          "up"."role" = 'student' 
          AND "help_requests"."is_private" = true
          AND (
            -- User is the assignee
            "help_requests"."assignee" IN ("up"."private_profile_id", "up"."public_profile_id")
            OR
            -- User is the creator
            "help_requests"."created_by" IN ("up"."private_profile_id", "up"."public_profile_id")
            OR
            -- User is a member
            "hrs_member"."id" IS NOT NULL
          )
        )
      )
  )
);

-- ============================================================================
-- OPTIMIZE HELP_REQUEST_MESSAGES SELECT POLICY
-- ============================================================================
DROP POLICY IF EXISTS "Users can view messages in help requests they can access" ON "public"."help_request_messages";

-- Create optimized policy with only one auth.uid() call and no function calls
-- Logic: Same as help_requests - users can view messages if they can access the help request
CREATE POLICY "Users can view messages in help requests they can access"
ON "public"."help_request_messages"
FOR SELECT
TO "authenticated"
USING (
  EXISTS (
    SELECT 1
    FROM "public"."user_privileges" "up"
    LEFT JOIN "public"."help_requests" "hr"
      ON "hr"."id" = "help_request_messages"."help_request_id"
    LEFT JOIN "public"."help_request_students" "hrs_member"
      ON "hrs_member"."help_request_id" = "help_request_messages"."help_request_id"
      AND "hrs_member"."profile_id" IN ("up"."private_profile_id", "up"."public_profile_id")
    WHERE "up"."user_id" = "auth"."uid"()
      AND "up"."class_id" = "help_request_messages"."class_id"
      AND (
        -- Graders/instructors can see all messages
        "up"."role" IN ('instructor', 'grader', 'admin')
        OR
        -- Students can see messages in non-private help requests
        ("up"."role" = 'student' AND "hr"."is_private" = false)
        OR
        -- Students can see messages in private help requests they're involved in
        (
          "up"."role" = 'student' 
          AND "hr"."is_private" = true
          AND (
            "hr"."assignee" IN ("up"."private_profile_id", "up"."public_profile_id")
            OR "hr"."created_by" IN ("up"."private_profile_id", "up"."public_profile_id")
            OR "hrs_member"."id" IS NOT NULL
          )
        )
      )
  )
);

-- ============================================================================
-- OPTIMIZE HELP_REQUEST_MESSAGE_READ_RECEIPTS SELECT POLICY
-- ============================================================================
DROP POLICY IF EXISTS "Users can view read receipts for accessible help requests via h" ON "public"."help_request_message_read_receipts";

-- Create optimized policy with only one auth.uid() call and no function calls
-- Logic: Same as help_requests - users can view read receipts if they can access the help request
CREATE POLICY "Users can view read receipts for accessible help requests via h"
ON "public"."help_request_message_read_receipts"
FOR SELECT
TO "authenticated"
USING (
  EXISTS (
    SELECT 1
    FROM "public"."user_privileges" "up"
    LEFT JOIN "public"."help_requests" "hr"
      ON "hr"."id" = "help_request_message_read_receipts"."help_request_id"
    LEFT JOIN "public"."help_request_students" "hrs_member"
      ON "hrs_member"."help_request_id" = "help_request_message_read_receipts"."help_request_id"
      AND "hrs_member"."profile_id" IN ("up"."private_profile_id", "up"."public_profile_id")
    WHERE "up"."user_id" = "auth"."uid"()
      AND "up"."class_id" = "help_request_message_read_receipts"."class_id"
      AND (
        -- Graders/instructors can see all read receipts
        "up"."role" IN ('instructor', 'grader', 'admin')
        OR
        -- Students can see read receipts for non-private help requests
        ("up"."role" = 'student' AND "hr"."is_private" = false)
        OR
        -- Students can see read receipts for private help requests they're involved in
        (
          "up"."role" = 'student' 
          AND "hr"."is_private" = true
          AND (
            "hr"."assignee" IN ("up"."private_profile_id", "up"."public_profile_id")
            OR "hr"."created_by" IN ("up"."private_profile_id", "up"."public_profile_id")
            OR "hrs_member"."id" IS NOT NULL
          )
        )
      )
  )
);

-- ============================================================================
-- OPTIMIZE HELP_REQUEST_MODERATION SELECT POLICY
-- ============================================================================
DROP POLICY IF EXISTS "Graders can view moderation records and students can view their" ON "public"."help_request_moderation";

-- Create optimized policy with only one auth.uid() call and no function calls
-- Logic:
-- 1. Graders/Instructors can see all moderation records in their classes
-- 2. Students can see their own moderation records
CREATE POLICY "Graders can view moderation records and students can view their"
ON "public"."help_request_moderation"
FOR SELECT
TO "authenticated"
USING (
  EXISTS (
    SELECT 1
    FROM "public"."user_privileges" "up"
    WHERE "up"."user_id" = "auth"."uid"()
      AND "up"."class_id" = "help_request_moderation"."class_id"
      AND (
        -- Graders/instructors can see all
        "up"."role" IN ('instructor', 'grader', 'admin')
        OR
        -- Students can see their own records
        (
          "up"."role" = 'student'
          AND "help_request_moderation"."student_profile_id" IN ("up"."private_profile_id", "up"."public_profile_id")
        )
      )
  )
);

-- ============================================================================
-- INDICES FOR RLS PERFORMANCE
-- ============================================================================

-- Index for help_requests RLS policy - class_id filtering
CREATE INDEX IF NOT EXISTS idx_help_requests_class_id 
  ON "public"."help_requests" (class_id);

-- Index for help_requests RLS policy - assignee and created_by checks
CREATE INDEX IF NOT EXISTS idx_help_requests_assignee 
  ON "public"."help_requests" (assignee) WHERE assignee IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_help_requests_created_by 
  ON "public"."help_requests" (created_by);

-- CRITICAL: Composite index for the LEFT JOIN in help_requests RLS policy
-- This prevents the seq scan on help_request_students that was removing 1749 rows per loop
CREATE INDEX IF NOT EXISTS idx_help_request_students_request_profile 
  ON "public"."help_request_students" (help_request_id, profile_id);

-- Index for help_request_students RLS policy - class_id filtering
CREATE INDEX IF NOT EXISTS idx_help_request_students_class_id 
  ON "public"."help_request_students" (class_id);

-- Index for help_request_messages RLS policy - class_id and help_request_id
CREATE INDEX IF NOT EXISTS idx_help_request_messages_class_id 
  ON "public"."help_request_messages" (class_id);

CREATE INDEX IF NOT EXISTS idx_help_request_messages_help_request_id 
  ON "public"."help_request_messages" (help_request_id);

-- Index for help_request_message_read_receipts RLS policy
CREATE INDEX IF NOT EXISTS idx_help_request_message_read_receipts_class_id 
  ON "public"."help_request_message_read_receipts" (class_id);

CREATE INDEX IF NOT EXISTS idx_help_request_message_read_receipts_help_request_id 
  ON "public"."help_request_message_read_receipts" (help_request_id);

-- Index for help_request_moderation RLS policy
CREATE INDEX IF NOT EXISTS idx_help_request_moderation_class_id 
  ON "public"."help_request_moderation" (class_id);

CREATE INDEX IF NOT EXISTS idx_help_request_moderation_student_profile 
  ON "public"."help_request_moderation" (student_profile_id);