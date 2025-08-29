-- Optimize discussion_threads triggers to avoid expensive COUNT(*) operations
-- Replaces ordinal assignment and watcher checks with efficient atomic operations

-- Step 1: Create counter table for discussion thread ordinals per class
DROP TABLE IF EXISTS "public"."discussion_thread_ordinal_counters";

CREATE TABLE "public"."discussion_thread_ordinal_counters" (
    "class_id" bigint NOT NULL,
    "next_ordinal" integer DEFAULT 1 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "discussion_thread_ordinal_counters_pkey" PRIMARY KEY ("class_id"),
    CONSTRAINT "discussion_thread_ordinal_counters_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE CASCADE
);

-- Enable RLS on discussion_thread_ordinal_counters
ALTER TABLE "public"."discussion_thread_ordinal_counters" ENABLE ROW LEVEL SECURITY;

-- Add comment explaining the optimization
COMMENT ON TABLE "public"."discussion_thread_ordinal_counters" IS 
'Counter table for atomic ordinal assignment in discussion_threads. Tracks next ordinal per class to avoid expensive COUNT(*) operations.';

-- Step 2: Initialize counter table with existing data
INSERT INTO "public"."discussion_thread_ordinal_counters" (class_id, next_ordinal)
SELECT 
    class_id,
    COALESCE(MAX(ordinal), 0) + 1 as next_ordinal
FROM "public"."discussion_threads"
GROUP BY class_id
ON CONFLICT DO NOTHING;

-- Step 3: Create optimized ordinal assignment function
CREATE OR REPLACE FUNCTION "public"."discussion_thread_set_ordinal_optimized"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    assigned_ordinal integer;
BEGIN
    CASE TG_OP
    WHEN 'INSERT' THEN
        -- Use atomic counter increment instead of COUNT(*)
        INSERT INTO "public"."discussion_thread_ordinal_counters" 
            (class_id, next_ordinal, updated_at)
        VALUES 
            (NEW.class_id, 2, now())
        ON CONFLICT (class_id)
        DO UPDATE SET 
            next_ordinal = discussion_thread_ordinal_counters.next_ordinal + 1,
            updated_at = now()
        RETURNING (discussion_thread_ordinal_counters.next_ordinal - 1) INTO assigned_ordinal;
        
        NEW.ordinal = assigned_ordinal;
        RETURN NEW;
    ELSE
        RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
    END CASE;
END
$$;

-- Step 4: Create watcher existence cache table for efficient lookups
DROP TABLE IF EXISTS "public"."discussion_thread_watcher_cache";

CREATE TABLE "public"."discussion_thread_watcher_cache" (
    "discussion_thread_root_id" bigint NOT NULL,
    "user_id" uuid NOT NULL,
    "exists" boolean DEFAULT true NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "discussion_thread_watcher_cache_pkey" PRIMARY KEY ("discussion_thread_root_id", "user_id"),
    CONSTRAINT "discussion_thread_watcher_cache_root_id_fkey" FOREIGN KEY ("discussion_thread_root_id") REFERENCES "public"."discussion_threads"("id") ON DELETE CASCADE
    -- Note: user_id references auth.users.id, but we'll let the application enforce this constraint
    -- since user_roles doesn't have user_id as a unique constraint
);

-- Enable RLS on discussion_thread_watcher_cache
ALTER TABLE "public"."discussion_thread_watcher_cache" ENABLE ROW LEVEL SECURITY;

-- Add index for performance
CREATE INDEX IF NOT EXISTS "idx_discussion_thread_watcher_cache_user" 
ON "public"."discussion_thread_watcher_cache" ("user_id", "exists") 
WHERE "exists" = true;

-- Add comment explaining the cache
COMMENT ON TABLE "public"."discussion_thread_watcher_cache" IS 
'Cache table for discussion thread watcher existence checks. Avoids expensive COUNT(*) operations in trigger functions.';

-- Step 5: Initialize watcher cache with existing data
INSERT INTO "public"."discussion_thread_watcher_cache" (discussion_thread_root_id, user_id, exists)
SELECT DISTINCT 
    discussion_thread_root_id,
    user_id,
    true as exists
FROM "public"."discussion_thread_watchers"
WHERE enabled = true
ON CONFLICT DO NOTHING;

-- Step 6: Create RLS policies for the new tables

-- RLS policies for discussion_thread_ordinal_counters
-- Allow system functions (SECURITY DEFINER) to manage counters
CREATE POLICY "discussion_thread_ordinal_counters_system_access" ON "public"."discussion_thread_ordinal_counters"
    FOR ALL USING (true);

-- RLS policies for discussion_thread_watcher_cache  
-- Users can access watcher cache for classes they are enrolled in
CREATE POLICY "discussion_thread_watcher_cache_class_member_access" ON "public"."discussion_thread_watcher_cache"
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM "public"."discussion_threads" dt
            INNER JOIN "public"."user_roles" ur ON dt.class_id = ur.class_id
            WHERE dt.id = discussion_thread_root_id 
            AND ur.user_id = auth.uid()
        )
    );

-- Step 7: Create optimized notification function
CREATE OR REPLACE FUNCTION "public"."discussion_threads_notification_optimized"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    body jsonb;
    subject jsonb;
    style text;
    watcher_exists boolean DEFAULT false;
    root_subject text;
    reply_author_name text;
    current_user_id uuid;
BEGIN
    CASE TG_OP
    WHEN 'INSERT' THEN
        -- Set root to its own ID if there is no root specified
        if NEW.root is null then
            update discussion_threads set root = id where id = NEW.id;
            NEW.root = NEW.id;
            root_subject = NEW.subject;
        else
            SELECT discussion_threads.subject INTO root_subject FROM discussion_threads WHERE id=NEW.root; 
        END if;
        SELECT name into reply_author_name from profiles where id=NEW.author; 

        -- Get current user ID, handling null case
        current_user_id := auth.uid();

        -- Build notification body
        body := jsonb_build_object(
            'type', 'discussion_thread',
            'action', 'reply',
            'new_comment_number', NEW.ordinal,
            'new_comment_id', NEW.id,
            'root_thread_id', NEW.root,
            'reply_author_profile_id', NEW.author,
            'teaser', left(NEW.body, 40),
            'thread_name', root_subject,
            'reply_author_name', reply_author_name
        );
        subject := '{}';
        style := 'info';
        
        -- Only send notifications if we have a current user
        if current_user_id is not null then
            INSERT INTO notifications (class_id, subject, body, style, user_id)
            SELECT class_id, subject, body, style, user_id FROM discussion_thread_watchers
            WHERE discussion_thread_root_id = NEW.root and enabled=true and user_id!=current_user_id;
        end if;

        -- Efficiently check if watcher exists using cache table
        if current_user_id is not null then
            SELECT EXISTS(
                SELECT 1 FROM "public"."discussion_thread_watcher_cache" 
                WHERE discussion_thread_root_id = NEW.root 
                AND user_id = current_user_id 
                AND exists = true
            ) INTO watcher_exists;
            
            -- Create watcher if it doesn't exist
            if NOT watcher_exists then
                INSERT INTO discussion_thread_watchers (class_id, discussion_thread_root_id, user_id, enabled) 
                VALUES (NEW.class_id, NEW.root, current_user_id, true);
                
                -- Update cache
                INSERT INTO "public"."discussion_thread_watcher_cache" (discussion_thread_root_id, user_id, exists, updated_at)
                VALUES (NEW.root, current_user_id, true, now())
                ON CONFLICT (discussion_thread_root_id, user_id) 
                DO UPDATE SET exists = true, updated_at = now();
            end if;
        end if;

        -- Mark as unread for everyone in the class, excluding the current user if one exists
        if current_user_id is not null then
            INSERT INTO discussion_thread_read_status (user_id, discussion_thread_id, discussion_thread_root_id) 
            select user_id, NEW.id as discussion_thread_id, NEW.root as discussion_thread_root_id 
            from user_roles 
            where class_id=NEW.class_id and user_id != current_user_id;
        else
            -- If no current user (seeding context), mark as unread for all users in the class
            INSERT INTO discussion_thread_read_status (user_id, discussion_thread_id, discussion_thread_root_id) 
            select user_id, NEW.id as discussion_thread_id, NEW.root as discussion_thread_root_id 
            from user_roles 
            where class_id=NEW.class_id;
        end if;
        
    ELSE
        RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
    END CASE;
    
    RETURN NEW;
END
$$;

-- Step 8: Create trigger to maintain watcher cache
CREATE OR REPLACE FUNCTION "public"."update_discussion_thread_watcher_cache"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
    CASE TG_OP
    WHEN 'INSERT' THEN
        -- Add to cache when watcher is created
        IF NEW.enabled THEN
            INSERT INTO "public"."discussion_thread_watcher_cache" (discussion_thread_root_id, user_id, exists, updated_at)
            VALUES (NEW.discussion_thread_root_id, NEW.user_id, true, now())
            ON CONFLICT (discussion_thread_root_id, user_id) 
            DO UPDATE SET exists = true, updated_at = now();
        END IF;
        RETURN NEW;
    WHEN 'UPDATE' THEN
        -- Update cache when enabled status changes
        INSERT INTO "public"."discussion_thread_watcher_cache" (discussion_thread_root_id, user_id, exists, updated_at)
        VALUES (NEW.discussion_thread_root_id, NEW.user_id, NEW.enabled, now())
        ON CONFLICT (discussion_thread_root_id, user_id) 
        DO UPDATE SET exists = NEW.enabled, updated_at = now();
        RETURN NEW;
    WHEN 'DELETE' THEN
        -- Remove from cache when watcher is deleted
        DELETE FROM "public"."discussion_thread_watcher_cache" 
        WHERE discussion_thread_root_id = OLD.discussion_thread_root_id 
        AND user_id = OLD.user_id;
        RETURN OLD;
    ELSE
        RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
    END CASE;
END
$$;

-- Step 9: Replace existing triggers with optimized versions
DROP TRIGGER IF EXISTS "discussion_threads_set_ordinal" ON "public"."discussion_threads";
CREATE TRIGGER "discussion_threads_set_ordinal_optimized" 
    BEFORE INSERT ON "public"."discussion_threads" 
    FOR EACH ROW EXECUTE FUNCTION "public"."discussion_thread_set_ordinal_optimized"();

DROP TRIGGER IF EXISTS "discussion_thread_notifications" ON "public"."discussion_threads";
CREATE TRIGGER "discussion_thread_notifications_optimized" 
    AFTER INSERT ON "public"."discussion_threads" 
    FOR EACH ROW EXECUTE FUNCTION "public"."discussion_threads_notification_optimized"();

-- Create trigger to maintain watcher cache
DROP TRIGGER IF EXISTS "discussion_thread_watchers_cache_maintenance" ON "public"."discussion_thread_watchers";
CREATE TRIGGER "discussion_thread_watchers_cache_maintenance" 
    AFTER INSERT OR UPDATE OR DELETE ON "public"."discussion_thread_watchers" 
    FOR EACH ROW EXECUTE FUNCTION "public"."update_discussion_thread_watcher_cache"();

-- Step 10: Add comments for maintenance and debugging
COMMENT ON FUNCTION "public"."discussion_thread_set_ordinal_optimized"() IS 
'Optimized discussion thread ordinal assignment using atomic counter increments instead of COUNT(*) operations. Prevents table locks and improves performance under high load.';

COMMENT ON FUNCTION "public"."discussion_threads_notification_optimized"() IS 
'Optimized discussion thread notification function using watcher cache instead of COUNT(*) existence checks. Significantly improves performance during bulk operations.';

COMMENT ON FUNCTION "public"."update_discussion_thread_watcher_cache"() IS 
'Maintains watcher cache table for efficient existence lookups in discussion thread triggers.';
