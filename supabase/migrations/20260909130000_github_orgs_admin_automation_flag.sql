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
-- Forbid case-duplicate rows
----------------------------------------------------------------------------------------

-- `org_name` is a case-sensitive text primary key while GitHub org logins are not, so the table can
-- in principle hold `Pawtograder-Playground` AND `pawtograder-playground`. That state makes the
-- case-insensitive joins below one-to-many and lets an admin untick a flag on one variant while the
-- other keeps applying, so it must not exist.
--
-- The index only FORBIDS it; it deliberately does not repair it. An earlier draft of this migration
-- merged duplicates automatically — OR-ing the automation flag, unioning the exemption lists,
-- repointing dependent classes and deleting the losers — and every review pass found another thing
-- that silently destroyed: the losing row's template defaults, and the classes left pointing at a
-- spelling whose exact-match consumers (resolve_class_template_repos, and the exemption read in
-- GitHubWrapper) then found nothing. Production has 2 github_orgs rows and ZERO case-duplicate
-- groups, so that machinery was carrying real risk for a state that does not occur.
--
-- If some deployment does have duplicates, this migration fails and an operator resolves them
-- deliberately. A blocked deploy is a much better outcome than a migration quietly discarding
-- somebody's template configuration.
CREATE UNIQUE INDEX IF NOT EXISTS github_orgs_org_name_lower_key ON public.github_orgs (lower(org_name));

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
    override_handout_template_repo text,
    override_solution_template_repo text,
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

    -- Coalesced case-insensitively. `github_orgs.org_name` is a case-sensitive text primary key
    -- while GitHub org logins are not, and admin_create_class / admin_update_class store whatever
    -- capitalization was typed. Joining exactly made a configured `Pawtograder-Playground` and a
    -- class-supplied `pawtograder-playground` two separate entries: the configured spelling showed
    -- the real exclusion and zero courses, the class spelling showed the courses and
    -- excluded_from_automation = false. Saving the one that looked right then created a SECOND row
    -- while the original kept excluding the org — with the checkbox reading unticked.
    --
    -- The CONFIGURED spelling wins as the display name when a row exists, so what the page saves
    -- updates that row rather than forking a new one.
    RETURN QUERY
    WITH keys AS (
        SELECT lower(go.org_name) AS key FROM public.github_orgs go
        UNION
        SELECT DISTINCT lower(c.github_org) FROM public.classes c WHERE c.github_org IS NOT NULL
    ),
    orgs AS (
        SELECT
            k.key,
            COALESCE(
                (SELECT g.org_name FROM public.github_orgs g WHERE lower(g.org_name) = k.key LIMIT 1),
                (SELECT c.github_org FROM public.classes c WHERE lower(c.github_org) = k.key LIMIT 1)
            ) AS org_name
        FROM keys k
    )
    SELECT
        o.org_name,
        -- Through resolve_effective_template_repo, NOT a bare COALESCE to the constant: an org with
        -- no row must still report the deployment's app.settings default (20260715120000), or a
        -- self-hosted site sees pawtograder/* here and materializes it on the next save. Carried
        -- over verbatim from #960 — an earlier draft of this migration dropped it while copying the
        -- function to extend it, which is exactly the regression that comment warns about.
        public.resolve_effective_template_repo(
            NULL, go.default_handout_template_repo,
            'app.settings.default_handout_template_repo', 'pawtograder/template-assignment-handout'),
        public.resolve_effective_template_repo(
            NULL, go.default_solution_template_repo,
            'app.settings.default_solution_template_repo', 'pawtograder/template-assignment-grader'),
        -- ...and the RAW stored values alongside them, which is what the per-org admin page fills
        -- its inputs from. Reporting only the resolved value made the page unable to tell "this org
        -- stores nothing and follows the deployment default" from "this org pins that exact repo":
        -- it showed the resolved string in the input, and the next save -- even one that only
        -- ticked the automation checkbox -- posted it back as an explicit override. 20260909120000
        -- made these columns nullable precisely so seeded orgs could inherit, and a single visit to
        -- the page undid that for every org it touched. NULL here means "inherits".
        go.default_handout_template_repo,
        go.default_solution_template_repo,
        COALESCE(go.permission_sync_exempt_users, '{}'::text[]),
        -- An org with no row has never been configured, and the column default is false.
        COALESCE(go.excluded_from_automation, false),
        (SELECT COUNT(*) FROM public.classes c WHERE lower(c.github_org) = o.key)::bigint,
        (go.org_name IS NOT NULL) AS is_configured,
        go.created_at,
        go.updated_at
    FROM orgs o
    LEFT JOIN public.github_orgs go ON lower(go.org_name) = o.key
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
    v_org text;
BEGIN
    IF NOT public.authorize_for_admin() THEN
        RAISE EXCEPTION 'Access denied: Admin role required';
    END IF;

    IF p_org_name IS NULL OR trim(p_org_name) = '' THEN
        RAISE EXCEPTION 'Org name is required';
    END IF;

    -- Target an existing row case-insensitively, for the same reason admin_get_github_orgs
    -- coalesces: saving the class-supplied spelling of an org that is already configured under a
    -- different capitalization must UPDATE that row, not insert a second one that then competes
    -- with it. Falls back to what was supplied when there is no existing row.
    v_org := COALESCE(
        (SELECT g.org_name FROM public.github_orgs g WHERE lower(g.org_name) = lower(trim(p_org_name)) LIMIT 1),
        trim(p_org_name)
    );

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
            -- The length check is NOT redundant with the pattern: each `-[a-z0-9]` repetition
            -- consumes two characters, so the regex alone admits hyphenated strings far longer than
            -- GitHub's 39-character limit. An impossible login saved as an active exemption can
            -- never match a collaborator, so permission sync would still remove the very account
            -- the operator believed was protected. Carried over verbatim from #960.
            IF length(v_login) > 39 OR v_login !~ '^[a-z0-9](?:[a-z0-9]|-[a-z0-9]){0,38}$' THEN
                RAISE EXCEPTION 'Invalid GitHub login "%": expected a GitHub username', v_login;
            END IF;
        END LOOP;
    END IF;

    -- The template columns store what was supplied, NOT resolve_effective_template_repo's answer.
    -- #960 resolved them here, which meant a blank field wrote the deployment's current GUC value
    -- into the row as a literal override. That reads identically the day it is written and then
    -- stops tracking the deployment default forever after -- and since the column was NOT NULL at
    -- the time, there was no other way to say "inherit". 20260909120000 dropped the NOT NULL, so
    -- blank can now be recorded as blank: NULL, resolved on every read by the same helper.
    --
    -- Consequence for callers: NULL/omitted CLEARS an override here, whereas it means "leave as-is"
    -- for the exemption list and the automation flag below. That asymmetry is deliberate. The admin
    -- page always renders both template inputs from the stored override, so it always posts the
    -- admin's actual intent for them; the other two fields exist on clients that may not know about
    -- them at all.
    INSERT INTO public.github_orgs (
        org_name,
        default_handout_template_repo,
        default_solution_template_repo,
        permission_sync_exempt_users,
        excluded_from_automation,
        created_by,
        updated_by
    ) VALUES (
        v_org,
        NULLIF(trim(p_handout), ''),
        NULLIF(trim(p_solution), ''),
        COALESCE(v_exempt, '{}'::text[]),
        COALESCE(p_excluded_from_automation, false),
        auth.uid(),
        auth.uid()
    )
    ON CONFLICT (org_name) DO UPDATE SET
        default_handout_template_repo = NULLIF(trim(p_handout), ''),
        default_solution_template_repo = NULLIF(trim(p_solution), ''),
        -- NULL means "not supplied by this caller", so each field survives a save from a client that
        -- does not know about it. Clearing the exemption list is an explicit empty array.
        permission_sync_exempt_users = COALESCE(v_exempt, public.github_orgs.permission_sync_exempt_users),
        excluded_from_automation = COALESCE(p_excluded_from_automation, public.github_orgs.excluded_from_automation),
        updated_by = auth.uid(),
        updated_at = now();
END;
$$;

----------------------------------------------------------------------------------------
-- admin_get_org_courses: match the org case-insensitively
----------------------------------------------------------------------------------------

-- admin_get_github_orgs now reports the CONFIGURED spelling as an org's display name, and the list
-- page puts that spelling straight into the detail-page URL. This companion RPC still compared
-- exactly, so an org configured as `Pawtograder-Playground` whose classes store
-- `pawtograder-playground` showed a non-zero course count on the list and ZERO courses on the
-- detail page — which also disables the course-backed repo editors there, since they need a course
-- for their auth context.
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
    LEFT JOIN public.github_orgs go ON lower(go.org_name) = lower(c.github_org)
    WHERE lower(c.github_org) = lower(p_org_name)
    ORDER BY c.name;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_get_org_courses(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_get_org_courses(text) TO authenticated, service_role;

----------------------------------------------------------------------------------------
-- resolve_class_template_repos: match the org case-insensitively
----------------------------------------------------------------------------------------

-- The runtime consumer, and the last exact-case one left. `classes.github_org` keeps whatever
-- capitalization was typed (admin_create_class and admin_update_class both store it verbatim), so a
-- class recorded as `Khoury-CS3650` never matches a `khoury-cs3650` configuration row and silently
-- provisions every assignment from the deployment defaults instead of the org's configured
-- templates. The admin RPCs above now coalesce case-insensitively, so the admin page would show the
-- configured templates while assignment creation quietly used different ones.
--
-- An earlier draft of this branch repointed mixed-case classes onto the configured spelling as part
-- of a duplicate collapse, which would have masked this; that collapse was removed for being
-- riskier than the state it addressed, so the runtime join has to carry it. The unique index on
-- lower(org_name) keeps this matching at most one row.
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
    LEFT JOIN public.github_orgs go ON lower(go.org_name) = lower(c.github_org)
    WHERE c.id = p_class_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.resolve_class_template_repos(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_class_template_repos(bigint) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.admin_get_github_orgs() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_upsert_github_org(text, text, text, text[], boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.admin_get_github_orgs() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_upsert_github_org(text, text, text, text[], boolean) TO authenticated, service_role;
