-- Make `assignments.has_autograder` trustworthy as a signal.
--
-- Background: the column has defaulted to FALSE since
-- 20250403183613_group-assignments.sql, while in practice every assignment with a
-- repository has had a working autograder — the assignment form is the only path
-- that set the flag explicitly, so anything created another way (CLI, seeding,
-- direct inserts, test fixtures) ended up FALSE despite grading working fine.
--
-- That was harmless while nothing branched on the flag. Issue #895 makes it load
-- bearing: `has_autograder = false` now means "repo-only assignment", which makes
-- github-repo-webhook create a submission directly from every push instead of
-- dispatching grade.yml. With a FALSE default, assignments that were never meant
-- to be repo-only would silently take that path.
--
-- Two changes, so that FALSE means "the instructor turned the autograder off":
--   1. Backfill existing repo-bearing assignments to TRUE. They predate the
--      repo-only feature, so none of them can be an intentional opt-out.
--   2. Flip the default to TRUE, matching the assignment form's default.
--
-- Deliberately NOT touched:
--   - repo_mode in ('none','no_submission'): these have no repository, so an
--     autograder cannot run and FALSE is already correct.
--   - Assignments with template_repo IS NULL: a repo mode whose handout creation
--     has not completed (or failed). Leaving them FALSE is the conservative
--     choice — assignment-create-handout-repo reads the flag when deciding
--     whether to strip grade.yml, and we must not flip that decision for an
--     assignment mid-provisioning.
--   - Assignments whose autograder row has no grader_repo. Nothing can grade
--     them: autograder-create-submission needs the grader repo, so flipping them
--     to TRUE would route pushes down the Actions path only to fail there,
--     instead of treating them as hand-graded. FALSE is already the truthful
--     value for these, whether or not it was set deliberately.

update public.assignments a
set has_autograder = true
where a.has_autograder = false
  and a.template_repo is not null
  and a.repo_mode not in ('none', 'no_submission')
  and exists (
    select 1
    from public.autograder g
    where g.id = a.id
      and g.grader_repo is not null
  );

alter table public.assignments
  alter column has_autograder set default true;
