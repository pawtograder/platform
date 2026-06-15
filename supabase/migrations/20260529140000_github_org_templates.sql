-- GitHub org-level handout/solution template configuration, overridable per class.
--
-- Today the handout/solution template repos are hardcoded constants in the
-- assignment-create-*-repo edge functions:
--   pawtograder/template-assignment-handout
--   pawtograder/template-assignment-grader
-- Institutions that run their own GitHub org need their own templates. This migration
-- adds a github_orgs table (per-org defaults), per-class override columns, a resolution
-- RPC (override -> org default -> hardcoded constant), and admin RPCs for the admin
-- per-org dashboard.

-- The documented fallback defaults, kept in sync with the edge-function constants.
-- Used wherever neither a class override nor an org default is configured.

----------------------------------------------------------------------------------------
-- 1. github_orgs table
----------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.github_orgs (
    org_name text PRIMARY KEY,
    default_handout_template_repo text NOT NULL DEFAULT 'pawtograder/template-assignment-handout',
    default_solution_template_repo text NOT NULL DEFAULT 'pawtograder/template-assignment-grader',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
    updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL
);

COMMENT ON TABLE public.github_orgs IS
    'Per-GitHub-org default handout/solution template repos. Keyed by org name (matches classes.github_org).';

-- Keep updated_at fresh on direct updates (RPCs also set it explicitly).
DROP TRIGGER IF EXISTS set_updated_at_on_github_orgs ON public.github_orgs;
CREATE TRIGGER set_updated_at_on_github_orgs
    BEFORE INSERT OR UPDATE ON public.github_orgs
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.github_orgs ENABLE ROW LEVEL SECURITY;

-- Admins (global user_roles.role='admin') have full CRUD.
CREATE POLICY "Admins manage github_orgs" ON public.github_orgs
    FOR ALL
    USING (public.authorize_for_admin())
    WITH CHECK (public.authorize_for_admin());

-- Instructors of any class in the org may read its config.
CREATE POLICY "Instructors view their github_org" ON public.github_orgs
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1
            FROM public.user_roles ur
            JOIN public.classes c ON c.id = ur.class_id
            WHERE ur.user_id = auth.uid()
              AND ur.role = 'instructor'
              AND ur.disabled = false
              AND c.github_org = github_orgs.org_name
        )
    );

----------------------------------------------------------------------------------------
-- 2. Per-class override columns (NULL = inherit org default)
----------------------------------------------------------------------------------------

ALTER TABLE public.classes
    ADD COLUMN IF NOT EXISTS handout_template_repo text,
    ADD COLUMN IF NOT EXISTS solution_template_repo text;

COMMENT ON COLUMN public.classes.handout_template_repo IS
    'Per-class override for the handout template repo. NULL inherits the github_orgs default, then the hardcoded constant.';
COMMENT ON COLUMN public.classes.solution_template_repo IS
    'Per-class override for the solution (grader) template repo. NULL inherits the github_orgs default, then the hardcoded constant.';

----------------------------------------------------------------------------------------
-- 3. Resolution RPC: override -> org default -> hardcoded constant
----------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_class_template_repos(p_class_id bigint)
RETURNS TABLE (handout_template_repo text, solution_template_repo text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    -- Callable by class instructors/admins (UI) and by edge functions (service role).
    IF NOT (auth.role() = 'service_role' OR public.authorizeforclassinstructor(p_class_id)) THEN
        RAISE EXCEPTION 'Access denied: instructor role required for class %', p_class_id;
    END IF;

    RETURN QUERY
    SELECT
        COALESCE(c.handout_template_repo, go.default_handout_template_repo, 'pawtograder/template-assignment-handout'),
        COALESCE(c.solution_template_repo, go.default_solution_template_repo, 'pawtograder/template-assignment-grader')
    FROM public.classes c
    LEFT JOIN public.github_orgs go ON go.org_name = c.github_org
    WHERE c.id = p_class_id;
END;
$$;

-- Instructor-facing setter for the per-class overrides.
-- A SECURITY DEFINER RPC is required because the only instructor UPDATE policy on
-- public.classes is column-scoped (only_calendar_or_discord_ids_changed), so a direct
-- UPDATE of the template columns would be rejected by RLS. Guarded by
-- authorizeforclassinstructor (admins pass too). Pass NULL/empty to clear an override.
CREATE OR REPLACE FUNCTION public.set_class_template_overrides(
    p_class_id bigint,
    p_handout text DEFAULT NULL,
    p_solution text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NOT (auth.role() = 'service_role' OR public.authorizeforclassinstructor(p_class_id)) THEN
        RAISE EXCEPTION 'Access denied: instructor role required for class %', p_class_id;
    END IF;

    UPDATE public.classes
    SET handout_template_repo = NULLIF(trim(p_handout), ''),
        solution_template_repo = NULLIF(trim(p_solution), '')
    WHERE id = p_class_id;
END;
$$;

----------------------------------------------------------------------------------------
-- 4. Admin RPCs (global admin only)
----------------------------------------------------------------------------------------

-- One row per distinct org (union of github_orgs rows and orgs referenced by classes).
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
        COALESCE(go.default_handout_template_repo, 'pawtograder/template-assignment-handout'),
        COALESCE(go.default_solution_template_repo, 'pawtograder/template-assignment-grader'),
        (SELECT COUNT(*) FROM public.classes c WHERE c.github_org = o.org_name)::bigint,
        (go.org_name IS NOT NULL) AS is_configured,
        go.created_at,
        go.updated_at
    FROM orgs o
    LEFT JOIN public.github_orgs go ON go.org_name = o.org_name
    ORDER BY o.org_name;
END;
$$;

-- Create or update an org's default template repos.
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

    INSERT INTO public.github_orgs (
        org_name,
        default_handout_template_repo,
        default_solution_template_repo,
        created_by,
        updated_by
    ) VALUES (
        trim(p_org_name),
        COALESCE(NULLIF(trim(p_handout), ''), 'pawtograder/template-assignment-handout'),
        COALESCE(NULLIF(trim(p_solution), ''), 'pawtograder/template-assignment-grader'),
        auth.uid(),
        auth.uid()
    )
    ON CONFLICT (org_name) DO UPDATE SET
        default_handout_template_repo = COALESCE(NULLIF(trim(p_handout), ''), 'pawtograder/template-assignment-handout'),
        default_solution_template_repo = COALESCE(NULLIF(trim(p_solution), ''), 'pawtograder/template-assignment-grader'),
        updated_by = auth.uid(),
        updated_at = now();
END;
$$;

-- Courses in an org with their override columns and effective (resolved) templates.
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
        COALESCE(c.handout_template_repo, go.default_handout_template_repo, 'pawtograder/template-assignment-handout'),
        COALESCE(c.solution_template_repo, go.default_solution_template_repo, 'pawtograder/template-assignment-grader')
    FROM public.classes c
    LEFT JOIN public.github_orgs go ON go.org_name = c.github_org
    WHERE c.github_org = p_org_name
    ORDER BY c.name;
END;
$$;

----------------------------------------------------------------------------------------
-- 5. Admin "act as instructor": idempotently provision an instructor enrollment so an
--    admin can operate inside any course using the full instructor surface.
----------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_enter_course_as_instructor(p_class_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_name text;
    v_public_profile_id uuid;
    v_private_profile_id uuid;
BEGIN
    IF NOT public.authorize_for_admin() THEN
        RAISE EXCEPTION 'Access denied: Admin role required';
    END IF;

    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'No authenticated user';
    END IF;

    -- Idempotent: if the admin already has an active instructor role in this class, nothing
    -- to do. (A non-instructor active role is upgraded below rather than treated as a no-op.)
    IF EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = v_user_id AND ur.class_id = p_class_id
          AND ur.disabled = false AND ur.role = 'instructor'
    ) THEN
        RETURN;
    END IF;

    -- The user_roles INSERT/UPDATE below fires team-sync triggers (sync_staff_github_team)
    -- that reject when auth.uid() is a non-instructor of the class. Bulk/system enrollment
    -- avoids this by running as service role (auth.uid() null). We've already verified the
    -- caller is a global admin, so present a service-role auth context for these writes;
    -- this also matches how the team sync is enqueued for system-driven enrollment.
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

    -- If the admin already has an active non-instructor role (student/grader), promote it in
    -- place. The DB enforces at most one active (user_id, class_id) enrollment
    -- (idx_user_roles_one_active_per_class), so we must upgrade the existing row rather than
    -- insert a second active row. The role-change trigger re-syncs the GitHub teams.
    UPDATE public.user_roles
    SET role = 'instructor'
    WHERE user_id = v_user_id AND class_id = p_class_id AND disabled = false;
    IF FOUND THEN
        RETURN;
    END IF;

    SELECT u.name INTO v_name FROM public.users u WHERE u.user_id = v_user_id;

    -- No active enrollment: create profiles + a fresh instructor row.
    -- Public + private profiles, mirroring admin_create_class / enrollment helpers.
    INSERT INTO public.profiles (name, class_id, is_private_profile)
    VALUES (v_name, p_class_id, false)
    RETURNING id INTO v_public_profile_id;

    INSERT INTO public.profiles (name, class_id, is_private_profile)
    VALUES (v_name, p_class_id, true)
    RETURNING id INTO v_private_profile_id;

    INSERT INTO public.user_roles (user_id, class_id, role, public_profile_id, private_profile_id)
    VALUES (v_user_id, p_class_id, 'instructor', v_public_profile_id, v_private_profile_id);
END;
$$;

----------------------------------------------------------------------------------------
-- 6. Grants
----------------------------------------------------------------------------------------

-- Revoke the default PUBLIC execute grant first so these (SECURITY DEFINER) RPCs are not
-- accidentally exposed to anon/public roles, then grant explicitly.
REVOKE EXECUTE ON FUNCTION public.resolve_class_template_repos(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_class_template_overrides(bigint, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_get_github_orgs() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_upsert_github_org(text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_get_org_courses(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_enter_course_as_instructor(bigint) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.resolve_class_template_repos(bigint) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_class_template_overrides(bigint, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_github_orgs() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_upsert_github_org(text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_org_courses(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_enter_course_as_instructor(bigint) TO authenticated, service_role;
