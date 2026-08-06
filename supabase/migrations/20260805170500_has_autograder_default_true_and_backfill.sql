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
--   1. Backfill to TRUE only where there is POSITIVE EVIDENCE the autograder was
--      actually in use. The autograder config page has always persisted a
--      deliberate "Disabled" as the same FALSE the old default produced, so
--      "repo-bearing" alone cannot distinguish the two — backfilling on that
--      basis would silently re-enable grading an instructor had turned off.
--      Evidence used (either is sufficient):
--        - autograder.workflow_sha is set: grade.yml was hashed from the handout,
--          which only happens while the autograder is wired up; or
--        - a submission exists from an Actions run, i.e. the workflow
--          demonstrably graded this assignment.
--      Anything without that evidence keeps FALSE, which is the safe direction:
--      a hand-graded assignment stays hand-graded.
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
--   - submission_mode = 'pr' assignments. PR submissions are ingested by the PR
--     webhook/RPC path, not by Actions, so they never produce grader_results —
--     FALSE is correct for them and the UI relies on it for the manual-grading
--     empty state. They still get an auto-created autograder row with a
--     grader_repo, so the grader_repo condition above does not exclude them.

update public.assignments a
set has_autograder = true
where a.has_autograder = false
  and a.template_repo is not null
  and a.repo_mode not in ('none', 'no_submission')
  and a.submission_mode <> 'pr'
  and exists (
    select 1
    from public.autograder g
    where g.id = a.id
      and g.grader_repo is not null
  )
  and (
    -- Evidence 1: the handout's grade.yml was hashed for this assignment, which
    -- only happens while the autograder is wired up.
    exists (
      select 1
      from public.autograder g
      where g.id = a.id
        and g.workflow_sha is not null
    )
    -- Evidence 2: an Actions-backed submission exists.
    --
    -- run_number > 0 alone is NOT enough. create_manual_submission_internal and
    -- create_no_repo_submission_internal both insert run_number = ordinal, so an
    -- instructor stub or a file upload carries run_number >= 1 despite no workflow
    -- ever running - and since 20260707120000 a manual stub can be created for ANY
    -- repo_mode, so one "grade anyway" placeholder on a deliberately hand-graded
    -- assignment would otherwise flip it back to autograded. Restrict the evidence
    -- to repo-pushed submissions (submitted_via null or 'git'); push-direct
    -- submissions inside that set are excluded by run_number = 0.
    or exists (
      select 1
      from public.submissions s
      where s.assignment_id = a.id
        and s.run_number > 0
        and (s.submitted_via is null or s.submitted_via = 'git')
    )
  );

alter table public.assignments
  alter column has_autograder set default true;
