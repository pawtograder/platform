-- Convert custom_access_token_hook from PLV8 to PLpgSQL
-- This removes the dependency on PLV8 extension and uses native PostgreSQL functions

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
    -- Initialize the event with claims if it doesn't exist
    modified_event := event;
    IF NOT (modified_event ? 'claims') THEN
        modified_event := jsonb_set(modified_event, '{claims}', '{}');
    END IF;
    
    -- Fetch the current user's user_role from the public user_roles table
    SELECT to_jsonb(array_agg(row_to_json(ur)))
    FROM (
        SELECT role, class_id, public_profile_id, private_profile_id 
        FROM public.user_roles 
        WHERE user_id = (event->>'user_id')::uuid
    ) ur
    INTO user_roles_result;
    
    -- If no results found, set to empty array
    IF user_roles_result IS NULL THEN
        user_roles_result := '[]'::jsonb;
    END IF;
    
    -- Find the user's github identity, if one exists
    SELECT to_jsonb(array_agg(row_to_json(gh)))
    FROM (
        SELECT identity_data 
        FROM auth.identities 
        WHERE provider = 'github' 
        AND user_id = (event->>'user_id')::uuid
    ) gh
    INTO github_result;
    
    -- If no results found, set to empty array
    IF github_result IS NULL THEN
        github_result := '[]'::jsonb;
    END IF;
    
    -- Update the claims with user_roles and github data
    modified_event := jsonb_set(
        modified_event, 
        '{claims,user_roles}', 
        user_roles_result
    );
    
    modified_event := jsonb_set(
        modified_event, 
        '{claims,github}', 
        github_result
    );
    
    RETURN modified_event;
END;
$function$;
