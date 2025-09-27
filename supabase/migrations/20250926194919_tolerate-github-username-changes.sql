ALTER TABLE "public"."users" ADD COLUMN "github_user_id" text;
ALTER TABLE "public"."users" ADD COLUMN "last_github_user_sync" timestamp with time zone;

-- Ensure github user ID is tracked whenever a GitHub identity is inserted/updated
CREATE OR REPLACE FUNCTION public.update_github_profile()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  BEGIN
    IF NEW.provider <> 'github' THEN
      RETURN NEW;
    END IF;

    UPDATE public.users
    SET
      github_username = json_extract_path_text(to_json(NEW.identity_data), 'user_name'),
      github_user_id = NEW.provider_id
    WHERE user_id = NEW.user_id;
    RETURN NEW;
END;
$function$;

-- Backfill github_user_id from existing auth.identities rows
UPDATE public.users u
SET github_user_id = i.provider_id
FROM auth.identities i
WHERE i.user_id = u.user_id
  AND i.provider = 'github';