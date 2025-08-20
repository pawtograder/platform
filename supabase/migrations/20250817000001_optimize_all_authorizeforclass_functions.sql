-- Migration: Optimize all authorizeforclass* functions for massive performance improvement
-- Problem: All functions use COUNT(*) which scans all matching rows in large user_roles tables
-- Solution: Parse user roles from JWT claims instead of querying database for O(1) performance

-- 1. Optimize authorizeforclass (checks for ANY role in class)
CREATE OR REPLACE FUNCTION "public"."authorizeforclass"("class__id" bigint) RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  user_roles_claim jsonb;
  role_record jsonb;
begin
  -- Get user roles from JWT claims instead of querying database
  user_roles_claim := current_setting('jwt.claims.user_roles', true)::jsonb;
  
  -- Handle case where JWT claims are not available (fallback to database query)
  if user_roles_claim is null then
    return exists (
      select 1
      from public.user_roles as r
      where r.class_id = class__id 
        and r.user_id = auth.uid()
    );
  end if;
  
  -- Parse JWT claims to check for ANY role in the specified class
  for role_record in select value from jsonb_array_elements(user_roles_claim)
  loop
    if (role_record->>'class_id')::bigint = class__id then
      return true;
    end if;
  end loop;
  
  return false;
end;
$$;

-- 2. Optimize authorizeforclassinstructor (checks for instructor role specifically)
CREATE OR REPLACE FUNCTION "public"."authorizeforclassinstructor"("class__id" bigint) RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  user_roles_claim jsonb;
  role_record jsonb;
begin
  -- Get user roles from JWT claims instead of querying database
  user_roles_claim := current_setting('jwt.claims.user_roles', true)::jsonb;
  
  -- Handle case where JWT claims are not available (fallback to database query)
  if user_roles_claim is null then
    return exists (
      select 1
      from public.user_roles as r
      where r.class_id = class__id 
        and r.user_id = auth.uid() 
        and r.role = 'instructor'
    );
  end if;
  
  -- Parse JWT claims to check for instructor role in the specified class
  for role_record in select value from jsonb_array_elements(user_roles_claim)
  loop
    if (role_record->>'class_id')::bigint = class__id 
       and role_record->>'role' = 'instructor' then
      return true;
    end if;
  end loop;
  
  return false;
end;
$$;

-- Ensure the function owners are set correctly
ALTER FUNCTION "public"."authorizeforclass"("class__id" bigint) OWNER TO "postgres";
ALTER FUNCTION "public"."authorizeforclassinstructor"("class__id" bigint) OWNER TO "postgres";

-- 3. Optimize authorize_for_submission (checks submission ownership)
CREATE OR REPLACE FUNCTION "public"."authorize_for_submission"("requested_submission_id" bigint) RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  user_roles_claim jsonb;
  submission_record record;
  user_private_profile_id uuid;
begin
  -- Get user roles from JWT claims to extract profile IDs
  user_roles_claim := current_setting('jwt.claims.user_roles', true)::jsonb;
  
  -- Handle case where JWT claims are not available (fallback to original query)
  if user_roles_claim is null then
    -- Original logic: check for direct ownership
    if exists (
      select 1
      from public.submissions as s
      inner join public.user_roles as r on r.private_profile_id = s.profile_id
      where r.user_id = auth.uid() and s.id = requested_submission_id
    ) then
      return true;
    end if;
    
    -- Original logic: check through assignment groups
    return exists (
      select 1
      from public.submissions as s
      inner join public.assignment_groups_members mem on mem.assignment_group_id = s.assignment_group_id
      inner join public.user_roles as r on r.private_profile_id = mem.profile_id
      where r.user_id = auth.uid() and s.id = requested_submission_id
    );
  end if;
  
  -- Get submission details with single query
  select s.profile_id, s.assignment_group_id, s.class_id
  into submission_record
  from public.submissions s
  where s.id = requested_submission_id;
  
  if not found then
    return false;
  end if;
  
  -- Get user's private_profile_id for this specific class from JWT claims
  select (role_record.value->>'private_profile_id')::uuid
  into user_private_profile_id
  from jsonb_array_elements(user_roles_claim) as role_record
  where (role_record.value->>'class_id')::bigint = submission_record.class_id
  limit 1;
  
  if user_private_profile_id is null then
    return false;
  end if;
  
  -- Check direct ownership (profile_id matches user's private_profile_id for this class)
  if submission_record.profile_id = user_private_profile_id then
    return true;
  end if;
  
  -- Check assignment group membership (if submission is for a group)
  if submission_record.assignment_group_id is not null then
    return exists (
      select 1
      from public.assignment_groups_members mem
      where mem.assignment_group_id = submission_record.assignment_group_id
        and mem.profile_id = user_private_profile_id
    );
  end if;
  
  return false;
end;
$$;

-- Ensure the function owner is set correctly
ALTER FUNCTION "public"."authorize_for_submission"("requested_submission_id" bigint) OWNER TO "postgres";

-- Add comments explaining the optimizations
COMMENT ON FUNCTION "public"."authorizeforclass"("class__id" bigint) IS 'High-performance version that parses user roles from JWT claims instead of querying database. Checks for ANY role in class. Provides O(1) performance vs O(n) database scan. Falls back to database query if JWT claims unavailable.';

COMMENT ON FUNCTION "public"."authorizeforclassinstructor"("class__id" bigint) IS 'High-performance version that parses user roles from JWT claims instead of querying database. Checks for instructor role specifically. Provides O(1) performance vs O(n) database scan. Falls back to database query if JWT claims unavailable.';

COMMENT ON FUNCTION "public"."authorize_for_submission"("requested_submission_id" bigint) IS 'Optimized version that uses submission class_id to find the exact user private_profile_id from JWT claims. Avoids user_roles table scans entirely. Reduces from 2 COUNT(*) + JOIN queries to 1 simple SELECT + 1 optional EXISTS query. Massive performance improvement for large user_roles tables.';
