-- ============================================================================
-- OPTIMIZE HELP_REQUEST_STUDENTS SELECT POLICY
-- ============================================================================
DROP POLICY IF EXISTS "Students can view help request members" ON "public"."help_request_students";

-- Simplified policy: anyone in the class can see all help_request_students
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

CREATE INDEX ON public.submission_regrade_requests USING btree (created_at);
CREATE INDEX ON public.assignment_due_date_exceptions USING btree (created_at);
    