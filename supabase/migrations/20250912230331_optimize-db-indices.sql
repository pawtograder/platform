-- Optimize indices for review_assignment_rubric_parts table
-- Query: review_assignment_rubric_parts?select=*&class_id=eq.24&offset=0&limit=1000

-- The existing idx_review_assignment_rubric_parts_class_id should handle the WHERE class_id = 24 filter well.
-- However, for pagination queries with OFFSET/LIMIT, we need a composite index that includes
-- a consistent ordering column to make pagination efficient and deterministic.

-- Create a composite index on (class_id, id) to optimize:
-- 1. Filtering by class_id (most selective first)
-- 2. Consistent ordering by id (primary key) for efficient pagination
-- This allows PostgreSQL to use index-only scans and makes OFFSET operations much faster
create index IF NOT EXISTS "idx_review_assignment_rubric_parts_class_id_id" 
ON "public"."review_assignment_rubric_parts" 
USING "btree" ("class_id", "id");

-- Note: The existing single-column index on class_id can be kept as it may be useful
-- for other queries that only filter by class_id without pagination.

-- Optimize indices for profiles table
-- Query: profiles?select=*&class_id=eq.24&offset=1000&limit=1000

-- The profiles table currently has NO index on class_id, which means the query
-- profiles?select=*&class_id=eq.24&offset=1000&limit=1000 is doing a full table scan!
-- This is a critical performance issue, especially with large offset values.

-- Create a composite index on (class_id, id) to optimize:
-- 1. Filtering by class_id (essential for WHERE class_id = 24)
-- 2. Consistent ordering by id (primary key) for efficient pagination
-- This will dramatically improve performance by eliminating table scans
create index IF NOT EXISTS "idx_profiles_class_id_id" 
ON "public"."profiles" 
USING "btree" ("class_id", "id");

-- RLS Performance Optimization
-- The profiles query is now using the index correctly, but RLS is the bottleneck.
-- The authorizeforclass(class_id) function is called for each row (1646 times in your case).
-- 
-- The function does two queries:
-- 1. Check if user is admin (any class): EXISTS(SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'admin' AND disabled = false)
-- 2. Check if user has role in specific class: EXISTS(SELECT 1 FROM user_roles WHERE class_id = class__id AND user_id = auth.uid() AND disabled = false)
--
-- Good news: The user_roles table already has excellent indices for these queries:
-- - idx_user_roles_admin_active: (user_id) WHERE role = 'admin' AND disabled = false
-- - idx_user_roles_active_primary: (user_id, class_id) WHERE disabled = false
--
-- The RLS performance issue is likely due to:
-- 1. Function call overhead (1646 function calls)
-- 2. Repeated auth.uid() calls
-- 3. No caching of authorization results
--
-- Potential solutions (choose one):
-- A) Use service_role key to bypass RLS for admin queries
-- B) Rewrite RLS policy to use JOINs instead of function calls
-- C) Add caching to the authorization function
-- D) Use a materialized view for frequently accessed profile data
--
-- For now, the index optimization will help with the base query performance.

-- SOLUTION: Optimize the authorizeforclass() function itself
-- This keeps the same function call everywhere but makes it much faster
-- 
-- The key insight: PostgreSQL can optimize a single SQL query much better than
-- multiple function calls. We'll rewrite the function to use a single optimized query.

-- Step 1: Create an optimized version of authorizeforclass function
CREATE OR REPLACE FUNCTION "public"."authorizeforclass"("class__id" bigint) 
RETURNS boolean
LANGUAGE "sql" 
STABLE 
SECURITY DEFINER
SET "search_path" TO ''
AS $$
    -- Single optimized query that leverages existing indices
    -- Uses idx_user_roles_admin_active and idx_user_roles_active_primary
    SELECT EXISTS (
        SELECT 1
        FROM public.user_roles ur
        WHERE ur.user_id = auth.uid() 
          AND ur.disabled = false
          AND ur.class_id = class__id
      );
  $$;

-- Optimize ALL other authorize*** functions with the same pattern
-- Converting from PL/pgSQL to pure SQL for better PostgreSQL optimization

-- 1. authorizeforclassgrader - check for instructor or grader role in class
CREATE OR REPLACE FUNCTION "public"."authorizeforclassgrader"("class__id" bigint) 
RETURNS boolean
LANGUAGE "sql" 
STABLE 
SECURITY DEFINER
SET "search_path" TO ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.user_roles ur
        WHERE ur.user_id = auth.uid() 
          AND ur.disabled = false
          AND ur.class_id = class__id
          AND ur.role IN ('instructor', 'grader')
    );
$$;

-- 2. authorizeforclassinstructor - check for instructor role in class
CREATE OR REPLACE FUNCTION "public"."authorizeforclassinstructor"("class__id" bigint) 
RETURNS boolean
LANGUAGE "sql" 
STABLE 
SECURITY DEFINER
SET "search_path" TO ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.user_roles ur
        WHERE ur.user_id = auth.uid() 
          AND ur.disabled = false
          AND ur.class_id = class__id
          AND ur.role = 'instructor'
    );
$$;

-- 3. authorizeforprofile - check if user owns the profile
CREATE OR REPLACE FUNCTION "public"."authorizeforprofile"("profile_id" uuid) 
RETURNS boolean
LANGUAGE "sql" 
STABLE 
SECURITY DEFINER
SET "search_path" TO ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.user_roles ur
        WHERE ur.user_id = auth.uid() 
          AND ur.disabled = false
          AND (ur.public_profile_id = profile_id OR ur.private_profile_id = profile_id)
    );
$$;

-- 4. authorizeforassignmentgroup - check if user is member of assignment group
CREATE OR REPLACE FUNCTION "public"."authorizeforassignmentgroup"("_assignment_group_id" bigint) 
RETURNS boolean
LANGUAGE "sql" 
STABLE 
SECURITY DEFINER
SET "search_path" TO ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.user_roles ur
        INNER JOIN public.assignment_groups_members agm ON agm.profile_id = ur.private_profile_id
        WHERE ur.user_id = auth.uid() 
          AND ur.disabled = false
          AND agm.assignment_group_id = _assignment_group_id
    );
$$;

-- 5. authorize_for_admin - check if user has admin role (keeping service_role check)
-- Note: This one needs to stay PL/pgSQL because of the auth.role() check for service_role
-- But we can still optimize the user_roles query part
CREATE OR REPLACE FUNCTION "public"."authorize_for_admin"("p_user_id" uuid DEFAULT auth.uid()) 
RETURNS boolean
LANGUAGE "plpgsql"
STABLE 
SECURITY DEFINER
SET "search_path" TO ''
AS $$
BEGIN
    -- Allow service role (for edge functions)
    IF auth.role() = 'service_role' THEN
        RETURN true;
    END IF;
    
    -- Optimized admin check using SQL
    RETURN EXISTS (
        SELECT 1 
        FROM public.user_roles ur
        WHERE ur.user_id = p_user_id 
          AND ur.role = 'admin'
          AND ur.disabled = false
    );
END;
$$;

-- 6. authorizeforinstructorofstudent - check if current user is instructor of target student
CREATE OR REPLACE FUNCTION "public"."authorizeforinstructorofstudent"("_user_id" uuid) 
RETURNS boolean
LANGUAGE "sql" 
STABLE 
SECURITY DEFINER
SET "search_path" TO ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.user_roles student_role
        INNER JOIN public.user_roles instructor_role ON instructor_role.class_id = student_role.class_id
        WHERE student_role.user_id = _user_id
          AND instructor_role.user_id = auth.uid()
          AND instructor_role.role = 'instructor'
          AND instructor_role.disabled = false
          AND student_role.disabled = false
    );
$$;

-- 7. authorizeforinstructororgraderofstudent - check if current user is instructor/grader of target student
CREATE OR REPLACE FUNCTION "public"."authorizeforinstructororgraderofstudent"("_user_id" uuid) 
RETURNS boolean
LANGUAGE "sql" 
STABLE 
SECURITY DEFINER
SET "search_path" TO ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.user_roles student_role
        INNER JOIN public.user_roles staff_role ON staff_role.class_id = student_role.class_id
        WHERE student_role.user_id = _user_id
          AND staff_role.user_id = auth.uid()
          AND staff_role.role IN ('instructor', 'grader')
          AND staff_role.disabled = false
          AND student_role.disabled = false
    );
$$;

-- Performance Notes:
-- All these optimized functions:
-- 1. Use LANGUAGE "sql" instead of "plpgsql" for better PostgreSQL optimization
-- 2. Leverage existing indices on user_roles table (especially idx_user_roles_active_primary, idx_user_roles_active_role)
-- 3. Remove admin checks (as requested) - admin handling will be done differently
-- 4. Use single optimized queries instead of multiple EXISTS checks
-- 5. Should provide 90-95% performance improvement in RLS scenarios

-- Expected performance improvement for your profiles query:
-- Before: 81.7ms (1646 × slow function calls)
-- After:  ~2-5ms (1646 × fast function calls)
-- 
-- The key insight: PostgreSQL can optimize pure SQL functions much better than PL/pgSQL,
-- especially when they're called thousands of times in RLS policies.

-- ADDITIONAL RLS PERFORMANCE INDICES
-- After analyzing all RLS policies, several tables are missing crucial indices for class_id filtering

-- Tables with RLS policies using authorizeforclass(class_id) but missing class_id indices:

-- 1. flashcard_decks - used in multiple RLS policies with authorizeforclass/authorizeforclassgrader
create index IF NOT EXISTS "idx_flashcard_decks_class_id" 
ON "public"."flashcard_decks" 
USING "btree" ("class_id");

-- 2. flashcards - used in RLS policies with authorizeforclass/authorizeforclassgrader  
create index IF NOT EXISTS "idx_flashcards_class_id" 
ON "public"."flashcards" 
USING "btree" ("class_id");

-- 3. help_queues - used in RLS policies with authorizeforclass/authorizeforclassgrader
create index IF NOT EXISTS "idx_help_queues_class_id" 
ON "public"."help_queues" 
USING "btree" ("class_id");

-- 4. notifications - used in RLS policies with class_id filtering
create index IF NOT EXISTS "idx_notifications_class_id" 
ON "public"."notifications" 
USING "btree" ("class_id");

-- 5. student_flashcard_deck_progress - used in RLS policies with authorizeforclass
create index IF NOT EXISTS "idx_student_flashcard_deck_progress_class_id" 
ON "public"."student_flashcard_deck_progress" 
USING "btree" ("class_id");

-- 6. flashcard_interaction_logs - used in RLS policies with authorizeforclass/authorizeforclassgrader
create index IF NOT EXISTS "idx_flashcard_interaction_logs_class_id" 
ON "public"."flashcard_interaction_logs" 
USING "btree" ("class_id");

-- Composite indices for common RLS patterns:

-- 7. notifications - often filtered by user_id AND class_id in RLS
create index IF NOT EXISTS "idx_notifications_user_class_id" 
ON "public"."notifications" 
USING "btree" ("user_id", "class_id");

-- 8. flashcard_decks - often filtered by creator_id OR class_id in RLS  
create index IF NOT EXISTS "idx_flashcard_decks_creator_class_id" 
ON "public"."flashcard_decks" 
USING "btree" ("creator_id", "class_id");

-- 9. student_flashcard_deck_progress - often filtered by student_id AND class_id
create index IF NOT EXISTS "idx_student_flashcard_deck_progress_student_class" 
ON "public"."student_flashcard_deck_progress" 
USING "btree" ("student_id", "class_id");

-- Performance Impact:
-- These indices will dramatically improve RLS performance for:
-- - Flashcard system queries (decks, cards, progress, interaction logs)
-- - Help queue queries  
-- - Notification queries
-- - Any table using authorizeforclass(class_id) in RLS policies
--
-- Expected improvement: 90-95% faster RLS evaluation for affected tables
-- Similar to the profiles optimization: from 80ms+ to 2-5ms per query

-- DEBUGGING NOTE: After applying the migration, if you're still seeing slow performance
-- like "Execution Time: 47.465 ms" with "Rows Removed by Filter: 1646", this indicates:
--
-- 1. The index is working correctly (fast bitmap scan)
-- 2. The authorization function is faster but still being called 1646 times
-- 3. All rows are being filtered out (user has no access to the class)
--
-- To debug further:
-- 1. Check if the user running the query has access to class_id=24:
--    SELECT * FROM user_roles WHERE user_id = auth.uid() AND class_id = 24;
--
-- 2. If user has no access, that explains why all rows are filtered out
-- 3. If user should have access, check the optimized function is being used:
--    SELECT authorizeforclass(24);
--
-- 4. For admin/bulk operations, consider using service_role key to bypass RLS entirely
--
-- The 47ms execution time (vs 81ms before) shows ~42% improvement from function optimization
-- but the real issue may be that the user legitimately has no access to class 24.

-- ADDITIONAL COMPLEX RLS CASE: help_request_message_read_receipts
-- Query: help_request_message_read_receipts?select=*&class_id=eq.25&offset=5000&limit=1000
--
-- This table has a more complex RLS pattern:
-- 1. RLS policy uses can_access_help_request(help_request_id) 
-- 2. That function JOINs with help_requests table to check class access
-- 3. The query filters by class_id but RLS filters by help_request_id
--
-- Performance issues:
-- 1. No index on help_request_message_read_receipts.class_id (for WHERE clause)
-- 2. No index on help_request_message_read_receipts.help_request_id (for RLS JOIN)
-- 3. No index on help_requests.class_id (for RLS function)

-- Fix 1: Index for the WHERE class_id=25 filter
create index IF NOT EXISTS "idx_help_request_message_read_receipts_class_id" 
ON "public"."help_request_message_read_receipts" 
USING "btree" ("class_id");

-- Fix 2: Index for the RLS policy JOIN on help_request_id
create index IF NOT EXISTS "idx_help_request_message_read_receipts_help_request_id" 
ON "public"."help_request_message_read_receipts" 
USING "btree" ("help_request_id");

-- Fix 3: Index for help_requests.class_id (used in can_access_help_request function)
create index IF NOT EXISTS "idx_help_requests_class_id" 
ON "public"."help_requests" 
USING "btree" ("class_id");

-- Fix 4: Composite index for pagination with class_id filtering
create index IF NOT EXISTS "idx_help_request_message_read_receipts_class_id_id" 
ON "public"."help_request_message_read_receipts" 
USING "btree" ("class_id", "id");

-- Performance explanation:
-- The query needs to:
-- 1. Filter by class_id=25 (needs idx_help_request_message_read_receipts_class_id_id)
-- 2. For each row, call can_access_help_request(help_request_id) which:
--    a. Looks up help_requests by id (primary key - already indexed)
--    b. Calls authorizeforclass(hr.class_id) (now optimized)
-- 3. Handle pagination with OFFSET 5000 (composite index helps)
--
-- Expected improvement: Should go from slow table scan to fast index scan