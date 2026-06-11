-- admin_lookup_user_by_email: admin-only helper for the "Create Class" workflow.
-- Given an email, returns the matching user's id together with the name on their
-- MOST RECENT class private profile (so the create-class form can pre-fill the
-- instructor's name instead of making the admin retype it). Returns NO ROWS when
-- no user has that email, which the frontend treats as "no match -> type a name".

CREATE OR REPLACE FUNCTION public.admin_lookup_user_by_email(p_email text)
RETURNS TABLE(user_id uuid, name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_user_id uuid;
    v_name text;
BEGIN
    IF NOT public.authorize_for_admin() THEN
        RAISE EXCEPTION 'Access denied: Admin role required';
    END IF;

    SELECT au.id INTO v_user_id
    FROM auth.users au
    WHERE au.email = p_email
    LIMIT 1;

    IF v_user_id IS NULL THEN
        RETURN; -- no match
    END IF;

    -- Prefer the name on the user's most recent ACTIVE class private profile
    -- (most recent = the class they were most recently enrolled in, i.e. the
    -- highest user_roles.id), falling back to the public.users mirror name.
    -- Skip disabled enrollments so a dropped class doesn't supply the name.
    SELECT p.name INTO v_name
    FROM public.user_roles ur
    JOIN public.profiles p ON p.id = ur.private_profile_id
    WHERE ur.user_id = v_user_id
      AND p.is_private_profile = true
      AND COALESCE(ur.disabled, false) = false
    ORDER BY ur.id DESC
    LIMIT 1;

    IF v_name IS NULL THEN
        SELECT u.name INTO v_name FROM public.users u WHERE u.user_id = v_user_id;
    END IF;

    user_id := v_user_id;
    name := v_name;
    RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_lookup_user_by_email(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_lookup_user_by_email(text) TO service_role;
