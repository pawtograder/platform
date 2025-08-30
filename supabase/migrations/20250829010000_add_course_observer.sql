alter type "public"."app_role" add value if not exists 'course_observer';

CREATE OR REPLACE FUNCTION "public"."authorizeforclasscourseobserver"("class__id" bigint) RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  return exists (
    select 1
    from public.user_roles r
    where r.class_id = class__id
      and r.user_id = auth.uid()
      and r.role = 'course_observer'
  );
end;
$$;

ALTER FUNCTION "public"."authorizeforclasscourseobserver"("class__id" bigint) OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.authorizeforclasscourseobserver(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.authorizeforclasscourseobserver(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.authorizeforclasscourseobserver(bigint) TO service_role;
COMMENT ON FUNCTION public.authorizeforclasscourseobserver(bigint)
  IS 'Returns true if current auth.uid() has course_observer role for the given class id.';


