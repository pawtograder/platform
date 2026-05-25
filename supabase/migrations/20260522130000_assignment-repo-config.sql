-- Issues #698, #699, #700: Unified per-assignment student-repository configuration.
--
--   * repo_mode picks one of five strategies for how student repos relate to a
--     handout (or whether there is a repo / submission at all).
--   * source_assignment_id is required only for the "fork from prior assignment"
--     mode (#700) — students get a fork of their own prior repo.
--   * protect_* columns map 1:1 to GitHub branch-protection ruleset rules
--     applied on the default branch of every repo for this assignment (#698).
--   * Existing rows are backfilled implicitly via the column defaults — they
--     keep the current behavior (template-only, staff-only, block force push,
--     block deletion).
--
-- The two no-repo modes:
--   * 'none' — no git repository, but students upload submission files
--     directly via storage (see create_no_repo_submission).
--   * 'no_submission' — no git repository AND no student-uploaded artifact
--     (e.g. presentations, oral exams). Submissions are created by
--     instructors via create_manual_submission so the grading flow still has
--     a row to attach reviews to.

create type public.assignment_repo_mode as enum (
  'none',
  'template_only_staff',
  'template_with_student_forks',
  'fork_from_prior_assignment',
  'no_submission'
);

alter table public.assignments
  add column repo_mode public.assignment_repo_mode not null default 'template_only_staff',
  add column source_assignment_id bigint references public.assignments(id) on delete restrict,
  add column protect_block_force_push     boolean not null default true,
  add column protect_require_pull_request boolean not null default false,
  add column protect_required_reviewers   smallint not null default 0,
  add constraint assignments_required_reviewers_range
    check (protect_required_reviewers between 0 and 5),
  add constraint assignments_source_assignment_iff_fork check (
    (repo_mode = 'fork_from_prior_assignment' and source_assignment_id is not null)
    or (repo_mode <> 'fork_from_prior_assignment' and source_assignment_id is null)
  ),
  add constraint assignments_no_protection_when_no_repo check (
    repo_mode not in ('none', 'no_submission') or (
      protect_block_force_push = false
      and protect_require_pull_request = false
      and protect_required_reviewers = 0
    )
  );

-- Source assignment must live in the same class (FK alone can't express this).
create or replace function public.assignments_check_source_assignment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source_class_id bigint;
begin
  if new.source_assignment_id is null then
    return new;
  end if;
  select class_id into v_source_class_id
    from public.assignments
    where id = new.source_assignment_id;
  if v_source_class_id is null then
    raise exception 'source_assignment_id % does not exist', new.source_assignment_id;
  end if;
  if v_source_class_id <> new.class_id then
    raise exception 'source_assignment_id % is in class % but this assignment is in class %',
      new.source_assignment_id, v_source_class_id, new.class_id;
  end if;
  if new.source_assignment_id = new.id then
    raise exception 'source_assignment_id cannot reference the assignment itself';
  end if;
  return new;
end;
$$;

create trigger assignments_source_assignment_same_class
  before insert or update of source_assignment_id, class_id on public.assignments
  for each row
  execute function public.assignments_check_source_assignment();

-- Allow no-repo submissions: when repo_mode = 'none', students upload files
-- directly via storage rather than pushing to a git repo, so we no longer
-- require a repository or sha on the submissions row. Existing rows keep their
-- non-null values; new no-repo submissions can omit both.
alter table public.submissions alter column repository drop not null;
alter table public.submissions alter column sha drop not null;

-- Enforce repository/sha as both-present or both-absent. The upload-based
-- (no-repo) flow inserts both as null; everything else must carry both.
alter table public.submissions
  add constraint submissions_repository_and_sha_match
  check ((repository is null) = (sha is null));

-- Submission origin marker. null/git for repo-pushed submissions (current
-- behaviour), "upload" for no-repo file uploads (create_no_repo_submission),
-- "manual" for instructor-created stubs on no_submission assignments
-- (create_manual_submission). Used by graders to route processing.
alter table public.submissions
  add column submitted_via text null,
  add constraint submissions_submitted_via_valid check (
    submitted_via is null or submitted_via in ('git', 'upload', 'manual')
  );

-- Comment on the new columns so the generated TS types carry intent.
comment on column public.assignments.repo_mode is
  'How student repositories relate to the handout: none (no repo, upload-based submission), template_only_staff, template_with_student_forks, fork_from_prior_assignment, or no_submission (no repo and no student-uploaded artifact; instructor creates submissions for manual grading).';
comment on column public.assignments.source_assignment_id is
  'When repo_mode = fork_from_prior_assignment, the assignment whose per-student/group repos are forked to create this assignment''s repos.';
comment on column public.assignments.protect_block_force_push is
  'GitHub ruleset: block non-fast-forward pushes (force-push) on the default branch of every repo for this assignment.';
comment on column public.assignments.protect_require_pull_request is
  'GitHub ruleset: require a pull request to update the default branch.';
comment on column public.assignments.protect_required_reviewers is
  'GitHub ruleset: minimum required approving reviews on the pull request (only enforced when protect_require_pull_request is true).';
comment on column public.submissions.submitted_via is
  'Submission origin marker: null/git for repo-pushed submissions, "upload" for no-repo file uploads, "manual" for instructor-created stubs on no_submission assignments. Used by graders to route processing.';
