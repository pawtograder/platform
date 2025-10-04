-- Fix repo creation timezone bug by removing duplicate trigger with incorrect timezone handling
-- 
-- Problem: trigger_create_repos_on_release was creating repos immediately when release_date
-- was updated to any past time, without proper UTC conversion or 1-minute buffer.
-- This caused repos to be created too early due to timezone interpretation issues.
--
-- Solution: Drop the buggy trigger and function. The correct implementation is in
-- trigger_check_assignment_for_repo_creation which properly handles:
-- 1. UTC timezone conversion for consistent comparisons
-- 2. 1-minute buffer to prevent premature creation
-- 3. Both INSERT and UPDATE operations

-- Drop the buggy trigger first (must drop before function)
DROP TRIGGER IF EXISTS trigger_create_repos_on_release ON public.assignments;

-- Drop the buggy function
DROP FUNCTION IF EXISTS public.trigger_create_repos_on_release();

-- Note: The correct trigger remains active:
-- trigger_check_assignment_for_repo_creation uses check_assignment_for_repo_creation()
-- which properly handles timezone conversions and timing buffers.

