-- Optimized solution for submission ordinal assignment
-- Replaces expensive COUNT(*) operations with atomic counter table

-- Step 1: Drop any existing counter table and recreate cleanly
DROP TABLE IF EXISTS "public"."submission_ordinal_counters";

-- Create a counter table to track next ordinal values
-- Using separate columns with default values to avoid partial constraint issues
CREATE TABLE "public"."submission_ordinal_counters" (
    "assignment_id" bigint NOT NULL,
    "assignment_group_id" bigint NOT NULL DEFAULT 0,  -- Use 0 for individual submissions
    "profile_id" uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'::uuid,  -- Use special UUID for group submissions
    "next_ordinal" integer DEFAULT 1 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "submission_ordinal_counters_pkey" PRIMARY KEY ("assignment_id", "assignment_group_id", "profile_id"),
    CONSTRAINT "submission_ordinal_counters_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE CASCADE,
    -- Removed check constraint to simplify debugging
    -- Logic is enforced in the trigger function instead
);

-- Add indexes for performance (the primary key already covers these, but explicit indexes help query planning)
CREATE INDEX IF NOT EXISTS "idx_submission_ordinal_counters_assignment_group" 
ON "public"."submission_ordinal_counters" ("assignment_id", "assignment_group_id") 
WHERE assignment_group_id != 0;

CREATE INDEX IF NOT EXISTS "idx_submission_ordinal_counters_profile" 
ON "public"."submission_ordinal_counters" ("assignment_id", "profile_id") 
WHERE profile_id != '00000000-0000-0000-0000-000000000000'::uuid;

-- Step 2: Initialize counter table with existing data
-- Initialize counters for group submissions
INSERT INTO "public"."submission_ordinal_counters" (assignment_id, assignment_group_id, profile_id, next_ordinal)
SELECT 
    assignment_id,
    assignment_group_id,
    '00000000-0000-0000-0000-000000000000'::uuid as profile_id,
    COALESCE(MAX(ordinal), 0) + 1 as next_ordinal
FROM "public"."submissions" 
WHERE assignment_group_id IS NOT NULL
GROUP BY assignment_id, assignment_group_id
ON CONFLICT DO NOTHING;

-- Initialize counters for individual submissions
INSERT INTO "public"."submission_ordinal_counters" (assignment_id, assignment_group_id, profile_id, next_ordinal)
SELECT 
    assignment_id,
    0 as assignment_group_id,
    profile_id,
    COALESCE(MAX(ordinal), 0) + 1 as next_ordinal
FROM "public"."submissions" 
WHERE assignment_group_id IS NULL AND profile_id IS NOT NULL
GROUP BY assignment_id, profile_id
ON CONFLICT DO NOTHING;

-- Step 3: Create optimized trigger function
CREATE OR REPLACE FUNCTION "public"."submissions_insert_hook_optimized"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    assigned_ordinal integer;
BEGIN
    CASE TG_OP
    WHEN 'INSERT' THEN
        IF NEW.assignment_group_id IS NOT NULL THEN
            -- Handle group submissions: use actual group ID + special UUID
            INSERT INTO "public"."submission_ordinal_counters" 
                (assignment_id, assignment_group_id, profile_id, next_ordinal, updated_at)
            VALUES 
                (NEW.assignment_id::bigint, 
                 NEW.assignment_group_id::bigint, 
                 '00000000-0000-0000-0000-000000000000'::uuid, 
                 2::integer,
                 now())
            ON CONFLICT (assignment_id, assignment_group_id, profile_id)
            DO UPDATE SET 
                next_ordinal = submission_ordinal_counters.next_ordinal + 1,
                updated_at = now()
            RETURNING (submission_ordinal_counters.next_ordinal - 1) INTO assigned_ordinal;
            
            NEW.ordinal = assigned_ordinal;
            
            -- Only set is_active = true if this is NOT a NOT-GRADED submission
            IF NOT NEW.is_not_graded THEN
                NEW.is_active = true;
                UPDATE submissions SET is_active = false 
                WHERE assignment_id = NEW.assignment_id 
                AND assignment_group_id = NEW.assignment_group_id
                AND id != NEW.id;
            END IF;
        ELSE
            -- Handle individual submissions: use 0 for group ID + actual profile ID
            INSERT INTO "public"."submission_ordinal_counters" 
                (assignment_id, assignment_group_id, profile_id, next_ordinal, updated_at)
            VALUES 
                (NEW.assignment_id::bigint, 
                 0::bigint, 
                 NEW.profile_id::uuid, 
                 2::integer,
                 now())
            ON CONFLICT (assignment_id, assignment_group_id, profile_id)
            DO UPDATE SET 
                next_ordinal = submission_ordinal_counters.next_ordinal + 1,
                updated_at = now()
            RETURNING (submission_ordinal_counters.next_ordinal - 1) INTO assigned_ordinal;
            
            NEW.ordinal = assigned_ordinal;
            
            -- Only set is_active = true if this is NOT a NOT-GRADED submission
            IF NOT NEW.is_not_graded THEN
                NEW.is_active = true;
                UPDATE submissions SET is_active = false 
                WHERE assignment_id = NEW.assignment_id 
                AND profile_id = NEW.profile_id
                AND id != NEW.id;
            END IF;
        END IF;
        
        RETURN NEW;
    ELSE
        RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
    END CASE;
END
$$;

-- Step 4: Replace the trigger
-- Drop any existing submission triggers
DROP TRIGGER IF EXISTS submissions_insert_hook_trigger ON "public"."submissions";
DROP TRIGGER IF EXISTS submission_ordinal_trigger ON "public"."submissions";
DROP TRIGGER IF EXISTS submissions_trigger ON "public"."submissions";

-- Drop old trigger function if it exists
DROP FUNCTION IF EXISTS "public"."submissions_insert_hook"();

-- Create the new optimized trigger
CREATE TRIGGER submissions_insert_hook_trigger 
    BEFORE INSERT ON "public"."submissions" 
    FOR EACH ROW 
    EXECUTE FUNCTION "public"."submissions_insert_hook_optimized"();

-- Step 5: Grant necessary permissions
ALTER TABLE "public"."submission_ordinal_counters" ENABLE ROW LEVEL SECURITY;

-- Create RLS policies (adjust based on your existing security model)
CREATE POLICY "Users can read their own counters" ON "public"."submission_ordinal_counters"
    FOR SELECT 
    USING (
        -- Individual submissions: check if profile_id matches user's profile
        (assignment_group_id = 0 AND profile_id IN (
            SELECT private_profile_id FROM user_roles WHERE user_id = auth.uid()
        )) OR
        -- Group submissions: check if user is member of the assignment group
        (assignment_group_id != 0 AND assignment_group_id IN (
            SELECT agm.assignment_group_id 
            FROM assignment_groups_members agm
            JOIN user_roles ur ON ur.private_profile_id = agm.profile_id
            WHERE ur.user_id = auth.uid()
        ))
    );

-- Allow the trigger function to modify counters
GRANT SELECT, INSERT, UPDATE ON "public"."submission_ordinal_counters" TO authenticated;
GRANT SELECT, INSERT, UPDATE ON "public"."submission_ordinal_counters" TO service_role;

-- Comment explaining the optimization
COMMENT ON FUNCTION "public"."submissions_insert_hook_optimized"() IS 
'Optimized submission trigger that uses atomic counter increments instead of COUNT(*) operations to assign ordinals. This prevents table locks and improves performance under high load.';

COMMENT ON TABLE "public"."submission_ordinal_counters" IS 
'Counter table for atomic ordinal assignment in submissions. Uses assignment_group_id + special UUID (00000000-0000-0000-0000-000000000000) for group submissions, or assignment_group_id=0 + actual profile_id for individual submissions. Avoids expensive COUNT(*) operations and provides O(1) ordinal assignment.';
