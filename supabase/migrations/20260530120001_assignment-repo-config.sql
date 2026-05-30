-- Unified per-assignment student repository configuration (#698, #699, #700).
--
-- Flattened from four sequential migrations (originally 20260530120000..120003)
-- into a single migration renumbered to 20260530120001 so it applies AFTER the
-- staging fix 20260530120000_finalize_submission_early_restore_advisory_lock.sql
-- (#794), which previously collided on version 20260530120000. The four sections
-- below are concatenated in their original apply order; later sections depend on
-- columns/functions created by earlier ones.

-- ============================================================================
-- section: 20260530120000_assignment-repo-config.sql
-- ============================================================================

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


-- ============================================================================
-- section: 20260530120001_assignment-repo-config-enqueue.sql
-- ============================================================================

-- Extend enqueue_github_create_repo + the entry-point bulk-create functions to
-- carry the new per-assignment repo config (creation_method, source_repo,
-- branch_protection, student_team_permission) into pgmq messages, so the
-- async worker creates repos via fork vs template-generate per the
-- assignment's repo_mode and applies the desired branch ruleset.
--
-- Trigger-driven enqueue points (assignment-group membership changes, user-role
-- inserts, etc.) that still pass the historical 12 positional args resolve to the
-- single 16-arg function below with the 4 new params defaulted — i.e. the worker
-- treats those messages as template-generate w/ block_force_push=true. The
-- trigger path is additionally made repo_mode-aware further below (section:
-- fork-aware trigger + publish path) so mode-2/3 group repos are forked.

-- 1) Replace the enqueuer with a single 16-arg version. Drop the OBSOLETE 8-arg
-- and 12-arg overloads first: leaving them in place alongside the new 16-arg
-- overload (whose 4 trailing params default) makes any 12-positional call with
-- untyped literals ambiguous — Postgres raises "function ... is not unique",
-- which broke publish_assignment_group_changes and the group-change triggers.
-- Dropping them leaves one function, so legacy 12-arg calls resolve cleanly.
drop function if exists public.enqueue_github_create_repo(
  bigint, text, text, text, text, text[], boolean, text
);
drop function if exists public.enqueue_github_create_repo(
  bigint, text, text, text, text, text[], boolean, text, bigint, uuid, bigint, text
);

create or replace function public.enqueue_github_create_repo(
  p_class_id bigint,
  p_org text,
  p_repo_name text,
  p_template_repo text,
  p_course_slug text,
  p_github_usernames text[],
  p_is_template_repo boolean default false,
  p_debug_id text default null,
  p_assignment_id bigint default null,
  p_profile_id uuid default null,
  p_assignment_group_id bigint default null,
  p_latest_template_sha text default null,
  p_creation_method text default 'template',           -- 'template' | 'fork'
  p_source_repo text default null,                     -- owner/repo to fork when method='fork'
  p_branch_protection jsonb default null,              -- {blockForcePush, requirePullRequest, requiredReviewers}
  p_student_team_permission text default null          -- 'pull' (mode 2 handout) | null
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  log_id bigint;
  message_id bigint;
  repo_id bigint;
  full_repo_name text;
  v_args jsonb;
begin
  full_repo_name := p_org || '/' || p_repo_name;

  insert into public.api_gateway_calls(method, status_code, class_id, debug_id)
  values ('create_repo', 0, p_class_id, p_debug_id)
  returning id into log_id;

  if p_assignment_id is not null then
    select id into repo_id
    from public.repositories
    where assignment_id = p_assignment_id
      and (
        (p_profile_id is not null and profile_id = p_profile_id) or
        (p_assignment_group_id is not null and assignment_group_id = p_assignment_group_id)
      );

    if repo_id is null then
      insert into public.repositories(
        profile_id,
        assignment_group_id,
        assignment_id,
        repository,
        class_id,
        synced_handout_sha,
        is_github_ready
      )
      values (
        p_profile_id,
        p_assignment_group_id,
        p_assignment_id,
        full_repo_name,
        p_class_id,
        p_latest_template_sha,
        false
      )
      returning id into repo_id;
    end if;
  end if;

  v_args := jsonb_build_object(
    'org', p_org,
    'repoName', p_repo_name,
    'templateRepo', p_template_repo,
    'isTemplateRepo', p_is_template_repo,
    'courseSlug', p_course_slug,
    'githubUsernames', p_github_usernames
  );
  if p_creation_method is not null and p_creation_method <> 'template' then
    v_args := v_args || jsonb_build_object('creationMethod', p_creation_method);
  end if;
  if p_source_repo is not null then
    v_args := v_args || jsonb_build_object('sourceRepo', p_source_repo);
  end if;
  if p_branch_protection is not null then
    v_args := v_args || jsonb_build_object('branchProtection', p_branch_protection);
  end if;
  if p_student_team_permission is not null then
    v_args := v_args || jsonb_build_object('studentTeamPermission', p_student_team_permission);
  end if;

  select pgmq_public.send(
    'async_calls',
    jsonb_build_object(
      'method', 'create_repo',
      'class_id', p_class_id,
      'debug_id', p_debug_id,
      'log_id', log_id,
      'repo_id', repo_id,
      'args', v_args
    )
  ) into message_id;

  return message_id;
end;
$$;

grant execute on function public.enqueue_github_create_repo(
  bigint, text, text, text, text, text[], boolean, text, bigint, uuid, bigint, text,
  text, text, jsonb, text
) to service_role;

-- 2) Rewrite create_all_repos_for_assignment to compute the strategy and pass
--    it through. For repo_mode='none' we early-return. For
--    fork_from_prior_assignment we resolve each student/group's source repo
--    against the source assignment's repositories.
create or replace function public.create_all_repos_for_assignment(
  course_id bigint, assignment_id bigint, p_force boolean default false
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_course_id bigint := course_id;
  v_assignment_id bigint := assignment_id;
  v_slug text;
  v_org text;
  v_template_repo text;
  v_assignment_slug text;
  v_latest_template_sha text;
  v_repo_mode public.assignment_repo_mode;
  v_source_assignment_id bigint;
  v_branch_protection jsonb;
  v_creation_method text;
  v_default_source text;
  r_user_id uuid;
  r_username text;
  r_profile_id uuid;
  r_group_id bigint;
  r_group_name text;
  r_members text[];
  r_source_repo text;
begin
  if v_course_id is null or v_assignment_id is null then
    raise warning 'create_all_repos_for_assignment called with NULL parameters, skipping';
    return;
  end if;

  if auth.uid() is not null and not public.authorizeforclassinstructor(v_course_id::bigint) then
    raise exception 'Access denied: Only instructors can force-create repos for class %', v_course_id;
  end if;

  select c.slug, c.github_org, a.template_repo, a.slug, a.latest_template_sha,
         a.repo_mode, a.source_assignment_id,
         jsonb_build_object(
           'blockForcePush', coalesce(a.protect_block_force_push, true),
           'requirePullRequest', coalesce(a.protect_require_pull_request, false),
           'requiredReviewers', coalesce(a.protect_required_reviewers, 0)
         )
    into v_slug, v_org, v_template_repo, v_assignment_slug, v_latest_template_sha,
         v_repo_mode, v_source_assignment_id, v_branch_protection
    from public.assignments a
    join public.classes c on c.id = a.class_id
   where a.id = v_assignment_id and a.class_id = v_course_id;

  if v_slug is null or v_org is null then
    raise exception 'Invalid class/assignment (class_id %, assignment_id %)', course_id, assignment_id;
  end if;

  if v_repo_mode in ('none', 'no_submission') then
    raise notice 'Assignment % has repo_mode=%; nothing to enqueue', v_assignment_id, v_repo_mode;
    return;
  end if;

  if v_repo_mode in ('template_only_staff', 'template_with_student_forks')
     and (v_template_repo is null or v_template_repo = '')
  then
    raise exception 'Assignment % is missing template_repo for mode %', v_assignment_id, v_repo_mode;
  end if;

  -- The assignments_source_assignment_iff_fork check should already prevent
  -- this, but fail explicitly here so a broken config can't silently no-op
  -- the per-student/group enqueue loops below.
  if v_repo_mode = 'fork_from_prior_assignment' and v_source_assignment_id is null then
    raise exception 'Assignment % has repo_mode=fork_from_prior_assignment but no source_assignment_id', v_assignment_id;
  end if;

  v_creation_method := case
    when v_repo_mode = 'template_only_staff' then 'template'
    else 'fork'
  end;
  v_default_source := v_template_repo;  -- mode 1 and mode 2 fork/generate from the handout

  -- Enqueue individual repos for students not in groups.
  for r_user_id, r_username, r_profile_id in
    select ur.user_id, u.github_username, ur.private_profile_id
    from public.user_roles ur
    join public.users u on u.user_id = ur.user_id
    where ur.class_id = v_course_id
      and ur.role = 'student'
      and ur.disabled = false
      and u.github_username is not null
      and not exists (
        select 1 from public.assignment_groups_members agm
        join public.assignment_groups ag on ag.id = agm.assignment_group_id
        where ag.assignment_id = v_assignment_id and agm.profile_id = ur.private_profile_id
      )
      and (
        p_force
        or not exists (
          select 1 from public.repositories r
          where r.repository = v_org || '/' || v_slug || '-' || v_assignment_slug || '-' || u.github_username
        )
      )
  loop
    if v_repo_mode = 'fork_from_prior_assignment' then
      select r.repository into r_source_repo
        from public.repositories r
       where r.assignment_id = v_source_assignment_id
         and r.profile_id = r_profile_id
       limit 1;
      if r_source_repo is null then
        raise warning 'No source repository for profile % on assignment %; skipping', r_profile_id, v_source_assignment_id;
        continue;
      end if;
    else
      r_source_repo := v_default_source;
    end if;

    perform public.enqueue_github_create_repo(
      v_course_id,
      v_org,
      v_slug || '-' || v_assignment_slug || '-' || r_username,
      coalesce(v_template_repo, r_source_repo),
      v_slug,
      array[r_username],
      false,
      null,
      v_assignment_id,
      r_profile_id,
      null,
      v_latest_template_sha,
      v_creation_method,
      r_source_repo,
      v_branch_protection,
      null
    );
  end loop;

  -- Enqueue group repos.
  for r_group_id, r_group_name, r_members in
    select distinct on (ag.id)
           ag.id as group_id,
           ag.name as group_name,
           array_remove(array_agg(u.github_username), null) as members
    from public.assignment_groups ag
    left join public.assignment_groups_members agm on agm.assignment_group_id = ag.id
    left join public.user_roles ur on ur.private_profile_id = agm.profile_id and ur.disabled = false
    left join public.users u on u.user_id = ur.user_id
    where ag.assignment_id = v_assignment_id
      and (
        p_force
        or not exists (
          select 1 from public.repositories r
          where r.repository = v_org || '/' || v_slug || '-' || v_assignment_slug || '-group-' || ag.name
        )
      )
    group by ag.id, ag.name
    having array_length(array_remove(array_agg(u.github_username), null), 1) > 0
  loop
    if v_repo_mode = 'fork_from_prior_assignment' then
      -- Match by group name on the source assignment.
      select r.repository into r_source_repo
        from public.repositories r
        join public.assignment_groups ag on ag.id = r.assignment_group_id
       where r.assignment_id = v_source_assignment_id
         and ag.name = r_group_name
       limit 1;
      if r_source_repo is null then
        raise warning 'No source repository for group % on assignment %; skipping', r_group_name, v_source_assignment_id;
        continue;
      end if;
    else
      r_source_repo := v_default_source;
    end if;

    perform public.enqueue_github_create_repo(
      v_course_id,
      v_org,
      v_slug || '-' || v_assignment_slug || '-group-' || r_group_name,
      coalesce(v_template_repo, r_source_repo),
      v_slug,
      r_members,
      false,
      null,
      v_assignment_id,
      null,
      r_group_id,
      v_latest_template_sha,
      v_creation_method,
      r_source_repo,
      v_branch_protection,
      null
    );
  end loop;
end;
$$;

-- 3) Rewrite create_repos_for_student similarly. This is the lazy on-login path
--    used by autograder-create-repos-for-student.
create or replace function public.create_repos_for_student(
  user_id uuid, class_id integer default null, p_force boolean default false
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_username text;
  v_user_id uuid := user_id;
  v_class_id integer := class_id;
  r_assignment_id bigint;
  r_assignment_slug text;
  r_template_repo text;
  r_course_id bigint;
  r_course_slug text;
  r_github_org text;
  r_latest_template_sha text;
  r_profile_id uuid;
  r_repo_mode public.assignment_repo_mode;
  r_source_assignment_id bigint;
  r_branch_protection jsonb;
  r_creation_method text;
  r_source_repo text;
begin
  if user_id is null then
    raise warning 'create_repos_for_student called with NULL user_id, skipping';
    return;
  end if;

  select u.github_username into v_username from public.users u where u.user_id = v_user_id;
  if v_username is null or v_username = '' then
    raise exception 'User % has no GitHub username linked', user_id;
  end if;

  if p_force then
    if auth.uid() is not null then
      if class_id is null then
        raise exception 'Force create for all classes requires service role';
      end if;
      if not public.authorizeforclassinstructor(class_id::bigint) then
        raise exception 'Access denied: Only instructors can force-create repos for class %', class_id;
      end if;
    end if;
  end if;

  for r_assignment_id, r_assignment_slug, r_template_repo, r_course_id, r_course_slug, r_github_org,
      r_latest_template_sha, r_profile_id, r_repo_mode, r_source_assignment_id, r_branch_protection in
    select a.id, a.slug, a.template_repo, c.id, c.slug, c.github_org, a.latest_template_sha,
           ur.private_profile_id, a.repo_mode, a.source_assignment_id,
           jsonb_build_object(
             'blockForcePush', coalesce(a.protect_block_force_push, true),
             'requirePullRequest', coalesce(a.protect_require_pull_request, false),
             'requiredReviewers', coalesce(a.protect_required_reviewers, 0)
           )
    from public.assignments a
    join public.classes c on c.id = a.class_id
    join public.user_roles ur on ur.class_id = c.id
    where ur.user_id = v_user_id
      and (v_class_id is null or c.id = v_class_id)
      and a.repo_mode not in ('none', 'no_submission')
      and a.group_config <> 'groups'
      and (
        a.repo_mode = 'fork_from_prior_assignment'
        or (a.template_repo is not null and a.template_repo <> '')
      )
      and (
        p_force
        or not exists (
          select 1 from public.repositories r
          where r.assignment_id = a.id and r.profile_id = ur.private_profile_id
        )
      )
  loop
    if r_repo_mode = 'fork_from_prior_assignment' then
      select r.repository into r_source_repo
        from public.repositories r
       where r.assignment_id = r_source_assignment_id
         and r.profile_id = r_profile_id
       limit 1;
      if r_source_repo is null then
        raise warning 'No source repository for profile % on assignment %; skipping', r_profile_id, r_source_assignment_id;
        continue;
      end if;
      r_creation_method := 'fork';
    elsif r_repo_mode = 'template_with_student_forks' then
      r_source_repo := r_template_repo;
      r_creation_method := 'fork';
    else
      r_source_repo := r_template_repo;
      r_creation_method := 'template';
    end if;

    perform public.enqueue_github_create_repo(
      r_course_id,
      r_github_org,
      r_course_slug || '-' || r_assignment_slug || '-' || v_username,
      coalesce(r_template_repo, r_source_repo),
      r_course_slug,
      array[v_username],
      false,
      null,
      r_assignment_id,
      r_profile_id,
      null,
      r_latest_template_sha,
      r_creation_method,
      r_source_repo,
      r_branch_protection,
      null
    );
  end loop;
end;
$$;


-- ============================================================================
-- section: 20260530120002_assignment-no-repo-submission.sql
-- ============================================================================

-- RPCs that produce submission rows for the two no-repo modes:
--
--   * create_no_repo_submission — repo_mode='none'. The student calls this
--     themselves after uploading files to the submission-files storage bucket.
--   * create_manual_submission  — repo_mode='no_submission'. An instructor
--     calls this to create a stub submission (no files, no repo) so the
--     grading flow has a row to attach reviews to (e.g. presentations).
--
-- For create_no_repo_submission, files are expected to have already been
-- uploaded to the submission-files storage bucket at
-- `classes/{class_id}/profiles/{profile_or_group_id}/submissions/{submission_id}/files/{name}`
-- by the browser before this RPC is called.

create or replace function public.create_no_repo_submission(
  p_assignment_id bigint,
  p_files jsonb  -- array of { name, storage_key, file_size, mime_type }
) returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_class_id bigint;
  v_repo_mode public.assignment_repo_mode;
  v_release timestamptz;
  v_profile_id uuid;
  v_assignment_group_id bigint;
  v_submission_id bigint;
  v_run_number int;
  v_ordinal int;
  v_file jsonb;
  v_expected_prefix text;
  v_storage_key text;
begin
  if v_user_id is null then
    raise exception 'Must be authenticated' using errcode = '42501';
  end if;

  select a.class_id, a.repo_mode, a.release_date
    into v_class_id, v_repo_mode, v_release
    from public.assignments a
   where a.id = p_assignment_id;

  if v_class_id is null then
    raise exception 'Assignment % not found', p_assignment_id;
  end if;
  if v_repo_mode <> 'none' then
    -- 'no_submission' deliberately falls through to this branch: students
    -- cannot upload anything for that mode, instructors call
    -- create_manual_submission instead.
    raise exception 'Assignment % does not accept student uploads (repo_mode=%)', p_assignment_id, v_repo_mode;
  end if;

  -- Must be an active student in this class.
  if not exists (
    select 1 from public.user_roles ur
    where ur.user_id = v_user_id
      and ur.class_id = v_class_id
      and ur.role = 'student'
      and ur.disabled = false
  ) then
    raise exception 'User is not an active student in class %', v_class_id;
  end if;

  if v_release is null or v_release > now() then
    raise exception 'Assignment % is not yet released', p_assignment_id;
  end if;

  -- Resolve profile / group. Mode-4 doesn't have any group-config restrictions:
  -- if the student is in a group for this assignment we use it, otherwise we
  -- attach the submission to their private profile.
  select ur.private_profile_id into v_profile_id
    from public.user_roles ur
   where ur.user_id = v_user_id and ur.class_id = v_class_id and ur.role = 'student' and ur.disabled = false
   limit 1;

  select agm.assignment_group_id into v_assignment_group_id
    from public.assignment_groups_members agm
    join public.assignment_groups ag on ag.id = agm.assignment_group_id
   where ag.assignment_id = p_assignment_id and agm.profile_id = v_profile_id
   limit 1;

  -- Serialize concurrent creates for this assignment + submitter scope so we
  -- can't produce duplicate ordinals or end up with multiple active rows.
  perform pg_advisory_xact_lock(
    hashtextextended(
      format(
        'create_no_repo_submission:%s:%s:%s',
        p_assignment_id,
        coalesce(v_assignment_group_id::text, ''),
        coalesce(v_profile_id::text, '')
      ),
      0
    )
  );

  -- Deactivate any prior active submission for this profile/group on this assignment.
  update public.submissions
     set is_active = false
   where assignment_id = p_assignment_id
     and is_active = true
     and (
       (v_assignment_group_id is not null and assignment_group_id = v_assignment_group_id)
       or (v_assignment_group_id is null and profile_id = v_profile_id)
     );

  -- Next ordinal / run_number for this profile/group on this assignment.
  select coalesce(max(ordinal), 0) + 1 into v_ordinal
    from public.submissions
   where assignment_id = p_assignment_id
     and (
       (v_assignment_group_id is not null and assignment_group_id = v_assignment_group_id)
       or (v_assignment_group_id is null and profile_id = v_profile_id)
     );
  v_run_number := v_ordinal;  -- uploads have no GitHub workflow run, so reuse ordinal.

  insert into public.submissions(
    assignment_id, class_id, profile_id, assignment_group_id,
    repository, sha, run_attempt, run_number, ordinal, is_active, submitted_via
  ) values (
    p_assignment_id, v_class_id, v_profile_id, v_assignment_group_id,
    null, null, 1, v_run_number, v_ordinal, true, 'upload'
  )
  returning id into v_submission_id;

  if p_files is not null and jsonb_array_length(p_files) > 0 then
    -- Defense-in-depth: a malicious client could pass a storage_key pointing at
    -- another class's / another student's submission tree. Storage RLS still
    -- gates the bytes at signed-URL time, but reject keys outside this caller's
    -- documented scope prefix so we never persist a cross-scope reference.
    -- Convention (see header): classes/{class_id}/profiles/{profile_or_group_id}/...
    v_expected_prefix := format(
      'classes/%s/profiles/%s/',
      v_class_id,
      coalesce(v_assignment_group_id::text, v_profile_id::text)
    );
    for v_file in select * from jsonb_array_elements(p_files) loop
      v_storage_key := v_file->>'storage_key';
      if v_storage_key is null
         or left(v_storage_key, length(v_expected_prefix)) <> v_expected_prefix then
        raise exception 'storage_key % is outside this submission''s scope (expected prefix %)',
          coalesce(v_storage_key, '(null)'), v_expected_prefix
          using errcode = '42501';
      end if;
      insert into public.submission_files(
        class_id, submission_id, profile_id, assignment_group_id,
        name, contents, is_binary, file_size, mime_type, storage_key
      ) values (
        v_class_id,
        v_submission_id,
        v_profile_id,
        v_assignment_group_id,
        v_file->>'name',
        null,
        true,
        coalesce((v_file->>'file_size')::bigint, 0),
        v_file->>'mime_type',
        v_storage_key
      );
    end loop;
  end if;

  return v_submission_id;
end;
$$;

grant execute on function public.create_no_repo_submission(bigint, jsonb) to authenticated;

-- Instructor-only RPC for repo_mode='no_submission'. Creates a stub submission
-- row (no files, no repo, no sha) for the target profile or group so the
-- grading flow has a row to attach reviews to. Idempotent in the sense that
-- it returns the existing active submission id if one already exists.
create or replace function public.create_manual_submission(
  p_assignment_id bigint,
  p_profile_id uuid default null,
  p_assignment_group_id bigint default null
) returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_class_id bigint;
  v_repo_mode public.assignment_repo_mode;
  v_existing bigint;
  v_submission_id bigint;
  v_ordinal int;
  v_group_assignment_id bigint;
begin
  if v_user_id is null then
    raise exception 'Must be authenticated' using errcode = '42501';
  end if;

  if (p_profile_id is null) = (p_assignment_group_id is null) then
    raise exception 'Exactly one of p_profile_id or p_assignment_group_id must be provided';
  end if;

  select a.class_id, a.repo_mode
    into v_class_id, v_repo_mode
    from public.assignments a
   where a.id = p_assignment_id;

  if v_class_id is null then
    raise exception 'Assignment % not found', p_assignment_id;
  end if;
  if v_repo_mode <> 'no_submission' then
    raise exception 'Assignment % is not in no_submission mode (repo_mode=%)', p_assignment_id, v_repo_mode;
  end if;

  if not public.authorizeforclassinstructor(v_class_id::bigint) then
    raise exception 'Access denied: only instructors can create manual submissions for class %', v_class_id
      using errcode = '42501';
  end if;

  -- If a group id was passed, verify it belongs to this assignment.
  if p_assignment_group_id is not null then
    select ag.assignment_id into v_group_assignment_id
      from public.assignment_groups ag
     where ag.id = p_assignment_group_id;
    if v_group_assignment_id is null then
      raise exception 'Assignment group % not found', p_assignment_group_id;
    end if;
    if v_group_assignment_id <> p_assignment_id then
      raise exception 'Assignment group % belongs to assignment %, not %',
        p_assignment_group_id, v_group_assignment_id, p_assignment_id;
    end if;
  end if;

  -- Serialize concurrent creates for this assignment + submitter scope so we
  -- can't produce duplicate ordinals or end up with multiple active rows.
  perform pg_advisory_xact_lock(
    hashtextextended(
      format(
        'create_manual_submission:%s:%s:%s',
        p_assignment_id,
        coalesce(p_assignment_group_id::text, ''),
        coalesce(p_profile_id::text, '')
      ),
      0
    )
  );

  -- Reuse the existing active submission if one is already in place — keeps
  -- the call idempotent so instructors can re-trigger setup without making
  -- duplicate rows.
  select id into v_existing
    from public.submissions
   where assignment_id = p_assignment_id
     and is_active = true
     and (
       (p_assignment_group_id is not null and assignment_group_id = p_assignment_group_id)
       or (p_assignment_group_id is null and profile_id = p_profile_id and assignment_group_id is null)
     )
   limit 1;
  if v_existing is not null then
    return v_existing;
  end if;

  -- Deactivate any conflicting active submission in the *other* scope for the
  -- same target, so a student can't end up with both a per-profile and a
  -- per-group active manual submission on this assignment. (Group entry already
  -- deactivates individual submissions, but enforce it here too since manual
  -- submissions can be created independently of group membership changes.)
  if p_assignment_group_id is not null then
    update public.submissions s
       set is_active = false
     where s.assignment_id = p_assignment_id
       and s.is_active = true
       and s.assignment_group_id is null
       and s.profile_id in (
         select agm.profile_id
           from public.assignment_groups_members agm
          where agm.assignment_group_id = p_assignment_group_id
       );
  else
    update public.submissions s
       set is_active = false
     where s.assignment_id = p_assignment_id
       and s.is_active = true
       and s.assignment_group_id in (
         select agm.assignment_group_id
           from public.assignment_groups_members agm
          where agm.profile_id = p_profile_id
       );
  end if;

  -- Otherwise create one as the new active submission for the target.
  select coalesce(max(ordinal), 0) + 1 into v_ordinal
    from public.submissions
   where assignment_id = p_assignment_id
     and (
       (p_assignment_group_id is not null and assignment_group_id = p_assignment_group_id)
       or (p_assignment_group_id is null and profile_id = p_profile_id and assignment_group_id is null)
     );

  insert into public.submissions(
    assignment_id, class_id, profile_id, assignment_group_id,
    repository, sha, run_attempt, run_number, ordinal, is_active, submitted_via
  ) values (
    p_assignment_id, v_class_id, p_profile_id, p_assignment_group_id,
    null, null, 1, v_ordinal, v_ordinal, true, 'manual'
  )
  returning id into v_submission_id;

  return v_submission_id;
end;
$$;

grant execute on function public.create_manual_submission(bigint, uuid, bigint) to authenticated;


-- ============================================================================
-- section: 20260530120003_queue-repo-sync-fork-aware.sql
-- ============================================================================

-- Make queue_repository_syncs aware of the new repo_mode column so it can
-- route fork-mode repos through GitHub's native fork-sync endpoint instead of
-- the template_pr flow.
--
--   * template_only_staff           -> sync_strategy = 'template_pr'    (no change in behavior)
--   * template_with_student_forks   -> sync_strategy = 'fork_merge_upstream',
--                                      upstream = a.template_repo
--   * fork_from_prior_assignment    -> sync_strategy = 'fork_merge_upstream',
--                                      upstream = the student's own prior-assignment repo
--   * none / no_submission          -> skipped (already excluded — no template_repo)

create or replace function public.queue_repository_syncs(
    p_repository_ids bigint[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_class_id bigint;
    v_repo_record record;
    v_queued_count integer := 0;
    v_skipped_count integer := 0;
    v_error_count integer := 0;
    v_errors jsonb[] := '{}';
    v_sync_strategy text;
    v_upstream_repo_full_name text;
begin
    if auth.uid() is null then
        raise exception 'Not authenticated';
    end if;

    select r.class_id into v_class_id
    from public.repositories r
    where r.id = any(p_repository_ids)
    limit 1;

    if v_class_id is null then
        raise exception 'No repositories found with provided IDs';
    end if;

    if (select count(distinct r.class_id)
        from public.repositories r
        where r.id = any(p_repository_ids)) > 1 then
        raise exception 'All repositories must belong to the same class';
    end if;

    if not public.authorizeforclassinstructor(v_class_id) then
        raise exception 'Only instructors can queue repository syncs';
    end if;

    for v_repo_record in
        select
            r.id,
            r.repository,
            r.profile_id,
            r.assignment_group_id,
            r.synced_handout_sha,
            r.desired_handout_sha,
            r.class_id,
            a.id as assignment_id,
            a.template_repo,
            a.latest_template_sha,
            a.title as assignment_title,
            a.repo_mode,
            a.source_assignment_id
        from public.repositories r
        join public.assignments a on r.assignment_id = a.id
        where r.id = any(p_repository_ids)
          and a.template_repo is not null
          and a.template_repo <> ''
          and a.latest_template_sha is not null
          and r.is_github_ready = true
    loop
        begin
            -- Resolve sync strategy + upstream from repo_mode.
            v_upstream_repo_full_name := null;
            if v_repo_record.repo_mode = 'template_with_student_forks' then
                v_sync_strategy := 'fork_merge_upstream';
                v_upstream_repo_full_name := v_repo_record.template_repo;
            elsif v_repo_record.repo_mode = 'fork_from_prior_assignment' then
                v_sync_strategy := 'fork_merge_upstream';
                -- Match the student's or group's prior-assignment repo. Group repos
                -- are matched via assignment_group_id directly (group rows live on
                -- both assignments under different group ids but with the same name —
                -- we resolve by name here to mirror the create-time mapping).
                if v_repo_record.assignment_group_id is not null then
                    select prior_r.repository into v_upstream_repo_full_name
                    from public.repositories prior_r
                    join public.assignment_groups prior_ag on prior_ag.id = prior_r.assignment_group_id
                    join public.assignment_groups this_ag on this_ag.id = v_repo_record.assignment_group_id
                    where prior_r.assignment_id = v_repo_record.source_assignment_id
                      and prior_ag.name = this_ag.name
                    limit 1;
                else
                    select prior_r.repository into v_upstream_repo_full_name
                    from public.repositories prior_r
                    where prior_r.assignment_id = v_repo_record.source_assignment_id
                      and prior_r.profile_id = v_repo_record.profile_id
                    limit 1;
                end if;
            else
                -- template_only_staff (or any future repo-bearing mode without a
                -- direct fork relationship) — keep the existing template_pr flow.
                v_sync_strategy := 'template_pr';
            end if;

            if v_repo_record.desired_handout_sha is null or
               v_repo_record.desired_handout_sha <> v_repo_record.latest_template_sha then

                update public.repositories
                set desired_handout_sha = v_repo_record.latest_template_sha
                where id = v_repo_record.id;

                perform pgmq_public.send(
                    'async_calls',
                    jsonb_build_object(
                        'method', 'sync_repo_to_handout',
                        'args', jsonb_build_object(
                            'repository_id', v_repo_record.id,
                            'repository_full_name', v_repo_record.repository,
                            'template_repo', v_repo_record.template_repo,
                            'from_sha', v_repo_record.synced_handout_sha,
                            'to_sha', v_repo_record.latest_template_sha,
                            'assignment_title', v_repo_record.assignment_title,
                            'sync_strategy', v_sync_strategy,
                            'upstream_repo_full_name', v_upstream_repo_full_name
                        ),
                        'class_id', v_repo_record.class_id,
                        'repo_id', v_repo_record.id
                    )
                );

                v_queued_count := v_queued_count + 1;
            else
                v_skipped_count := v_skipped_count + 1;
            end if;
        exception when others then
            v_error_count := v_error_count + 1;
            v_errors := array_append(v_errors, jsonb_build_object(
                'repository_id', v_repo_record.id,
                'repository', v_repo_record.repository,
                'error', sqlerrm
            ));
        end;
    end loop;

    return jsonb_build_object(
        'success', true,
        'queued_count', v_queued_count,
        'skipped_count', v_skipped_count,
        'error_count', v_error_count,
        'errors', v_errors
    );
end;
$$;

grant execute on function public.queue_repository_syncs(bigint[]) to authenticated;




-- ============================================================================
-- fork-aware trigger + publish path (review fix S1)
-- ============================================================================
-- The public create_all_repos_for_assignment was rewritten above to be
-- repo_mode-aware, but the trigger entry point
-- create_all_repos_for_assignment_internal (called by
-- sync_repos_after_assignment_group_change on group / membership changes) and
-- publish_assignment_group_changes still created template-generated repos with
-- default branch protection. For template_with_student_forks (mode 2) and
-- fork_from_prior_assignment (mode 3) that produced repos with the wrong
-- provenance/upstream when a group was created or edited after release.
--
-- Unify the logic: create_all_repos_for_assignment_internal now carries the
-- full repo_mode strategy (no auth guard, for triggers/trusted callers) and the
-- public RPC simply enforces instructor auth then delegates to it. The batch
-- publish RPC's group-create enqueue is likewise made repo_mode-aware.

create or replace function public.create_all_repos_for_assignment_internal(
  course_id bigint, assignment_id bigint, p_force boolean default false
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_course_id bigint := course_id;
  v_assignment_id bigint := assignment_id;
  v_slug text;
  v_org text;
  v_template_repo text;
  v_assignment_slug text;
  v_latest_template_sha text;
  v_repo_mode public.assignment_repo_mode;
  v_source_assignment_id bigint;
  v_branch_protection jsonb;
  v_creation_method text;
  v_default_source text;
  r_user_id uuid;
  r_username text;
  r_profile_id uuid;
  r_group_id bigint;
  r_group_name text;
  r_members text[];
  r_source_repo text;
begin
  if v_course_id is null or v_assignment_id is null then
    raise warning 'create_all_repos_for_assignment_internal called with NULL parameters, skipping';
    return;
  end if;

  select c.slug, c.github_org, a.template_repo, a.slug, a.latest_template_sha,
         a.repo_mode, a.source_assignment_id,
         jsonb_build_object(
           'blockForcePush', coalesce(a.protect_block_force_push, true),
           'requirePullRequest', coalesce(a.protect_require_pull_request, false),
           'requiredReviewers', coalesce(a.protect_required_reviewers, 0)
         )
    into v_slug, v_org, v_template_repo, v_assignment_slug, v_latest_template_sha,
         v_repo_mode, v_source_assignment_id, v_branch_protection
    from public.assignments a
    join public.classes c on c.id = a.class_id
   where a.id = v_assignment_id and a.class_id = v_course_id;

  if v_slug is null or v_org is null then
    raise exception 'Invalid class/assignment (class_id %, assignment_id %)', course_id, assignment_id;
  end if;

  if v_repo_mode in ('none', 'no_submission') then
    raise notice 'Assignment % has repo_mode=%; nothing to enqueue', v_assignment_id, v_repo_mode;
    return;
  end if;

  if v_repo_mode in ('template_only_staff', 'template_with_student_forks')
     and (v_template_repo is null or v_template_repo = '')
  then
    raise exception 'Assignment % is missing template_repo for mode %', v_assignment_id, v_repo_mode;
  end if;

  if v_repo_mode = 'fork_from_prior_assignment' and v_source_assignment_id is null then
    raise exception 'Assignment % has repo_mode=fork_from_prior_assignment but no source_assignment_id', v_assignment_id;
  end if;

  v_creation_method := case
    when v_repo_mode = 'template_only_staff' then 'template'
    else 'fork'
  end;
  v_default_source := v_template_repo;

  -- Enqueue individual repos for students not in groups.
  for r_user_id, r_username, r_profile_id in
    select ur.user_id, u.github_username, ur.private_profile_id
    from public.user_roles ur
    join public.users u on u.user_id = ur.user_id
    where ur.class_id = v_course_id
      and ur.role = 'student'
      and ur.disabled = false
      and u.github_username is not null
      and not exists (
        select 1 from public.assignment_groups_members agm
        join public.assignment_groups ag on ag.id = agm.assignment_group_id
        where ag.assignment_id = v_assignment_id and agm.profile_id = ur.private_profile_id
      )
      and (
        p_force
        or not exists (
          select 1 from public.repositories r
          where r.repository = v_org || '/' || v_slug || '-' || v_assignment_slug || '-' || u.github_username
        )
      )
  loop
    if v_repo_mode = 'fork_from_prior_assignment' then
      select r.repository into r_source_repo
        from public.repositories r
       where r.assignment_id = v_source_assignment_id
         and r.profile_id = r_profile_id
       limit 1;
      if r_source_repo is null then
        raise warning 'No source repository for profile % on assignment %; skipping', r_profile_id, v_source_assignment_id;
        continue;
      end if;
    else
      r_source_repo := v_default_source;
    end if;

    perform public.enqueue_github_create_repo(
      v_course_id,
      v_org,
      v_slug || '-' || v_assignment_slug || '-' || r_username,
      coalesce(v_template_repo, r_source_repo),
      v_slug,
      array[r_username],
      false,
      null,
      v_assignment_id,
      r_profile_id,
      null,
      v_latest_template_sha,
      v_creation_method,
      r_source_repo,
      v_branch_protection,
      null
    );
  end loop;

  -- Enqueue group repos.
  for r_group_id, r_group_name, r_members in
    select distinct on (ag.id)
           ag.id as group_id,
           ag.name as group_name,
           array_remove(array_agg(u.github_username), null) as members
    from public.assignment_groups ag
    left join public.assignment_groups_members agm on agm.assignment_group_id = ag.id
    left join public.user_roles ur on ur.private_profile_id = agm.profile_id and ur.disabled = false
    left join public.users u on u.user_id = ur.user_id
    where ag.assignment_id = v_assignment_id
      and (
        p_force
        or not exists (
          select 1 from public.repositories r
          where r.repository = v_org || '/' || v_slug || '-' || v_assignment_slug || '-group-' || ag.name
        )
      )
    group by ag.id, ag.name
    having array_length(array_remove(array_agg(u.github_username), null), 1) > 0
  loop
    if v_repo_mode = 'fork_from_prior_assignment' then
      select r.repository into r_source_repo
        from public.repositories r
        join public.assignment_groups ag on ag.id = r.assignment_group_id
       where r.assignment_id = v_source_assignment_id
         and ag.name = r_group_name
       limit 1;
      if r_source_repo is null then
        raise warning 'No source repository for group % on assignment %; skipping', r_group_name, v_source_assignment_id;
        continue;
      end if;
    else
      r_source_repo := v_default_source;
    end if;

    perform public.enqueue_github_create_repo(
      v_course_id,
      v_org,
      v_slug || '-' || v_assignment_slug || '-group-' || r_group_name,
      coalesce(v_template_repo, r_source_repo),
      v_slug,
      r_members,
      false,
      null,
      v_assignment_id,
      null,
      r_group_id,
      v_latest_template_sha,
      v_creation_method,
      r_source_repo,
      v_branch_protection,
      null
    );
  end loop;
end;
$$;

revoke all on function public.create_all_repos_for_assignment_internal(bigint, bigint, boolean) from public;
grant execute on function public.create_all_repos_for_assignment_internal(bigint, bigint, boolean) to postgres;

comment on function public.create_all_repos_for_assignment_internal(bigint, bigint, boolean) is
  'Enqueue repo creation for an assignment per its repo_mode (template/fork/none) without auth.uid()/instructor checks; for triggers and other trusted callers. Single source of truth; the public create_all_repos_for_assignment wraps this with an instructor auth guard.';

-- Public RPC: enforce instructor auth, then delegate to the unified internal fn.
create or replace function public.create_all_repos_for_assignment(
  course_id bigint, assignment_id bigint, p_force boolean default false
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if course_id is null or assignment_id is null then
    raise warning 'create_all_repos_for_assignment called with NULL parameters, skipping';
    return;
  end if;

  if auth.uid() is not null and not public.authorizeforclassinstructor(course_id::bigint) then
    raise exception 'Access denied: Only instructors can force-create repos for class %', course_id;
  end if;

  perform public.create_all_repos_for_assignment_internal(course_id, assignment_id, p_force);
end;
$$;

-- Make publish_assignment_group_changes' group-create enqueue repo_mode-aware so
-- groups published on a mode-2/3 assignment fork (with the right source + branch
-- protection) instead of template-generating. Body is otherwise unchanged from
-- 20260311100000_batch_publish_group_changes_rpc.sql.
create or replace function public.publish_assignment_group_changes(
    p_class_id       bigint,
    p_assignment_id  bigint,
    p_groups_to_create jsonb default '[]'::jsonb,
    p_moves_to_fulfill jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_caller_profile_id uuid;
    v_course_slug       text;
    v_github_org        text;
    v_template_repo     text;
    v_latest_sha        text;
    v_assignment_slug   text;

    v_repo_mode            public.assignment_repo_mode;
    v_source_assignment_id bigint;
    v_branch_protection    jsonb;
    v_creation_method      text;
    v_group_source_repo    text;

    v_group             jsonb;
    v_move              jsonb;
    v_group_name        text;
    v_new_group_id      bigint;
    v_member_id         uuid;
    v_member_ids        jsonb;

    v_old_gid           bigint;
    v_new_gid           bigint;
    v_profile_id        uuid;
    v_empty_gid         bigint;

    v_membership_id     bigint;
    v_repo_record       record;

    v_affected_groups   bigint[] := '{}';
    v_deleted_groups    bigint[] := '{}';

    v_groups_created    integer := 0;
    v_members_added     integer := 0;
    v_members_moved     integer := 0;
    v_groups_dissolved  integer := 0;
    v_syncs_enqueued    integer := 0;
    v_errors            jsonb[] := '{}';
begin
    -- auth
    if auth.uid() is null then
        raise exception 'Not authenticated';
    end if;
    if not public.authorizeforclassinstructor(p_class_id) then
        raise exception 'Only instructors can publish group changes';
    end if;

    select private_profile_id into v_caller_profile_id
    from public.user_roles
    where user_id = auth.uid()
      and class_id = p_class_id
      and role = 'instructor'
    limit 1;

    -- class + assignment metadata (one query), incl. repo_mode config
    select c.slug, c.github_org, a.slug, a.template_repo, a.latest_template_sha,
           a.repo_mode, a.source_assignment_id,
           jsonb_build_object(
             'blockForcePush', coalesce(a.protect_block_force_push, true),
             'requirePullRequest', coalesce(a.protect_require_pull_request, false),
             'requiredReviewers', coalesce(a.protect_required_reviewers, 0)
           )
    into   v_course_slug, v_github_org, v_assignment_slug, v_template_repo, v_latest_sha,
           v_repo_mode, v_source_assignment_id, v_branch_protection
    from   public.assignments a
    join   public.classes c on c.id = a.class_id
    where  a.id = p_assignment_id and a.class_id = p_class_id;

    if v_course_slug is null then
        raise exception 'Assignment % not found in class %', p_assignment_id, p_class_id;
    end if;

    -- Phase 1: process moves on existing groups
    for v_move in select * from jsonb_array_elements(p_moves_to_fulfill)
    loop
        v_profile_id := (v_move->>'profile_id')::uuid;
        v_old_gid    := (v_move->>'old_group_id')::bigint;
        v_new_gid    := (v_move->>'new_group_id')::bigint;

        begin
            if v_old_gid is not null and not exists (
                select 1 from public.assignment_groups
                where id = v_old_gid
                  and assignment_id = p_assignment_id
                  and class_id = p_class_id
            ) then
                v_errors := array_append(v_errors, jsonb_build_object(
                    'profile_id', v_profile_id,
                    'error', format('Group %s does not belong to assignment %s', v_old_gid, p_assignment_id)
                ));
                continue;
            end if;
            if v_new_gid is not null and not exists (
                select 1 from public.assignment_groups
                where id = v_new_gid
                  and assignment_id = p_assignment_id
                  and class_id = p_class_id
            ) then
                v_errors := array_append(v_errors, jsonb_build_object(
                    'profile_id', v_profile_id,
                    'error', format('Group %s does not belong to assignment %s', v_new_gid, p_assignment_id)
                ));
                continue;
            end if;

            if v_old_gid is not null then
                select id into v_membership_id
                from public.assignment_groups_members
                where assignment_group_id = v_old_gid
                  and profile_id = v_profile_id
                  and class_id = p_class_id;

                if v_membership_id is null then
                    v_errors := array_append(v_errors, jsonb_build_object(
                        'profile_id', v_profile_id,
                        'error', format('Student not in group %s', v_old_gid)
                    ));
                    continue;
                end if;

                delete from public.assignment_groups_members where id = v_membership_id;
                v_affected_groups := array_append(v_affected_groups, v_old_gid);
            end if;

            if v_new_gid is not null then
                if v_old_gid is null then
                    update public.submissions
                    set is_active = false
                    where assignment_id = p_assignment_id
                      and profile_id = v_profile_id;
                end if;

                insert into public.assignment_groups_members
                    (assignment_group_id, profile_id, assignment_id, class_id, added_by)
                values
                    (v_new_gid, v_profile_id, p_assignment_id, p_class_id, v_caller_profile_id);

                v_affected_groups := array_append(v_affected_groups, v_new_gid);
            end if;

            v_members_moved := v_members_moved + 1;

        exception when others then
            v_errors := array_append(v_errors, jsonb_build_object(
                'profile_id', v_profile_id,
                'error', SQLERRM
            ));
        end;
    end loop;

    -- Phase 2: create new groups and add their initial members
    for v_group in select * from jsonb_array_elements(p_groups_to_create)
    loop
        v_group_name := trim(v_group->>'name');
        v_member_ids := v_group->'member_ids';

        begin
            if v_group_name = '' or v_group_name is null then
                raise exception 'Group name cannot be empty';
            end if;
            if length(v_group_name) > 36 then
                raise exception 'Group name too long (max 36 chars)';
            end if;
            if v_group_name !~ '^[a-zA-Z0-9_-]+$' then
                raise exception 'Group name must be alphanumeric, hyphens, or underscores';
            end if;

            if exists (
                select 1 from public.assignment_groups
                where assignment_id = p_assignment_id and lower(name) = lower(v_group_name)
            ) then
                raise exception 'Group "%" already exists', v_group_name;
            end if;

            -- Resolve the creation strategy from repo_mode BEFORE creating the
            -- group, so a fork-mode group with no source repo is reported as an
            -- error without leaving a half-created group behind.
            v_creation_method := null;
            v_group_source_repo := null;
            if v_repo_mode not in ('none', 'no_submission') then
                if v_repo_mode = 'fork_from_prior_assignment' then
                    select r.repository into v_group_source_repo
                      from public.repositories r
                      join public.assignment_groups ag on ag.id = r.assignment_group_id
                     where r.assignment_id = v_source_assignment_id
                       and ag.name = v_group_name
                     limit 1;
                    if v_group_source_repo is null then
                        raise exception 'No source repository for group "%" on source assignment %', v_group_name, v_source_assignment_id;
                    end if;
                    v_creation_method := 'fork';
                elsif v_repo_mode = 'template_with_student_forks' then
                    v_group_source_repo := v_template_repo;
                    v_creation_method := 'fork';
                else  -- template_only_staff
                    v_group_source_repo := v_template_repo;
                    v_creation_method := 'template';
                end if;
            end if;

            insert into public.assignment_groups (name, assignment_id, class_id)
            values (v_group_name, p_assignment_id, p_class_id)
            returning id into v_new_group_id;

            v_groups_created := v_groups_created + 1;

            -- enqueue repo creation per repo_mode (empty usernames; permission sync below)
            if v_creation_method is not null
               and v_github_org is not null
               and (v_repo_mode = 'fork_from_prior_assignment'
                    or (v_template_repo is not null and v_template_repo != '')) then
                perform public.enqueue_github_create_repo(
                    p_class_id,
                    v_github_org,
                    v_course_slug || '-' || v_assignment_slug || '-group-' || v_group_name,
                    coalesce(v_template_repo, v_group_source_repo),
                    v_course_slug,
                    '{}'::text[],
                    false,
                    'batch-group-create-' || v_new_group_id::text,
                    p_assignment_id,
                    null::uuid,
                    v_new_group_id,
                    v_latest_sha,
                    v_creation_method,
                    v_group_source_repo,
                    v_branch_protection,
                    null
                );
            end if;

            if v_member_ids is not null and jsonb_array_length(v_member_ids) > 0 then
                for v_member_id in
                    select (value#>>'{}')::uuid from jsonb_array_elements(v_member_ids) as value
                loop
                    update public.submissions
                    set is_active = false
                    where assignment_id = p_assignment_id
                      and profile_id = v_member_id;

                    insert into public.assignment_groups_members
                        (assignment_group_id, profile_id, assignment_id, class_id, added_by)
                    values
                        (v_new_group_id, v_member_id, p_assignment_id, p_class_id, v_caller_profile_id);

                    v_members_added := v_members_added + 1;
                end loop;
            end if;

            v_affected_groups := array_append(v_affected_groups, v_new_group_id);

        exception when others then
            v_errors := array_append(v_errors, jsonb_build_object(
                'group_name', v_group_name,
                'error', SQLERRM
            ));
        end;
    end loop;

    -- Phase 2b: dissolve empty groups (batch-final state after moves + creates)
    for v_empty_gid in
        select ag.id
        from public.assignment_groups ag
        where ag.assignment_id = p_assignment_id
          and ag.class_id = p_class_id
          and not exists (
              select 1 from public.assignment_groups_members agm
              where agm.assignment_group_id = ag.id
          )
    loop
        delete from public.assignment_group_invitations
        where assignment_group_id = v_empty_gid;
        delete from public.assignment_group_join_request
        where assignment_group_id = v_empty_gid;

        for v_repo_record in
            select r.id, r.repository
            from public.repositories r
            where r.assignment_group_id = v_empty_gid
              and r.repository is not null
              and position('/' in r.repository) > 0
        loop
            if v_github_org is not null then
                perform public.enqueue_github_archive_repo(
                    p_class_id,
                    v_github_org,
                    split_part(v_repo_record.repository, '/', 2),
                    'batch-dissolve-' || v_empty_gid::text
                );
            end if;
            delete from public.repository_check_runs where repository_id = v_repo_record.id;
            delete from public.repositories where id = v_repo_record.id;
        end loop;

        delete from public.assignment_groups where id = v_empty_gid;
        v_deleted_groups := array_append(v_deleted_groups, v_empty_gid);
        v_groups_dissolved := v_groups_dissolved + 1;
    end loop;

    -- Phase 3: enqueue ONE permission sync per affected repo
    for v_repo_record in
        select distinct r.id           as repo_id,
               r.repository,
               r.assignment_group_id,
               r.is_github_ready
        from   unnest(v_affected_groups) as gid(g)
        join   public.repositories r on r.assignment_group_id = gid.g
        where  not (gid.g = any(v_deleted_groups))
    loop
        begin
            if not v_repo_record.is_github_ready then
                continue;
            end if;

            declare
                v_usernames text[];
            begin
                select coalesce(array_remove(array_agg(u.github_username), null), '{}')
                into v_usernames
                from public.assignment_groups_members agm
                join public.user_roles ur on ur.private_profile_id = agm.profile_id
                join public.users u on u.user_id = ur.user_id
                where agm.assignment_group_id = v_repo_record.assignment_group_id
                  and ur.class_id = p_class_id
                  and ur.role = 'student'
                  and ur.github_org_confirmed = true
                  and u.github_username is not null
                  and u.github_username != '';

                if v_repo_record.repository is not null and position('/' in v_repo_record.repository) > 0 then
                    perform public.enqueue_github_sync_repo_permissions(
                        p_class_id,
                        v_github_org,
                        split_part(v_repo_record.repository, '/', 2),
                        v_course_slug,
                        coalesce(v_usernames, '{}'),
                        'batch-publish-' || p_assignment_id::text || '-g' || v_repo_record.assignment_group_id::text
                    );
                    v_syncs_enqueued := v_syncs_enqueued + 1;
                end if;
            end;
        exception when others then
            v_errors := array_append(v_errors, jsonb_build_object(
                'repository_id', v_repo_record.repo_id,
                'error', SQLERRM
            ));
        end;
    end loop;

    return jsonb_build_object(
        'groups_created',   v_groups_created,
        'members_added',    v_members_added,
        'members_moved',    v_members_moved,
        'groups_dissolved', v_groups_dissolved,
        'syncs_enqueued',   v_syncs_enqueued,
        'errors',           to_jsonb(v_errors)
    );
end;
$$;

revoke all on function public.publish_assignment_group_changes(bigint, bigint, jsonb, jsonb) from public;
grant execute on function public.publish_assignment_group_changes(bigint, bigint, jsonb, jsonb) to authenticated;
