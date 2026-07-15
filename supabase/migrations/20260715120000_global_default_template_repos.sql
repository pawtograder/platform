-- Per-deployment (site-wide) default handout/solution template repos.
--
-- Background: 20260529140000_github_org_templates.sql introduced a three-tier resolution for the
-- handout/solution template repos: per-class override -> per-GitHub-org default -> hardcoded
-- constant ('pawtograder/template-assignment-handout' / '-grader'). On a fresh deployment that runs
-- its own GitHub org, neither a per-class override nor a github_orgs row exists yet, so every class
-- falls all the way through to the pawtograder/* constants baked into the migration. Changing that
-- default meant editing a migration.
--
-- This migration inserts a new "site default" tier, read from a Postgres GUC, BETWEEN the org
-- default and the hardcoded constant:
--     class override -> org default -> app.settings.default_*_template_repo (GUC) -> constant
--
-- The GUC is the "env var to the Postgres pod" equivalent, set per-deployment exactly like the LTI
-- config in 20260528120000_lti_1_3_integration.sql:
--     ALTER DATABASE postgres SET app.settings.default_handout_template_repo  = 'my-org/handout';
--     ALTER DATABASE postgres SET app.settings.default_solution_template_repo = 'my-org/grader';
-- (existing sessions must reconnect to pick up a DATABASE-level SET).
--
-- The resolution + the "owner/repo" validation (previously duplicated per call site) are centralized
-- in one STABLE helper, public.resolve_effective_template_repo, so the GUC name, the format check,
-- and the hardcoded constant live in a single place. The helper validates the GUC value the same
-- way admin-supplied overrides are validated (set_class_template_overrides / admin_upsert_github_org):
-- a deployment typo (missing slash, stray whitespace) is ignored and falls through to the constant
-- rather than silently propagating an invalid repo string into the repo-creation edge functions.
--
-- The TS constants in supabase/functions/_shared/GitHubSyncHelpers.ts remain the last-resort literal
-- and are unchanged; resolve_class_template_repos stays the source of truth.

----------------------------------------------------------------------------------------
-- Shared resolver: override -> org default -> validated GUC -> constant
----------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_effective_template_repo(
    p_override text,
    p_org_default text,
    p_guc_name text,
    p_constant text
) RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
    SELECT COALESCE(
        p_override,
        p_org_default,
        -- Only honor the GUC when it's a well-formed "owner/repo"; otherwise ignore it so a
        -- deployment typo can't propagate an invalid repo string (matches the override validation).
        CASE
            WHEN current_setting(p_guc_name, true) ~ '^[^/[:space:]]+/[^/[:space:]]+$'
            THEN current_setting(p_guc_name, true)
        END,
        p_constant
    );
$$;

COMMENT ON FUNCTION public.resolve_effective_template_repo(text, text, text, text) IS
    'Resolve a template repo: per-class/admin override -> org default -> validated app.settings GUC -> hardcoded constant.';

----------------------------------------------------------------------------------------
-- resolve_class_template_repos: the hot path used by the edge functions when creating repos.
-- The GUC tier only matters here when a class has no per-class override AND no github_orgs row,
-- i.e. the fresh-deployment case.
----------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_class_template_repos(p_class_id bigint)
RETURNS TABLE (handout_template_repo text, solution_template_repo text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NOT (auth.role() = 'service_role' OR public.authorizeforclassinstructor(p_class_id)) THEN
        RAISE EXCEPTION 'Access denied: instructor role required for class %', p_class_id;
    END IF;

    RETURN QUERY
    SELECT
        public.resolve_effective_template_repo(
            c.handout_template_repo, go.default_handout_template_repo,
            'app.settings.default_handout_template_repo', 'pawtograder/template-assignment-handout'),
        public.resolve_effective_template_repo(
            c.solution_template_repo, go.default_solution_template_repo,
            'app.settings.default_solution_template_repo', 'pawtograder/template-assignment-grader')
    FROM public.classes c
    LEFT JOIN public.github_orgs go ON go.org_name = c.github_org
    WHERE c.id = p_class_id;
END;
$$;

----------------------------------------------------------------------------------------
-- admin_get_github_orgs: reports each org's effective default; the GUC tier applies to orgs
-- that don't yet have a github_orgs row (is_configured = false).
----------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_get_github_orgs()
RETURNS TABLE (
    org_name text,
    default_handout_template_repo text,
    default_solution_template_repo text,
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
        public.resolve_effective_template_repo(
            NULL, go.default_handout_template_repo,
            'app.settings.default_handout_template_repo', 'pawtograder/template-assignment-handout'),
        public.resolve_effective_template_repo(
            NULL, go.default_solution_template_repo,
            'app.settings.default_solution_template_repo', 'pawtograder/template-assignment-grader'),
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
-- admin_upsert_github_org: when the admin leaves a default blank, materialize the site default
-- (GUC) rather than the hardcoded constant, so a fresh org inherits the deployment's default.
----------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_upsert_github_org(
    p_org_name text,
    p_handout text DEFAULT NULL,
    p_solution text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NOT public.authorize_for_admin() THEN
        RAISE EXCEPTION 'Access denied: Admin role required';
    END IF;

    IF p_org_name IS NULL OR trim(p_org_name) = '' THEN
        RAISE EXCEPTION 'Org name is required';
    END IF;

    -- A non-empty default must be exactly "owner/repo" (NULL/empty falls back to site default -> constant).
    IF NULLIF(trim(p_handout), '') IS NOT NULL AND trim(p_handout) !~ '^[^/[:space:]]+/[^/[:space:]]+$' THEN
        RAISE EXCEPTION 'Invalid handout template repo "%": expected "owner/repo"', p_handout;
    END IF;
    IF NULLIF(trim(p_solution), '') IS NOT NULL AND trim(p_solution) !~ '^[^/[:space:]]+/[^/[:space:]]+$' THEN
        RAISE EXCEPTION 'Invalid solution template repo "%": expected "owner/repo"', p_solution;
    END IF;

    INSERT INTO public.github_orgs (
        org_name,
        default_handout_template_repo,
        default_solution_template_repo,
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
        updated_by = auth.uid(),
        updated_at = now();
END;
$$;

----------------------------------------------------------------------------------------
-- admin_get_org_courses: effective (resolved) templates per course, mirroring the resolver.
----------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_get_org_courses(p_org_name text)
RETURNS TABLE (
    id bigint,
    name text,
    term integer,
    archived boolean,
    handout_template_repo text,
    solution_template_repo text,
    effective_handout_template_repo text,
    effective_solution_template_repo text
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
    SELECT
        c.id,
        c.name,
        c.term,
        COALESCE(c.archived, false),
        c.handout_template_repo,
        c.solution_template_repo,
        public.resolve_effective_template_repo(
            c.handout_template_repo, go.default_handout_template_repo,
            'app.settings.default_handout_template_repo', 'pawtograder/template-assignment-handout'),
        public.resolve_effective_template_repo(
            c.solution_template_repo, go.default_solution_template_repo,
            'app.settings.default_solution_template_repo', 'pawtograder/template-assignment-grader')
    FROM public.classes c
    LEFT JOIN public.github_orgs go ON go.org_name = c.github_org
    WHERE c.github_org = p_org_name
    ORDER BY c.name;
END;
$$;

----------------------------------------------------------------------------------------
-- Grants: DO NOT expose this helper as a PostgREST RPC. It returns current_setting(p_guc_name)
-- for a caller-supplied GUC name, so granting it to `authenticated` would let any signed-in user
-- read arbitrary GUC-stored settings — including secrets like app.settings.lti_cron_secret that
-- happen to match the owner/repo shape. The SECURITY DEFINER resolver/admin functions above call it
-- as the function owner, so no role grant is needed for internal use. Revoke the default PUBLIC
-- EXECUTE so it is not reachable via the API.
----------------------------------------------------------------------------------------

-- Revoke from the API roles explicitly (not just PUBLIC): CREATE OR REPLACE preserves prior ACLs,
-- so this guarantees the owner-only end state even if an earlier revision granted these roles.
REVOKE ALL ON FUNCTION public.resolve_effective_template_repo(text, text, text, text)
    FROM PUBLIC, anon, authenticated, service_role;
