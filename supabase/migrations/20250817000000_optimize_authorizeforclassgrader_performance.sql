-- Migration: Optimize authorizeforclassgrader function performance
-- Problem: The function uses COUNT(*) which scans all matching rows in large user_roles tables
-- Solution: Parse user roles from JWT claims instead of querying database for O(1) performance

-- Drop and recreate the function with JWT-based implementation
CREATE OR REPLACE FUNCTION "public"."authorizeforclassgrader"("class__id" bigint) RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  user_roles_claim jsonb;
  role_record jsonb;
begin
  -- Get user roles from JWT claims instead of querying database
  -- This avoids expensive database lookups on large user_roles tables
  user_roles_claim := current_setting('jwt.claims.user_roles', true)::jsonb;
  
  -- Handle case where JWT claims are not available (fallback to database query)
  if user_roles_claim is null then
    return exists (
      select 1
      from public.user_roles as r
      where r.class_id = class__id 
        and r.user_id = auth.uid() 
        and r.role in ('instructor', 'grader')
    );
  end if;
  
  -- Parse JWT claims to check for instructor/grader role in the specified class
  for role_record in select value from jsonb_array_elements(user_roles_claim)
  loop
    if (role_record->>'class_id')::bigint = class__id 
       and role_record->>'role' in ('instructor', 'grader') then
      return true;
    end if;
  end loop;
  
  return false;
end;
$$;

-- Ensure the function owner is set correctly
ALTER FUNCTION "public"."authorizeforclassgrader"("class__id" bigint) OWNER TO "postgres";

-- Add a comment explaining the optimization
COMMENT ON FUNCTION "public"."authorizeforclassgrader"("class__id" bigint) IS 'High-performance version that parses user roles from JWT claims instead of querying database. Provides O(1) performance vs O(n) database scan. Falls back to database query if JWT claims unavailable.';
