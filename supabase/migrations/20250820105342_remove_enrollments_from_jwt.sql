-- Migration: Revert JWT optimization for authorizeforclass* functions
-- This reverts the changes made in 20250817000001_optimize_all_authorizeforclass_functions.sql
-- Restores database-based implementations but with performance optimization: EXISTS instead of COUNT(*)

-- 1. Restore original authorizeforclass function (checks for ANY role in class)
-- Performance optimized: use EXISTS instead of COUNT(*) for faster execution
CREATE OR REPLACE FUNCTION "public"."authorizeforclass"("class__id" bigint) RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  -- Use EXISTS instead of COUNT(*) - stops at first match instead of scanning all rows
  return exists (
    select 1
    from public.user_roles as r
    where r.class_id = class__id and r.user_id = auth.uid()
  );
end;
$$;

-- 2. Restore original authorizeforclassinstructor function (checks for instructor role specifically)
-- Performance optimized: use EXISTS instead of COUNT(*) for faster execution
CREATE OR REPLACE FUNCTION "public"."authorizeforclassinstructor"("class__id" bigint) RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  -- Use EXISTS instead of COUNT(*) - stops at first match instead of scanning all rows
  return exists (
    select 1
    from public.user_roles as r
    where r.class_id = class__id and r.user_id = auth.uid() and r.role = 'instructor'
  );
end;
$$;

-- 3. Restore original authorize_for_submission function (checks submission ownership)
CREATE OR REPLACE FUNCTION "public"."authorize_for_submission"("requested_submission_id" bigint) RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  -- Check for direct ownership
  if exists (
    select 1
    from public.submissions as s
    inner join public.user_roles as r on r.private_profile_id = s.profile_id
    where r.user_id = auth.uid() and s.id = requested_submission_id
  ) then
    return true;
  end if;
  
  -- Check through assignment groups
  return exists (
    select 1
    from public.submissions as s
    inner join public.assignment_groups_members mem on mem.assignment_group_id = s.assignment_group_id
    inner join public.user_roles as r on r.private_profile_id = mem.profile_id
    where r.user_id = auth.uid() and s.id = requested_submission_id
  );
end;
$$;

-- Ensure the function owners are set correctly
ALTER FUNCTION "public"."authorizeforclass"("class__id" bigint) OWNER TO "postgres";
ALTER FUNCTION "public"."authorizeforclassinstructor"("class__id" bigint) OWNER TO "postgres";
ALTER FUNCTION "public"."authorize_for_submission"("requested_submission_id" bigint) OWNER TO "postgres";

-- Remove the JWT optimization comments and restore database-based comments with performance notes
COMMENT ON FUNCTION "public"."authorizeforclass"("class__id" bigint) IS 'Checks if the current user has ANY role in the specified class. Uses EXISTS for optimal performance - stops at first match instead of scanning all rows.';

COMMENT ON FUNCTION "public"."authorizeforclassinstructor"("class__id" bigint) IS 'Checks if the current user has instructor role in the specified class. Uses EXISTS for optimal performance - stops at first match instead of scanning all rows.';

COMMENT ON FUNCTION "public"."authorize_for_submission"("requested_submission_id" bigint) IS 'Checks if the current user has access to a submission either through direct ownership or assignment group membership. Already optimized with EXISTS queries.';

-- Performance optimization notes:
-- The user_roles table already has optimal indexes for these queries:
-- - user_roles_user_id_role_key (user_id, role, class_id) - unique index covers our lookup patterns
-- - user_roles_class_id_role_idx (class_id, role) - composite index for class+role queries  
-- - idx_user_roles_class_id and idx_user_roles_user_id - individual column indexes
-- These existing indexes make the EXISTS queries very fast even on large user_roles tables

-- Migration notes:
-- This migration reverts the JWT claims optimization and restores database-based authorization
-- Performance optimized with EXISTS instead of COUNT(*) - significant improvement over original
-- EXISTS stops at first match vs COUNT(*) which scans all matching rows
-- Should perform well with proper indexing, though not as fast as JWT claims approach

-- Remove enrollments from JWT claims, keep function for compatibility with existing deployments that may have it hardcoded
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    user_roles_result jsonb;
    github_result jsonb;
    modified_event jsonb;
BEGIN
  return event;
END;
$function$;