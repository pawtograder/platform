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
    'When true, the assignment-level repo reconciliation in github-repo-reconciler must not create '
    'handout or solution repos for classes in this org. For test, dev, and demo orgs. Scoped '
    'deliberately: it does NOT gate instructor-initiated actions, and it does NOT gate '
    'reconcile_stuck_repo_creations, which re-enqueues STUDENT repo creation and is what the e2e '
    'suites in pawtograder-playground depend on. Widening it to that path would change student-repo '
    'behaviour in those orgs and belongs in its own change.';

-- Seed the three orgs the production measurement identified. `github_orgs` rows may not exist yet
-- for them (the table is sparse — admin_get_github_orgs unions it with the distinct set of
-- classes.github_org).
--
-- The template columns are seeded with the DEPLOYMENT's effective defaults, not left to the table
-- defaults. Creating a row suppresses the GUC tier in resolve_class_template_repos (which resolves
-- class override -> org default -> app.settings.default_* -> hardcoded), so inserting a row that
-- merely takes the hardcoded column defaults would silently change which templates new assignments
-- in these orgs are created from — on a deployment that had configured the GUC. This migration is
-- about automation only and must not move template resolution.
--
-- Reversible by any platform admin: the "Admins manage github_orgs" RLS policy grants full CRUD, so
-- this is settable over PostgREST today. It is not yet surfaced in the admin per-org UI; that
-- plumbing (admin_get_github_orgs / admin_upsert_github_org) is a follow-up.
-- Case-insensitively, because org_name is a case-sensitive text primary key while GitHub org
-- logins are not, and nothing normalizes what admin_create_class / admin_update_class store. A
-- straight lowercase insert against a deployment that already holds `Pawtograder-Playground` would
-- create a SECOND row: the admin page would then show both spellings, and unticking the flag on the
-- one the classes actually reference would leave the lowercase seed still excluding the org,
-- because the reconciler lowercases every excluded row when it compares.
--
-- So: flip the flag on any existing case-insensitive match, and insert only where none exists.
UPDATE public.github_orgs
SET excluded_from_automation = true,
    updated_at = now()
WHERE lower(org_name) IN ('pawtograder-playground', 'autograder-dev', 'pawtograder-instructor-demo');

-- New rows take the DEPLOYMENT's effective template defaults, not the table's hardcoded ones:
-- materializing a github_orgs row suppresses the GUC tier in resolve_class_template_repos, so an
-- insert that quietly took the column defaults would move template resolution for the org. This
-- migration is about automation only and must not do that. An existing row keeps its own values,
-- which is why the UPDATE above touches nothing but the flag.
--
-- Reversible by any platform admin from the per-org admin page (the "Admins manage github_orgs" RLS
-- policy grants full CRUD, and 20260909130000 surfaces the flag there).
INSERT INTO public.github_orgs (org_name, excluded_from_automation, default_handout_template_repo, default_solution_template_repo)
SELECT
    seed.org_name,
    true,
    public.resolve_effective_template_repo(
        NULL, NULL, 'app.settings.default_handout_template_repo', 'pawtograder/template-assignment-handout'),
    public.resolve_effective_template_repo(
        NULL, NULL, 'app.settings.default_solution_template_repo', 'pawtograder/template-assignment-grader')
FROM (VALUES ('pawtograder-playground'), ('autograder-dev'), ('pawtograder-instructor-demo')) AS seed(org_name)
WHERE NOT EXISTS (
    SELECT 1 FROM public.github_orgs g WHERE lower(g.org_name) = seed.org_name
);
