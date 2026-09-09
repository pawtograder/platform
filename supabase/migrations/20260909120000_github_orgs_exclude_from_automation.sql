-- Mark GitHub orgs that background automation must never act on.
--
-- Measured against production on 2026-09-09: of 1093 assignments, 133 were missing their solution
-- ("grader") repo, and every single one was in `pawtograder-playground` (125), `autograder-dev` (7),
-- or `pawtograder-instructor-demo` (1). None were in a real course org. A reconciler that creates
-- repos for anything it finds missing would therefore have spent all of its effort creating
-- repositories in test and demo orgs.
--
-- `classes.is_demo` already exists but is `false` on every one of those classes, so it cannot serve
-- as the filter. The GitHub org is what actually separates them, and it belongs in configuration
-- rather than in a hardcoded array in a reconciler — the same argument that moved the permission
-- sync exemptions out of GitHubWrapper.ts.
--
-- This is deliberately about AUTOMATION only. It does not archive the org, hide it, or affect any
-- instructor-initiated action; the create path still works normally in these orgs.

ALTER TABLE public.github_orgs
    ADD COLUMN IF NOT EXISTS excluded_from_automation boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.github_orgs.excluded_from_automation IS
    'When true, background jobs (e.g. github-repo-reconciler) must not create or modify GitHub '
    'resources for classes in this org. For test, dev, and demo orgs. Does not affect '
    'instructor-initiated actions.';

-- Seed the three orgs the production measurement identified. `github_orgs` rows may not exist yet
-- for them (the table is sparse — admin_get_github_orgs unions it with the distinct set of
-- classes.github_org), so insert or update as needed. Reversible from the admin per-org page.
INSERT INTO public.github_orgs (org_name, excluded_from_automation)
VALUES
    ('pawtograder-playground', true),
    ('autograder-dev', true),
    ('pawtograder-instructor-demo', true)
ON CONFLICT (org_name) DO UPDATE SET
    excluded_from_automation = true,
    updated_at = now();
