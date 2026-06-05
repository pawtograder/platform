-- Feature: Re-grade late commits after a deadline extension
--
-- When an instructor extends an assignment deadline, students who pushed code
-- after the *original* deadline never got a graded submission (the autograder's
-- deadline check rejected the push and no `submissions` row was created). This
-- migration adds an instructor-driven workflow to surface those late commits,
-- grade them in a "staged" (non-active, non-counting) state so a before/after
-- score can be previewed, and then explicitly promote the chosen commit.
--
-- Design notes (decided with the requesting instructor):
--   * Candidates = anyone who pushed in the (old_effective, new_effective] window,
--     including students who already have an on-time submission.
--   * One candidate commit per student/group: the latest push inside the window.
--   * Promoting is always a manual, per-student instructor action. Lower scores
--     are allowed but the UI requires an explicit per-row confirmation.
--   * Only instructors (not graders) may enumerate/preview/apply, because this
--     mutates real grades and notifies students.

-- =====================================================================
-- 1. Staging columns
-- =====================================================================

-- A "staged" submission is fully graded (real grader_results) but is NOT active
-- and does NOT count toward the gradebook until an instructor promotes it.
alter table public.submissions
  add column if not exists is_staged boolean not null default false;
comment on column public.submissions.is_staged is
  'When true, this submission was created by the deadline-extension regrade flow. It is graded but never auto-activated; an instructor must explicitly promote it (which clears this flag and sets is_active).';

-- Carried on the manually-triggered check run so autograder-create-submission
-- knows to mark the resulting submission as staged (graded but not active).
alter table public.repository_check_runs
  add column if not exists stage_only boolean not null default false;
comment on column public.repository_check_runs.stage_only is
  'When true, a submission created from this check run is marked is_staged=true (deadline-extension regrade preview), instead of becoming the active submission.';

-- Note: the existing partial unique indexes on submissions filter on
-- `WHERE is_active = true`, and staged submissions are is_active=false, so no
-- index changes are required - staged rows are naturally excluded.

-- =====================================================================
-- 2. Redefine the submissions insert hook to skip activation for staged rows
--    (verbatim copy of the current body from
--    20260424200000_prevent_dual_active_submissions.sql, with the two
--    activation gates extended to also exclude is_staged submissions).
-- =====================================================================
CREATE OR REPLACE FUNCTION public.submissions_insert_hook_optimized()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  assigned_ordinal integer;
  v_in_group boolean;
  r RECORD;
BEGIN
  CASE TG_OP
  WHEN 'INSERT' THEN
    IF NEW.assignment_group_id IS NOT NULL THEN
      INSERT INTO public.submission_ordinal_counters
        (assignment_id, assignment_group_id, profile_id, next_ordinal, updated_at)
      VALUES
        (NEW.assignment_id::bigint,
         NEW.assignment_group_id::bigint,
         '00000000-0000-0000-0000-000000000000'::uuid,
         2,
         now())
      ON CONFLICT (assignment_id, assignment_group_id, profile_id) DO UPDATE SET
        next_ordinal = public.submission_ordinal_counters.next_ordinal + 1,
        updated_at = now()
      RETURNING (public.submission_ordinal_counters.next_ordinal - 1) INTO assigned_ordinal;

      NEW.ordinal = assigned_ordinal;

      -- Staged submissions are graded but never auto-activated; leave is_active
      -- at its default (false) so the instructor controls promotion.
      IF NEW.is_staged THEN
        NEW.is_active = false;
      ELSIF NOT NEW.is_not_graded THEN
        NEW.is_active = true;
        UPDATE public.submissions
        SET is_active = false
        WHERE assignment_id = NEW.assignment_id
          AND assignment_group_id = NEW.assignment_group_id;

        FOR r IN (
          WITH demoted AS (
            UPDATE public.submissions s
            SET is_active = false
            FROM public.assignment_groups_members agm
            WHERE agm.assignment_id = NEW.assignment_id
              AND agm.assignment_group_id = NEW.assignment_group_id
              AND s.assignment_id = NEW.assignment_id
              AND s.profile_id = agm.profile_id
              AND s.assignment_group_id IS NULL
              AND s.is_active = true
            RETURNING s.profile_id
          )
          SELECT DISTINCT gcs.class_id, gcs.gradebook_id, gcs.student_id, gcs.is_private
          FROM demoted d
          JOIN public.gradebook_column_students gcs ON gcs.student_id = d.profile_id
          JOIN public.gradebook_columns gc
            ON gc.id = gcs.gradebook_column_id
           AND gc.dependencies->'assignments' @> to_jsonb(ARRAY[NEW.assignment_id]::bigint[])
        ) LOOP
          PERFORM public.enqueue_gradebook_row_recalculation(
            r.class_id, r.gradebook_id, r.student_id, r.is_private, 'group_submission_demote_individual', NULL
          );
        END LOOP;
      END IF;
    ELSE
      IF NEW.profile_id IS NOT NULL THEN
        SELECT EXISTS (
          SELECT 1
          FROM public.assignment_groups_members
          WHERE assignment_id = NEW.assignment_id
            AND profile_id = NEW.profile_id
        ) INTO v_in_group;
        IF v_in_group THEN
          RAISE EXCEPTION
            'Cannot create individual submission for profile % on assignment %: student is in an assignment group; submissions must go through the group repository.',
            NEW.profile_id, NEW.assignment_id
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;

      INSERT INTO public.submission_ordinal_counters
        (assignment_id, assignment_group_id, profile_id, next_ordinal, updated_at)
      VALUES
        (NEW.assignment_id::bigint, 0::bigint, NEW.profile_id::uuid, 2, now())
      ON CONFLICT (assignment_id, assignment_group_id, profile_id) DO UPDATE SET
        next_ordinal = public.submission_ordinal_counters.next_ordinal + 1,
        updated_at = now()
      RETURNING (public.submission_ordinal_counters.next_ordinal - 1) INTO assigned_ordinal;

      NEW.ordinal = assigned_ordinal;

      IF NEW.is_staged THEN
        NEW.is_active = false;
      ELSIF NOT NEW.is_not_graded THEN
        NEW.is_active = true;
        UPDATE public.submissions
        SET is_active = false
        WHERE assignment_id = NEW.assignment_id
          AND profile_id = NEW.profile_id;
      END IF;
    END IF;

    RETURN NEW;
  ELSE
    RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
  END CASE;
END;
$$;

COMMENT ON FUNCTION public.submissions_insert_hook_optimized() IS
  'Assigns ordinals, manages is_active, rejects individual INSERT when the student is in a group, demotes straggler individual rows on new group submission and enqueues gradebook row recalc for demoted students. Staged submissions (is_staged=true) are graded but never auto-activated.';

-- =====================================================================
-- 3. Batch + candidate tables
-- =====================================================================

-- One row per "instructor extended a deadline -> review these late commits" session.
create table if not exists public.deadline_regrade_batches (
  id bigint generated by default as identity primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  class_id bigint not null references public.classes(id) on delete cascade,
  assignment_id bigint not null references public.assignments(id) on delete cascade,
  created_by uuid references public.profiles(id),
  old_due_date timestamptz not null,
  new_due_date timestamptz not null,
  -- open: awaiting instructor review; applied: at least one promotion done and closed;
  -- dismissed: instructor closed without (further) action; superseded: replaced by a newer batch.
  status text not null default 'open' check (status in ('open', 'applied', 'dismissed', 'superseded'))
);
create index if not exists deadline_regrade_batches_assignment_idx
  on public.deadline_regrade_batches (assignment_id, status);
create index if not exists deadline_regrade_batches_class_idx
  on public.deadline_regrade_batches (class_id);

-- One row per student/group candidate commit within a batch.
create table if not exists public.deadline_regrade_candidates (
  id bigint generated by default as identity primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  batch_id bigint not null references public.deadline_regrade_batches(id) on delete cascade,
  class_id bigint not null references public.classes(id) on delete cascade,
  assignment_id bigint not null references public.assignments(id) on delete cascade,
  profile_id uuid references public.profiles(id),
  assignment_group_id bigint references public.assignment_groups(id),
  repository_id bigint not null references public.repositories(id) on delete cascade,
  repository text not null,
  sha text not null,
  commit_message text,
  commit_date timestamptz,
  -- Snapshot of the currently-active submission at enumeration time (for display).
  current_submission_id bigint references public.submissions(id) on delete set null,
  current_score numeric,
  -- The staged (preview) submission created for this candidate, once graded.
  staged_submission_id bigint references public.submissions(id) on delete set null,
  staged_score numeric,
  staged_status text not null default 'none' check (staged_status in ('none', 'grading', 'graded', 'error')),
  staged_triggered_at timestamptz,
  decision text not null default 'pending' check (decision in ('pending', 'applied', 'skipped'))
);
create index if not exists deadline_regrade_candidates_batch_idx
  on public.deadline_regrade_candidates (batch_id);
create unique index if not exists deadline_regrade_candidates_unique_target
  on public.deadline_regrade_candidates (batch_id, repository_id);

-- RLS: instructors read; all writes go through SECURITY DEFINER RPCs below.
alter table public.deadline_regrade_batches enable row level security;
alter table public.deadline_regrade_candidates enable row level security;

drop policy if exists deadline_regrade_batches_instructor_select on public.deadline_regrade_batches;
create policy deadline_regrade_batches_instructor_select
  on public.deadline_regrade_batches for select
  using (public.authorizeforclassinstructor(class_id));

drop policy if exists deadline_regrade_candidates_instructor_select on public.deadline_regrade_candidates;
create policy deadline_regrade_candidates_instructor_select
  on public.deadline_regrade_candidates for select
  using (public.authorizeforclassinstructor(class_id));

-- =====================================================================
-- 4. Enumerate candidates (creates a batch + candidate rows)
-- =====================================================================
create or replace function public.enumerate_deadline_regrade_candidates(
  p_assignment_id bigint,
  p_old_due_date timestamptz
) returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_class_id bigint;
  v_new_due_date timestamptz;
  v_creator uuid;
  v_batch_id bigint;
begin
  select class_id, due_date into v_class_id, v_new_due_date
  from public.assignments where id = p_assignment_id;
  if v_class_id is null then
    raise exception 'Assignment % not found', p_assignment_id;
  end if;

  if not public.authorizeforclassinstructor(v_class_id) then
    raise exception 'Only instructors can enumerate deadline regrade candidates'
      using errcode = 'insufficient_privilege';
  end if;

  if p_old_due_date is null or v_new_due_date is null or v_new_due_date <= p_old_due_date then
    raise exception 'The assignment due date must be later than the supplied old due date to enumerate late commits';
  end if;

  select private_profile_id into v_creator
  from public.user_roles
  where user_id = auth.uid() and class_id = v_class_id
  limit 1;

  -- Supersede any prior open batch for this assignment so the dashboard only
  -- surfaces the most recent review session.
  update public.deadline_regrade_batches
  set status = 'superseded', updated_at = now()
  where assignment_id = p_assignment_id and status = 'open';

  insert into public.deadline_regrade_batches
    (class_id, assignment_id, created_by, old_due_date, new_due_date, status)
  values (v_class_id, p_assignment_id, v_creator, p_old_due_date, v_new_due_date, 'open')
  returning id into v_batch_id;

  -- For each repository (one per student or group) compute the per-student
  -- effective window and select the latest commit pushed inside it.
  insert into public.deadline_regrade_candidates
    (batch_id, class_id, assignment_id, profile_id, assignment_group_id,
     repository_id, repository, sha, commit_message, commit_date,
     current_submission_id, current_score, staged_status, decision)
  select
    v_batch_id, v_class_id, p_assignment_id, r.profile_id, r.assignment_group_id,
    r.id, r.repository, cand.sha, cand.commit_message, cand.commit_date,
    act.id, act.score, 'none', 'pending'
  from public.repositories r
  cross join lateral (
    select public.calculate_final_due_date(p_assignment_id, r.profile_id, r.assignment_group_id) as new_eff
  ) eff
  cross join lateral (
    -- old_effective = new_effective - (new_due - old_due). Assumes per-student
    -- extensions and lab-meeting selection are unchanged by the due-date move,
    -- which holds for the common (non-lab / within-window) case.
    select eff.new_eff as new_eff,
           eff.new_eff - (v_new_due_date - p_old_due_date) as old_eff
  ) win
  left join lateral (
    select cr.sha, cr.commit_message,
           coalesce((cr.status->>'commit_date')::timestamptz, cr.created_at) as commit_date
    from public.repository_check_runs cr
    where cr.repository_id = r.id
      and coalesce((cr.status->>'commit_date')::timestamptz, cr.created_at) > win.old_eff
      and coalesce((cr.status->>'commit_date')::timestamptz, cr.created_at) <= win.new_eff
    order by coalesce((cr.status->>'commit_date')::timestamptz, cr.created_at) desc, cr.id desc
    limit 1
  ) cand on true
  left join lateral (
    select s.id, gr.score
    from public.submissions s
    left join public.grader_results gr
      on gr.submission_id = s.id and gr.rerun_for_submission_id is null
    where s.assignment_id = p_assignment_id
      and s.is_active = true
      and (
        (r.assignment_group_id is not null and s.assignment_group_id = r.assignment_group_id)
        or (r.assignment_group_id is null and s.profile_id = r.profile_id and s.assignment_group_id is null)
      )
    order by gr.id desc
    limit 1
  ) act on true
  where r.assignment_id = p_assignment_id
    and cand.sha is not null
    -- skip when the candidate commit is already the active submission's commit
    and (act.id is null or not exists (
          select 1 from public.submissions s2 where s2.id = act.id and s2.sha = cand.sha
        ));

  return v_batch_id;
end;
$$;

-- =====================================================================
-- 5. Mark a candidate as grading (called right after the workflow is triggered)
-- =====================================================================
create or replace function public.regrade_set_candidate_grading(
  p_candidate_id bigint
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_class_id bigint;
begin
  select class_id into v_class_id
  from public.deadline_regrade_candidates where id = p_candidate_id;
  if v_class_id is null then
    raise exception 'Regrade candidate % not found', p_candidate_id;
  end if;
  if not public.authorizeforclassinstructor(v_class_id) then
    raise exception 'Only instructors can stage regrades' using errcode = 'insufficient_privilege';
  end if;

  update public.deadline_regrade_candidates
  set staged_status = 'grading',
      staged_triggered_at = now(),
      updated_at = now()
  where id = p_candidate_id and decision = 'pending';
end;
$$;

-- =====================================================================
-- 6. Backfill staged result when grading completes
-- =====================================================================
create or replace function public.regrade_backfill_staged_result()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub record;
begin
  -- Only care about primary (non-what-if) results attached to a submission.
  if NEW.submission_id is null or NEW.rerun_for_submission_id is not null then
    return NEW;
  end if;

  select id, assignment_id, sha, profile_id, assignment_group_id, is_staged
  into v_sub
  from public.submissions where id = NEW.submission_id;
  if not found or not v_sub.is_staged then
    return NEW;
  end if;

  update public.deadline_regrade_candidates c
  set staged_submission_id = v_sub.id,
      staged_score = NEW.score,
      staged_status = 'graded',
      updated_at = now()
  from public.deadline_regrade_batches b
  where c.batch_id = b.id
    and b.status = 'open'
    and c.assignment_id = v_sub.assignment_id
    and c.sha = v_sub.sha
    and c.decision = 'pending'
    and (c.staged_submission_id is null or c.staged_submission_id = v_sub.id)
    and (
      (v_sub.assignment_group_id is not null and c.assignment_group_id = v_sub.assignment_group_id)
      or (v_sub.assignment_group_id is null and c.profile_id = v_sub.profile_id)
    );

  return NEW;
end;
$$;

drop trigger if exists trg_regrade_backfill_staged_result on public.grader_results;
create trigger trg_regrade_backfill_staged_result
  after insert on public.grader_results
  for each row execute function public.regrade_backfill_staged_result();

-- =====================================================================
-- 7. Apply (promote) a candidate's staged submission
-- =====================================================================
create or replace function public.apply_deadline_regrade(
  p_candidate_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cand record;
  v_staged_id bigint;
  v_old_sub_id bigint;
  v_old_score numeric;
  v_creator uuid;
  v_creator_name text;
  r RECORD;
begin
  select * into v_cand from public.deadline_regrade_candidates where id = p_candidate_id;
  if v_cand.id is null then
    raise exception 'Regrade candidate % not found', p_candidate_id;
  end if;
  if not public.authorizeforclassinstructor(v_cand.class_id) then
    raise exception 'Only instructors can apply regrades' using errcode = 'insufficient_privilege';
  end if;
  if v_cand.decision = 'applied' then
    return jsonb_build_object('status', 'already_applied');
  end if;
  if v_cand.staged_submission_id is null then
    raise exception 'Candidate % has no graded staged submission to promote yet', p_candidate_id;
  end if;
  v_staged_id := v_cand.staged_submission_id;

  -- Capture the currently-active submission + autograder score (the "before").
  select s.id, gr.score into v_old_sub_id, v_old_score
  from public.submissions s
  left join public.grader_results gr
    on gr.submission_id = s.id and gr.rerun_for_submission_id is null
  where s.assignment_id = v_cand.assignment_id
    and s.is_active = true
    and (
      (v_cand.assignment_group_id is not null and s.assignment_group_id = v_cand.assignment_group_id)
      or (v_cand.assignment_group_id is null and s.profile_id = v_cand.profile_id and s.assignment_group_id is null)
    )
  order by gr.id desc
  limit 1;

  -- Promote: deactivate prior active submission(s), activate + un-stage the candidate.
  if v_cand.assignment_group_id is not null then
    update public.submissions
    set is_active = false
    where assignment_id = v_cand.assignment_id
      and assignment_group_id = v_cand.assignment_group_id
      and id <> v_staged_id;
  else
    update public.submissions
    set is_active = false
    where assignment_id = v_cand.assignment_id
      and profile_id = v_cand.profile_id
      and assignment_group_id is null
      and id <> v_staged_id;
  end if;

  update public.submissions
  set is_active = true, is_staged = false
  where id = v_staged_id;

  update public.deadline_regrade_candidates
  set decision = 'applied', current_submission_id = v_old_sub_id, current_score = v_old_score, updated_at = now()
  where id = p_candidate_id;

  -- Enqueue gradebook recalculation for affected student(s).
  FOR r IN (
    SELECT DISTINCT gcs.class_id, gcs.gradebook_id, gcs.student_id, gcs.is_private
    FROM public.gradebook_column_students gcs
    JOIN public.gradebook_columns gc
      ON gc.id = gcs.gradebook_column_id
     AND gc.dependencies->'assignments' @> to_jsonb(ARRAY[v_cand.assignment_id]::bigint[])
    WHERE gcs.student_id IN (
      SELECT v_cand.profile_id WHERE v_cand.profile_id IS NOT NULL
      UNION
      SELECT agm.profile_id FROM public.assignment_groups_members agm
      WHERE v_cand.assignment_group_id IS NOT NULL
        AND agm.assignment_group_id = v_cand.assignment_group_id
    )
  ) LOOP
    PERFORM public.enqueue_gradebook_row_recalculation(
      r.class_id, r.gradebook_id, r.student_id, r.is_private, 'deadline_extension_regrade_promote', NULL
    );
  END LOOP;

  -- Notify the affected student(s) with the score differential + links.
  select private_profile_id into v_creator
  from public.user_roles where user_id = auth.uid() and class_id = v_cand.class_id limit 1;
  select name into v_creator_name from public.profiles where id = v_creator;

  insert into public.notifications (class_id, subject, body, style, user_id)
  select
    v_cand.class_id,
    '{}'::jsonb,
    jsonb_build_object(
      'type', 'submission_regraded',
      'action', 'promoted_after_extension',
      'submission_id', v_staged_id,
      'old_submission_id', v_old_sub_id,
      'assignment_id', v_cand.assignment_id,
      'old_score', v_old_score,
      'new_score', v_cand.staged_score,
      'regraded_by', v_creator,
      'regraded_by_name', coalesce(v_creator_name, 'An instructor')
    ),
    'info',
    ur.user_id
  from public.user_roles ur
  where ur.class_id = v_cand.class_id
    and ur.role = 'student'
    and ur.private_profile_id in (
      SELECT v_cand.profile_id WHERE v_cand.profile_id IS NOT NULL
      UNION
      SELECT agm.profile_id FROM public.assignment_groups_members agm
      WHERE v_cand.assignment_group_id IS NOT NULL
        AND agm.assignment_group_id = v_cand.assignment_group_id
    );

  return jsonb_build_object(
    'status', 'applied',
    'old_submission_id', v_old_sub_id,
    'new_submission_id', v_staged_id,
    'old_score', v_old_score,
    'new_score', v_cand.staged_score
  );
end;
$$;

-- =====================================================================
-- 8. Skip a candidate / dismiss a batch
-- =====================================================================
create or replace function public.skip_deadline_regrade(
  p_candidate_id bigint
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_class_id bigint;
begin
  select class_id into v_class_id
  from public.deadline_regrade_candidates where id = p_candidate_id;
  if v_class_id is null then
    raise exception 'Regrade candidate % not found', p_candidate_id;
  end if;
  if not public.authorizeforclassinstructor(v_class_id) then
    raise exception 'Only instructors can skip regrades' using errcode = 'insufficient_privilege';
  end if;
  update public.deadline_regrade_candidates
  set decision = 'skipped', updated_at = now()
  where id = p_candidate_id and decision <> 'applied';
end;
$$;

create or replace function public.dismiss_deadline_regrade_batch(
  p_batch_id bigint,
  p_status text default 'dismissed'
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_class_id bigint;
begin
  if p_status not in ('dismissed', 'applied') then
    raise exception 'Invalid batch status %', p_status;
  end if;
  select class_id into v_class_id
  from public.deadline_regrade_batches where id = p_batch_id;
  if v_class_id is null then
    raise exception 'Regrade batch % not found', p_batch_id;
  end if;
  if not public.authorizeforclassinstructor(v_class_id) then
    raise exception 'Only instructors can close regrade batches' using errcode = 'insufficient_privilege';
  end if;
  -- Unpromoted staged submissions are left in place: they are is_active=false
  -- and invisible to students, and serve as an audit trail of what was previewed.
  update public.deadline_regrade_batches
  set status = p_status, updated_at = now()
  where id = p_batch_id;
end;
$$;

-- =====================================================================
-- 9. Grants
-- =====================================================================
grant execute on function public.enumerate_deadline_regrade_candidates(bigint, timestamptz) to authenticated;
grant execute on function public.regrade_set_candidate_grading(bigint) to authenticated;
grant execute on function public.apply_deadline_regrade(bigint) to authenticated;
grant execute on function public.skip_deadline_regrade(bigint) to authenticated;
grant execute on function public.dismiss_deadline_regrade_batch(bigint, text) to authenticated;
