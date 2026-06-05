-- ============================================================================
-- PR submission mode (Phase 2: webhook-direct ingestion)
-- ============================================================================
-- Phase 1 added the schema (submission_mode, upstream config, the PR columns on
-- `submissions`, and the `submission_pr_links` table). This phase adds the
-- server-side ingestion logic the GitHub webhook calls when a pull request is
-- opened / pushed to / closed against a pr-mode assignment's upstream repo.
--
-- "Webhook-direct" means: for pr-mode assignments there is no autograder
-- workflow run in the loop. The webhook resolves the PR -> (assignment,
-- student/group), then calls `ingest_pr_submission` which creates the
-- submission row directly. The existing `submissions_after_insert_hook` trigger
-- then provisions the grading review, so the submission is immediately
-- rubric-gradable. Each push to the PR head becomes a new submission version.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Step 1: allow 'pr' as a submitted_via value
-- ----------------------------------------------------------------------------
-- The existing check (added in 20260530120200) permits only git/upload/manual.
-- PR submissions are produced directly from a pull request, not a graded push.

alter table public.submissions drop constraint if exists submissions_submitted_via_valid;
alter table public.submissions
  add constraint submissions_submitted_via_valid check (
    submitted_via is null or submitted_via in ('git', 'upload', 'manual', 'pr')
  );

-- ----------------------------------------------------------------------------
-- Step 2: keep at most one confirmed PR link per (assignment, submitter)
-- ----------------------------------------------------------------------------
-- A submitter may have several candidate PRs (several links), but only one can
-- be "the" submission PR at a time. Whenever a link is confirmed -- by the
-- webhook's auto-confirm or by a student picking one -- unconfirm the siblings.
-- Enforcing this in a trigger keeps the invariant no matter who flips the flag.

create or replace function public.submission_pr_links_single_confirmed()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if NEW.confirmed then
    update public.submission_pr_links sib
       set confirmed = false
     where sib.assignment_id = NEW.assignment_id
       and sib.id <> NEW.id
       and sib.confirmed = true
       and sib.profile_id is not distinct from NEW.profile_id
       and sib.assignment_group_id is not distinct from NEW.assignment_group_id;
  end if;
  return NEW;
end;
$$;

drop trigger if exists submission_pr_links_single_confirmed_trg on public.submission_pr_links;
create trigger submission_pr_links_single_confirmed_trg
  after insert or update of confirmed on public.submission_pr_links
  for each row
  when (NEW.confirmed)
  execute function public.submission_pr_links_single_confirmed();

-- ----------------------------------------------------------------------------
-- Step 3: ingest_pr_submission -- the core ingestion entry point
-- ----------------------------------------------------------------------------
-- Called (as service_role) by the github-repo-webhook edge function for each
-- relevant pull_request event. Idempotent and concurrency-safe.
--
-- Behavior:
--   * Records the (submitter, PR) candidate as a submission_pr_link row.
--   * Decides which PR is "the" submission:
--       - p_auto_confirm = true  (base_branch / branch_convention identification):
--         auto-confirm when this is the submitter's only candidate link.
--       - p_auto_confirm = false (manual identification): never auto-confirm;
--         a human links the PR explicitly.
--     If there are several candidates and none is confirmed, no submission is
--     produced yet -- the student confirms one in the UI.
--   * For the confirmed PR, creates a new submission *version* per distinct
--     head sha (idempotent on re-delivery), snapshotting base/head shas so the
--     graded diff is stable. The new version becomes the active submission.
--
-- Returns the submission id that now reflects this PR head, or null when the
-- link is not (yet) confirmed.
-- Parameter order keeps the non-defaulted params first (Postgres requires every
-- parameter after a defaulted one to also have a default). All callers invoke
-- this by name, so the ordering is irrelevant at the call site.
create or replace function public.ingest_pr_submission(
  p_assignment_id bigint,
  p_pr_repo text,
  p_pr_number integer,
  p_base_sha text default null,
  p_head_sha text default null,
  p_pr_state text default null,
  p_profile_id uuid default null,
  p_assignment_group_id bigint default null,
  p_auto_confirm boolean default true
) returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_class_id bigint;
  v_link_id bigint;
  v_link_confirmed boolean;
  v_total int;
  v_confirmed int;
  v_existing bigint;
  v_submission_id bigint;
  v_ordinal int;
begin
  if (p_profile_id is null) = (p_assignment_group_id is null) then
    raise exception 'Exactly one of p_profile_id or p_assignment_group_id must be provided';
  end if;
  if p_pr_repo is null or p_pr_number is null then
    raise exception 'p_pr_repo and p_pr_number are required';
  end if;

  select a.class_id into v_class_id from public.assignments a where a.id = p_assignment_id;
  if v_class_id is null then
    raise exception 'Assignment % not found', p_assignment_id;
  end if;

  -- Serialize concurrent ingests for this assignment + submitter so links and
  -- submission ordinals stay consistent under rapid pushes / webhook retries.
  perform pg_advisory_xact_lock(
    hashtextextended(
      format(
        'ingest_pr_submission:%s:%s:%s',
        p_assignment_id,
        coalesce(p_assignment_group_id::text, ''),
        coalesce(p_profile_id::text, '')
      ),
      0
    )
  );

  -- Record (or no-op) the candidate link for this PR.
  insert into public.submission_pr_links(
    class_id, assignment_id, profile_id, assignment_group_id, pr_repo, pr_number, confirmed
  ) values (
    v_class_id, p_assignment_id, p_profile_id, p_assignment_group_id, p_pr_repo, p_pr_number, false
  )
  on conflict (assignment_id, profile_id, assignment_group_id, pr_repo, pr_number) do nothing;

  select id, confirmed into v_link_id, v_link_confirmed
    from public.submission_pr_links
   where assignment_id = p_assignment_id
     and profile_id is not distinct from p_profile_id
     and assignment_group_id is not distinct from p_assignment_group_id
     and pr_repo = p_pr_repo
     and pr_number = p_pr_number;

  -- How many candidates does this submitter have, and is any confirmed?
  select count(*), count(*) filter (where confirmed)
    into v_total, v_confirmed
    from public.submission_pr_links
   where assignment_id = p_assignment_id
     and profile_id is not distinct from p_profile_id
     and assignment_group_id is not distinct from p_assignment_group_id;

  -- Auto-confirm the sole candidate when identification allows it.
  if p_auto_confirm and not v_link_confirmed and v_confirmed = 0 and v_total = 1 then
    update public.submission_pr_links set confirmed = true where id = v_link_id;
    v_link_confirmed := true;
  end if;

  -- Nothing to ingest until this specific PR is the confirmed one.
  if not v_link_confirmed then
    return null;
  end if;

  -- Idempotent on webhook re-delivery: a version for this head already exists.
  select id into v_existing
    from public.submissions
   where assignment_id = p_assignment_id
     and pr_number = p_pr_number
     and head_sha = p_head_sha
     and (
       (p_assignment_group_id is not null and assignment_group_id = p_assignment_group_id)
       or (p_assignment_group_id is null and profile_id = p_profile_id and assignment_group_id is null)
     )
   limit 1;
  if v_existing is not null then
    update public.submissions
       set pr_state = coalesce(p_pr_state, pr_state),
           base_sha = coalesce(p_base_sha, base_sha)
     where id = v_existing;
    return v_existing;
  end if;

  -- New version: deactivate the submitter's current active submission, including
  -- any active row in the *other* scope (per-profile vs per-group) so a student
  -- never ends up with two active submissions on one assignment.
  if p_assignment_group_id is not null then
    update public.submissions s
       set is_active = false
     where s.assignment_id = p_assignment_id
       and s.is_active = true
       and (
         s.assignment_group_id = p_assignment_group_id
         or (
           s.assignment_group_id is null
           and s.profile_id in (
             select agm.profile_id from public.assignment_groups_members agm
              where agm.assignment_group_id = p_assignment_group_id
           )
         )
       );
  else
    update public.submissions s
       set is_active = false
     where s.assignment_id = p_assignment_id
       and s.is_active = true
       and (
         (s.profile_id = p_profile_id and s.assignment_group_id is null)
         or s.assignment_group_id in (
           select agm.assignment_group_id from public.assignment_groups_members agm
            where agm.profile_id = p_profile_id
         )
       );
  end if;

  select coalesce(max(ordinal), 0) + 1 into v_ordinal
    from public.submissions
   where assignment_id = p_assignment_id
     and (
       (p_assignment_group_id is not null and assignment_group_id = p_assignment_group_id)
       or (p_assignment_group_id is null and profile_id = p_profile_id and assignment_group_id is null)
     );

  insert into public.submissions(
    assignment_id, class_id, profile_id, assignment_group_id,
    repository, sha, head_sha, base_sha, pr_number, pr_state,
    run_attempt, run_number, ordinal, is_active, submitted_via
  ) values (
    p_assignment_id, v_class_id, p_profile_id, p_assignment_group_id,
    p_pr_repo, p_head_sha, p_head_sha, p_base_sha, p_pr_number, p_pr_state,
    v_ordinal, p_pr_number, v_ordinal, true, 'pr'
  )
  returning id into v_submission_id;

  return v_submission_id;
end;
$$;

-- The webhook runs as service_role; nobody else should call this directly.
revoke all on function public.ingest_pr_submission(bigint, text, integer, text, text, text, uuid, bigint, boolean) from public;
revoke all on function public.ingest_pr_submission(bigint, text, integer, text, text, text, uuid, bigint, boolean) from authenticated;
grant execute on function public.ingest_pr_submission(bigint, text, integer, text, text, text, uuid, bigint, boolean) to service_role;

-- ----------------------------------------------------------------------------
-- Step 4: set_pr_state -- reflect PR close/merge/reopen onto known versions
-- ----------------------------------------------------------------------------
-- For events that don't move the head (closed / reopened), update the latest
-- known GitHub PR state on every submission version of that PR and on the link.
create or replace function public.set_pr_state(
  p_assignment_id bigint,
  p_pr_repo text,
  p_pr_number integer,
  p_pr_state text
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.submissions
     set pr_state = p_pr_state
   where assignment_id = p_assignment_id
     and pr_number = p_pr_number
     and repository = p_pr_repo;
end;
$$;

revoke all on function public.set_pr_state(bigint, text, integer, text) from public;
revoke all on function public.set_pr_state(bigint, text, integer, text) from authenticated;
grant execute on function public.set_pr_state(bigint, text, integer, text) to service_role;
