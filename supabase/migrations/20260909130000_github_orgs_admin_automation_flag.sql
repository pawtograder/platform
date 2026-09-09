-- Surface `github_orgs.excluded_from_automation` through the admin RPCs.
--
-- 20260909120000 added the column but deliberately left the RPCs alone: #960 was in flight against
-- the same two functions, and replacing them from two branches would have guaranteed a conflict for
-- whichever merged second. #960 has landed, so this extends ITS signatures rather than racing them.
--
-- Until now the flag was settable only over PostgREST directly (the "Admins manage github_orgs" RLS
-- policy grants admins full CRUD). That works but is invisible: an operator looking at the per-org
-- admin page cannot see that an org is excluded, let alone reverse the seeded exclusions.

----------------------------------------------------------------------------------------
-- admin_get_github_orgs: report the flag
----------------------------------------------------------------------------------------

-- DROP before CREATE: changing a RETURNS TABLE shape is not a replace.
DROP FUNCTION IF EXISTS public.admin_get_github_orgs();

CREATE OR REPLACE FUNCTION public.admin_get_github_orgs()
RETURNS TABLE (
    org_name text,
    default_handout_template_repo text,
    default_solution_template_repo text,
    permission_sync_exempt_users text[],
    excluded_from_automation boolean,
    course_count bigint,
    is_configured boolean,
    created_at timestamptz,
    updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NOT public.authorize_for_admin() THEN
        RAISE EXCEPTION 'Access denied: Admin role required';
    END IF;

    RETURN QUERY
    WITH orgs AS (
        SELECT go.org_name FROM public.github_orgs go
        UNION
        SELECT DISTINCT c.github_org AS org_name FROM public.classes c WHERE c.github_org IS NOT NULL
    )
    SELECT
        o.org_name,
        COALESCE(go.default_handout_template_repo, 'pawtograder/template-assignment-handout'),
        COALESCE(go.default_solution_template_repo, 'pawtograder/template-assignment-grader'),
        COALESCE(go.permission_sync_exempt_users, '{}'::text[]),
        -- An org with no row has never been configured, and the column default is false.
        COALESCE(go.excluded_from_automation, false),
        (SELECT COUNT(*) FROM public.classes c WHERE c.github_org = o.org_name)::bigint,
        (go.org_name IS NOT NULL) AS is_configured,
        go.created_at,
        go.updated_at
    FROM orgs o
    LEFT JOIN public.github_orgs go ON go.org_name = o.org_name
    ORDER BY o.org_name;
END;
$$;

----------------------------------------------------------------------------------------
-- admin_upsert_github_org: accept the flag
----------------------------------------------------------------------------------------

-- Adding a parameter creates an OVERLOAD rather than replacing, and two candidates with the same
-- name leave PostgREST unable to choose. Drop #960's arity explicitly.
DROP FUNCTION IF EXISTS public.admin_upsert_github_org(text, text, text, text[]);

CREATE OR REPLACE FUNCTION public.admin_upsert_github_org(
    p_org_name text,
    p_handout text DEFAULT NULL,
    p_solution text DEFAULT NULL,
    p_permission_sync_exempt_users text[] DEFAULT NULL,
    p_excluded_from_automation boolean DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_exempt text[];
    v_login text;
BEGIN
    IF NOT public.authorize_for_admin() THEN
        RAISE EXCEPTION 'Access denied: Admin role required';
    END IF;

    IF p_org_name IS NULL OR trim(p_org_name) = '' THEN
        RAISE EXCEPTION 'Org name is required';
    END IF;

    IF NULLIF(trim(p_handout), '') IS NOT NULL AND trim(p_handout) !~ '^[^/[:space:]]+/[^/[:space:]]+$' THEN
        RAISE EXCEPTION 'Invalid handout template repo "%": expected "owner/repo"', p_handout;
    END IF;
    IF NULLIF(trim(p_solution), '') IS NOT NULL AND trim(p_solution) !~ '^[^/[:space:]]+/[^/[:space:]]+$' THEN
        RAISE EXCEPTION 'Invalid solution template repo "%": expected "owner/repo"', p_solution;
    END IF;

    IF p_permission_sync_exempt_users IS NULL THEN
        v_exempt := NULL;
    ELSE
        SELECT COALESCE(array_agg(DISTINCT lower(trim(u)) ORDER BY lower(trim(u))), '{}'::text[])
        INTO v_exempt
        FROM unnest(p_permission_sync_exempt_users) AS u
        WHERE NULLIF(trim(u), '') IS NOT NULL;

        FOREACH v_login IN ARRAY v_exempt LOOP
            IF v_login !~ '^[a-z0-9](?:[a-z0-9]|-[a-z0-9]){0,38}$' THEN
                RAISE EXCEPTION 'Invalid GitHub login "%": expected a GitHub username', v_login;
            END IF;
        END LOOP;
    END IF;

    -- The template columns are handled EXACTLY as #960 left them, including
    -- resolve_effective_template_repo on both branches: a blank field means "use the site default",
    -- which is the GUC tier rather than the constant, and preserving that is what lets an admin
    -- clear an override back to the default. Only excluded_from_automation is new here.
    INSERT INTO public.github_orgs (
        org_name,
        default_handout_template_repo,
        default_solution_template_repo,
        permission_sync_exempt_users,
        excluded_from_automation,
        created_by,
        updated_by
    ) VALUES (
        trim(p_org_name),
        public.resolve_effective_template_repo(
            NULLIF(trim(p_handout), ''), NULL,
            'app.settings.default_handout_template_repo', 'pawtograder/template-assignment-handout'),
        public.resolve_effective_template_repo(
            NULLIF(trim(p_solution), ''), NULL,
            'app.settings.default_solution_template_repo', 'pawtograder/template-assignment-grader'),
        COALESCE(v_exempt, '{}'::text[]),
        COALESCE(p_excluded_from_automation, false),
        auth.uid(),
        auth.uid()
    )
    ON CONFLICT (org_name) DO UPDATE SET
        default_handout_template_repo = public.resolve_effective_template_repo(
            NULLIF(trim(p_handout), ''), NULL,
            'app.settings.default_handout_template_repo', 'pawtograder/template-assignment-handout'),
        default_solution_template_repo = public.resolve_effective_template_repo(
            NULLIF(trim(p_solution), ''), NULL,
            'app.settings.default_solution_template_repo', 'pawtograder/template-assignment-grader'),
        -- NULL means "not supplied by this caller", so each field survives a save from a client that
        -- does not know about it. Clearing the exemption list is an explicit empty array.
        permission_sync_exempt_users = COALESCE(v_exempt, public.github_orgs.permission_sync_exempt_users),
        excluded_from_automation = COALESCE(p_excluded_from_automation, public.github_orgs.excluded_from_automation),
        updated_by = auth.uid(),
        updated_at = now();
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_get_github_orgs() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_upsert_github_org(text, text, text, text[], boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.admin_get_github_orgs() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_upsert_github_org(text, text, text, text[], boolean) TO authenticated, service_role;
