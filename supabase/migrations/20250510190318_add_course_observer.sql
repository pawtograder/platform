alter type "public"."app_role" rename to "app_role__old_version_to_be_dropped";

create type "public"."app_role" as enum ('admin', 'instructor', 'grader', 'student', 'course_observer');

-- This will throw an error until all the RLS policies are updated
alter table "public"."user_roles" alter column role type "public"."app_role" using role::text::"public"."app_role";

drop type "public"."app_role__old_version_to_be_dropped";

CREATE OR REPLACE FUNCTION "public"."authorizeforclasscourseobserver"("class__id" bigint) RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  bind_permissions int;
begin
  -- Check if the user has the 'course_observer' role in the specified class
  select count(*)
  into bind_permissions
  from public.user_roles as r
  where r.class_id = class__id
    and r.user_id = auth.uid()
    and r.role = 'course_observer';

  return bind_permissions > 0;
end;
$$;

ALTER FUNCTION "public"."authorizeforclasscourseobserver"("class__id" bigint) OWNER TO "postgres";


