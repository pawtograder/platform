-- Per-org allowlist of GitHub users that repo permission sync must never remove.
--
-- `syncRepoPermissions` reconciles a repo's collaborators against the course roster plus the staff
-- team, and removes everyone else. Some accounts legitimately hold access that the roster cannot
-- explain — an institution's IT or ops account, a long-lived integration user, a co-teaching
-- faculty member carried on the repo directly rather than through the staff team.
--
-- That was previously handled by `adminsThatShouldNotBeListedAsAdmins`, a five-name array hardcoded
-- in GitHubWrapper.ts. It is invisible to the admins who actually know who those people are, it
-- applies to EVERY org rather than the one org it was added for, and changing it needs a code
-- change and a deploy. This moves the decision to the per-org config that admins already manage,
-- and keeps the constant only as a global backstop so nothing regresses on deploy.

ALTER TABLE public.github_orgs
    ADD COLUMN IF NOT EXISTS permission_sync_exempt_users text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.github_orgs.permission_sync_exempt_users IS
    'GitHub logins (lowercased) that repo permission sync must never remove from repos in this org. '
    'For access that the course roster and staff team cannot explain but which is intentional. '
    'Additive to the global backstop list in GitHubWrapper.ts.';

----------------------------------------------------------------------------------------
-- admin_get_github_orgs: expose the new column
----------------------------------------------------------------------------------------

-- DROP before CREATE: changing a function's RETURNS TABLE shape is not a replace, and
-- CREATE OR REPLACE would fail rather than migrate it.
DROP FUNCTION IF EXISTS public.admin_get_github_orgs();

CREATE OR REPLACE FUNCTION public.admin_get_github_orgs()
RETURNS TABLE (
    org_name text,
    default_handout_template_repo text,
    default_solution_template_repo text,
    permission_sync_exempt_users text[],
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
-- admin_upsert_github_org: accept the new column
----------------------------------------------------------------------------------------

-- Adding a parameter creates an OVERLOAD rather than replacing, and two candidates with the same
-- name leave PostgREST unable to choose. Drop the old arity explicitly.
DROP FUNCTION IF EXISTS public.admin_upsert_github_org(text, text, text);

CREATE OR REPLACE FUNCTION public.admin_upsert_github_org(
    p_org_name text,
    p_handout text DEFAULT NULL,
    p_solution text DEFAULT NULL,
    p_permission_sync_exempt_users text[] DEFAULT NULL
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

    -- A non-empty default must be exactly "owner/repo" (NULL/empty falls back to the constant).
    IF NULLIF(trim(p_handout), '') IS NOT NULL AND trim(p_handout) !~ '^[^/[:space:]]+/[^/[:space:]]+$' THEN
        RAISE EXCEPTION 'Invalid handout template repo "%": expected "owner/repo"', p_handout;
    END IF;
    IF NULLIF(trim(p_solution), '') IS NOT NULL AND trim(p_solution) !~ '^[^/[:space:]]+/[^/[:space:]]+$' THEN
        RAISE EXCEPTION 'Invalid solution template repo "%": expected "owner/repo"', p_solution;
    END IF;

    -- Normalize to lowercase and drop blanks/duplicates: the sync compares lowercased logins, so an
    -- entry typed with GitHub's display casing would silently never match and the exemption would
    -- appear configured while doing nothing.
    IF p_permission_sync_exempt_users IS NULL THEN
        v_exempt := NULL;
    ELSE
        SELECT COALESCE(array_agg(DISTINCT lower(trim(u)) ORDER BY lower(trim(u))), '{}'::text[])
        INTO v_exempt
        FROM unnest(p_permission_sync_exempt_users) AS u
        WHERE NULLIF(trim(u), '') IS NOT NULL;

        FOREACH v_login IN ARRAY v_exempt LOOP
            -- GitHub logins: alphanumeric with single internal hyphens, 39 chars max. Rejecting the
            -- obviously-wrong shapes here stops "owner/repo" or an email being pasted in and then
            -- never matching anything.
            IF v_login !~ '^[a-z0-9](?:[a-z0-9]|-[a-z0-9]){0,38}$' THEN
                RAISE EXCEPTION 'Invalid GitHub login "%": expected a GitHub username', v_login;
            END IF;
        END LOOP;
    END IF;

    INSERT INTO public.github_orgs (
        org_name,
        default_handout_template_repo,
        default_solution_template_repo,
        permission_sync_exempt_users,
        created_by,
        updated_by
    ) VALUES (
        trim(p_org_name),
        COALESCE(NULLIF(trim(p_handout), ''), 'pawtograder/template-assignment-handout'),
        COALESCE(NULLIF(trim(p_solution), ''), 'pawtograder/template-assignment-grader'),
        COALESCE(v_exempt, '{}'::text[]),
        auth.uid(),
        auth.uid()
    )
    ON CONFLICT (org_name) DO UPDATE SET
        default_handout_template_repo = COALESCE(NULLIF(trim(p_handout), ''), 'pawtograder/template-assignment-handout'),
        default_solution_template_repo = COALESCE(NULLIF(trim(p_solution), ''), 'pawtograder/template-assignment-grader'),
        -- NULL means "not supplied by this caller", so the existing list survives a save from a
        -- client that only knows about the template fields. Clearing is an explicit empty array.
        permission_sync_exempt_users = COALESCE(v_exempt, public.github_orgs.permission_sync_exempt_users),
        updated_by = auth.uid(),
        updated_at = now();
END;
$$;

----------------------------------------------------------------------------------------
-- Grants (the DROPs above took the old ones with them)
----------------------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION public.admin_get_github_orgs() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_upsert_github_org(text, text, text, text[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.admin_get_github_orgs() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_upsert_github_org(text, text, text, text[]) TO authenticated, service_role;
