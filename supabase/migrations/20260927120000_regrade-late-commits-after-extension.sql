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

-- Note: the existing partial unique indexes on submissions filter on
-- `WHERE is_active = true`, and staged submissions are is_active=false, so no
-- index changes are required - staged rows are naturally excluded.

-- Students must not see a staged submission until an instructor promotes it.
-- Same policy as 20250923022246_submissions-perf-rls.sql, with the two
-- student branches (own profile, own group) gated on `NOT is_staged`. The
-- staff branch is unchanged, so instructors and graders still read staged rows.
ALTER POLICY "Instructors and graders can view all submissions in class, stud" ON public.submissions
USING (
  (
    NOT is_staged AND profile_id IN (
      SELECT up.private_profile_id
      FROM public.user_privileges up
      WHERE up.user_id = auth.uid() AND up.private_profile_id IS NOT NULL
    )
  )
  OR (
    class_id IN (
      SELECT up.class_id
      FROM public.user_privileges up
      WHERE up.user_id = auth.uid() AND up.role IN ('instructor','grader')
    )
  )
  OR (
    NOT is_staged AND assignment_group_id IS NOT NULL AND assignment_group_id IN (
      SELECT DISTINCT agm.assignment_group_id
      FROM public.assignment_groups_members agm
      JOIN public.user_privileges upg ON upg.private_profile_id = agm.profile_id
      WHERE upg.user_id = auth.uid()
    )
  )
);

-- =====================================================================
-- 2. Redefine the submissions insert hook to skip activation for staged rows
--    (verbatim copy of the current body from
--    20260828120000_submissions_insert_hook_skip_already_inactive.sql, with the
--    two activation gates extended to also exclude is_staged submissions).
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
    IF NEW.assignment_group_id IS NOT NULL AND NEW.is_staged THEN
      -- A staged preview takes no ordinal: a skipped or retried preview would
      -- otherwise leave a permanent gap in the student's visible numbering.
      -- apply_deadline_regrade assigns the next ordinal when it promotes.
      NEW.ordinal = 0;
      NEW.is_active = false;
    ELSIF NEW.assignment_group_id IS NOT NULL THEN
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
        -- `AND is_active` added 20260828: without it this rewrote every prior
        -- submission for the group, already-inactive ones included.
        UPDATE public.submissions
        SET is_active = false
        WHERE assignment_id = NEW.assignment_id
          AND assignment_group_id = NEW.assignment_group_id
          AND is_active;

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

      IF NEW.is_staged THEN
        -- No ordinal for a staged preview; see the group branch above.
        NEW.ordinal = 0;
        NEW.is_active = false;
        RETURN NEW;
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

      IF NOT NEW.is_not_graded THEN
        NEW.is_active = true;
        -- `AND is_active` added 20260828: without it every insert rewrote the
        -- student's entire submission history for the assignment.
        UPDATE public.submissions
        SET is_active = false
        WHERE assignment_id = NEW.assignment_id
          AND profile_id = NEW.profile_id
          AND is_active;
      END IF;
    END IF;

    RETURN NEW;
  ELSE
    RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
  END CASE;
END;
$$;

COMMENT ON FUNCTION public.submissions_insert_hook_optimized() IS
  'Assigns ordinals, manages is_active, rejects individual INSERT when the student is in a group, demotes straggler individual rows on new group submission and enqueues gradebook row recalc for demoted students. Deactivation UPDATEs are predicated on is_active so an insert does not rewrite already-inactive history (20260828). Staged submissions (is_staged=true) are graded but never auto-activated.';


-- Realtime: broadcast_submission_change pushes every submission row to the
-- owning students' user channels, which bypasses the SELECT policy above.
-- Verbatim copy of the body from
-- 20251011000000_broadcast_submissions_and_notifications.sql, with the
-- per-user broadcasts skipped while the row is staged. The staff broadcast is
-- unchanged.
CREATE OR REPLACE FUNCTION public.broadcast_submission_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    submission_class_id bigint;
    submission_profile_id UUID;
    submission_group_id bigint;
    affected_profile_ids UUID[];
    profile_id UUID;
    payload JSONB;
    submission_is_staged boolean;
BEGIN
    -- Get the submission details
    IF TG_OP = 'INSERT' THEN
        submission_class_id := NEW.class_id;
        submission_profile_id := NEW.profile_id;
        submission_group_id := NEW.assignment_group_id;
    ELSIF TG_OP = 'UPDATE' THEN
        submission_class_id := NEW.class_id;
        submission_profile_id := NEW.profile_id;
        submission_group_id := NEW.assignment_group_id;
    ELSIF TG_OP = 'DELETE' THEN
        submission_class_id := OLD.class_id;
        submission_profile_id := OLD.profile_id;
        submission_group_id := OLD.assignment_group_id;
    END IF;

    -- A staged (deadline-regrade preview) submission is staff-only until promoted.
    -- Promotion is an UPDATE that clears is_staged, which broadcasts to students then.
    submission_is_staged := CASE WHEN TG_OP = 'DELETE' THEN OLD.is_staged ELSE NEW.is_staged END;

    -- Get affected profile IDs (submission author and/or group members)
    IF submission_group_id IS NOT NULL THEN
        -- Group submission: notify all group members
        SELECT ARRAY(
            SELECT DISTINCT agm.profile_id
            FROM assignment_groups_members agm
            WHERE agm.assignment_group_id = submission_group_id
        ) INTO affected_profile_ids;
    ELSIF submission_profile_id IS NOT NULL THEN
        -- Individual submission: notify the author
        affected_profile_ids := ARRAY[submission_profile_id];
    END IF;

    -- Only broadcast if we have affected profiles
    IF affected_profile_ids IS NOT NULL AND array_length(affected_profile_ids, 1) > 0 THEN
        -- Create payload
        payload := jsonb_build_object(
            'type', 'table_change',
            'operation', TG_OP,
            'table', 'submissions',
            'row_id', CASE 
                WHEN TG_OP = 'DELETE' THEN OLD.id
                ELSE NEW.id
            END,
            'data', CASE 
                WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
                ELSE to_jsonb(NEW)
            END,
            'class_id', submission_class_id,
            'timestamp', NOW(),
            'target_audience', 'user'
        );

        -- Broadcast to each affected user's channel (never for staged rows)
        IF NOT submission_is_staged THEN
            FOREACH profile_id IN ARRAY affected_profile_ids
            LOOP
                PERFORM public.safe_broadcast(
                    payload,
                    'broadcast',
                    'class:' || submission_class_id || ':user:' || profile_id,
                    true
                );
            END LOOP;
        END IF;

        -- Broadcast to staff channel (instructors/graders)
        DECLARE
            payload_for_staff JSONB;
        BEGIN
            payload_for_staff := payload || jsonb_build_object('target_audience', 'staff');
            PERFORM public.safe_broadcast(
                payload_for_staff,
                'broadcast',
                'class:' || submission_class_id || ':staff',
                true
            );
        END;
    END IF;

    -- Return the appropriate record
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$;

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
  -- The assignment's minutes_due_after_lab before the save that extended it
  -- (the same save can change it); NULL means not lab-scheduled.
  old_minutes_due_after_lab integer,
  new_due_date timestamptz not null,
  -- open: awaiting instructor review; applied: at least one promotion done and closed;
  -- dismissed: instructor closed without (further) action; superseded: replaced by a newer batch.
  status text not null default 'open' check (status in ('open', 'applied', 'dismissed', 'superseded'))
);
create index if not exists deadline_regrade_batches_assignment_idx
  on public.deadline_regrade_batches (assignment_id, status);
create index if not exists deadline_regrade_batches_class_idx
  on public.deadline_regrade_batches (class_id);
-- At most one open review per assignment (enumeration also takes an advisory lock).
create unique index if not exists deadline_regrade_batches_one_open_per_assignment
  on public.deadline_regrade_batches (assignment_id) where status = 'open';

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
  -- When the commit was pushed (check run created_at): what the window is judged on.
  pushed_at timestamptz,
  -- Snapshot of the currently-active submission at enumeration time (for display).
  current_submission_id bigint references public.submissions(id) on delete set null,
  current_score numeric,
  -- The staged (preview) submission created for this candidate, once graded.
  staged_submission_id bigint references public.submissions(id) on delete set null,
  staged_score numeric,
  staged_status text not null default 'none' check (staged_status in ('none', 'grading', 'graded', 'error')),
  staged_triggered_at timestamptz,
  -- Bumped by every preview reservation; a failed dispatch releases only the
  -- reservation it made (compare-and-swap on this value).
  reservation_generation integer not null default 0,
  decision text not null default 'pending' check (decision in ('pending', 'applied', 'skipped'))
);
create index if not exists deadline_regrade_candidates_batch_idx
  on public.deadline_regrade_candidates (batch_id);
create unique index if not exists deadline_regrade_candidates_unique_target
  on public.deadline_regrade_candidates (batch_id, repository_id);
-- The preview-run RPCs look candidates up by commit.
create index if not exists deadline_regrade_candidates_commit_idx
  on public.deadline_regrade_candidates (repository_id, sha);

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
-- 3b. Effective due date for an arbitrary base due date
--     The regrade window needs each student's effective deadline under the OLD
--     due date. For lab-scheduled assignments that is not new_effective minus
--     the extension: the lab meeting is chosen relative to the base due date,
--     so the result jumps when the base crosses a meeting. The body below is
--     the current calculate_effective_due_date (20260825140000) with the
--     assignment's due_date and minutes_due_after_lab replaced by the supplied
--     base schedule when one is given; the two-argument form now delegates with
--     NULLs, so there is still one copy of the lab logic and its behaviour is
--     unchanged.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.calculate_effective_due_date(assignment_id_param bigint, student_profile_id_param uuid, base_due_date_param timestamp with time zone, base_minutes_due_after_lab_param integer)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $$
DECLARE
    assignment_record RECORD;
    student_lab_section_id bigint;
    most_recent_lab_meeting_date date;
    lab_section_record RECORD;
    course_record RECORD;
    lab_based_due_date timestamp with time zone;
    lab_meeting_timestamp timestamp with time zone;
    lab_end_time time;
    base_due_date timestamp with time zone;
    base_minutes_due_after_lab integer;
BEGIN
    -- Get assignment details
    SELECT * INTO assignment_record
    FROM public.assignments
    WHERE id = assignment_id_param;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Assignment with id % not found', assignment_id_param;
    END IF;

    -- With no base supplied, use the assignment as it is now. With one, the
    -- caller supplies the whole old schedule: its due date AND its lab offset
    -- (NULL offset = not lab-scheduled), since one save can change both.
    IF base_due_date_param IS NULL THEN
        base_due_date := assignment_record.due_date;
        base_minutes_due_after_lab := assignment_record.minutes_due_after_lab;
    ELSE
        base_due_date := base_due_date_param;
        base_minutes_due_after_lab := base_minutes_due_after_lab_param;
    END IF;

    -- If assignment doesn't use lab-based scheduling, return original due date
    IF base_minutes_due_after_lab IS NULL THEN
        RETURN base_due_date;
    END IF;

    -- Get student's lab section for this class
    SELECT lab_section_id INTO student_lab_section_id
    FROM public.user_roles
    WHERE private_profile_id = student_profile_id_param
    AND class_id = assignment_record.class_id
    AND lab_section_id IS NOT NULL;

    -- If student is not in a lab section, fall back to original due date
    IF student_lab_section_id IS NULL THEN
        RETURN base_due_date;
    END IF;

    -- Get lab section details (for end_time)
    SELECT * INTO lab_section_record
    FROM public.lab_sections
    WHERE id = student_lab_section_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Lab section with id % not found', student_lab_section_id;
    END IF;

    -- Get course details (for time_zone)
    SELECT * INTO course_record
    FROM public.classes
    WHERE id = assignment_record.class_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Class with id % not found', assignment_record.class_id;
    END IF;

    -- end_time is nullable, and concatenating a NULL into the meeting timestamp below would
    -- NULL the whole comparison, match no meeting, and silently skip the lab offset. A section
    -- with no recorded end time is treated as ending at the end of its meeting day, which is
    -- what the assignment form's Lab Section Due Date Preview already shows.
    lab_end_time := COALESCE(lab_section_record.end_time, TIME '23:59:59');

    -- Find the most recent lab section meeting before the assignment's original due date
    -- Convert meeting date + lab section end time to timestamp in course timezone
    SELECT meeting_date INTO most_recent_lab_meeting_date
    FROM public.lab_section_meetings lsm
    WHERE lsm.lab_section_id = student_lab_section_id
    AND (
        (lsm.meeting_date::text || ' ' || lab_end_time::text)::timestamp AT TIME ZONE course_record.time_zone
    ) <= base_due_date
    AND NOT lsm.cancelled
    ORDER BY lsm.meeting_date DESC
    LIMIT 1;

    -- If no lab meeting found before due date, fall back to original due date
    IF most_recent_lab_meeting_date IS NULL THEN
        RETURN base_due_date;
    END IF;

    -- Combine meeting date with lab section end time and apply course time zone
    lab_meeting_timestamp := (
        most_recent_lab_meeting_date::text || ' ' || lab_end_time::text
    )::timestamp AT TIME ZONE course_record.time_zone;

    -- Calculate lab-based due date
    lab_based_due_date := lab_meeting_timestamp
                         + (base_minutes_due_after_lab * INTERVAL '1 minute');

    -- Return the lab-based due date
    RETURN lab_based_due_date;
END;
$$;

CREATE OR REPLACE FUNCTION public.calculate_effective_due_date(assignment_id_param bigint, student_profile_id_param uuid)
 RETURNS timestamp with time zone
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $$
    SELECT public.calculate_effective_due_date(assignment_id_param, student_profile_id_param, NULL::timestamp with time zone, NULL::integer);
$$;

revoke all on function public.calculate_effective_due_date(bigint, uuid, timestamp with time zone, integer) from public, anon, authenticated;

-- =====================================================================
-- 4. Enumerate candidates (creates a batch + candidate rows)
-- =====================================================================
create or replace function public.enumerate_deadline_regrade_candidates(
  p_assignment_id bigint,
  p_old_due_date timestamptz,
  p_old_minutes_due_after_lab integer
) returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_class_id bigint;
  v_new_due_date timestamptz;
  v_has_autograder boolean;
  v_old_due_date timestamptz;
  v_old_minutes integer;
  v_new_minutes integer;
  v_earliest record;
  v_creator uuid;
  v_batch_id bigint;
  v_superseded bigint[];
  v_count integer;
begin
  select class_id, due_date, has_autograder, minutes_due_after_lab
  into v_class_id, v_new_due_date, v_has_autograder, v_new_minutes
  from public.assignments where id = p_assignment_id;
  if v_class_id is null then
    raise exception 'Assignment % not found', p_assignment_id;
  end if;

  if not public.authorizeforclassinstructor(v_class_id) then
    raise exception 'Only instructors can enumerate deadline regrade candidates'
      using errcode = 'insufficient_privilege';
  end if;

  -- Without an autograder there is no grading workflow to stage, so every
  -- candidate would fail at the trigger's grade.yml preflight.
  if not coalesce(v_has_autograder, false) then
    raise exception 'Assignment % has no autograder; there is nothing to re-grade', p_assignment_id;
  end if;

  -- An extension can come from the base due date OR from the lab offset alone
  -- (minutes_due_after_lab raised, or lab scheduling switched off). Per-student
  -- windows are computed exactly below, so a student whose deadline did not
  -- move simply gets an empty window.
  if p_old_due_date is null or v_new_due_date is null
     or (v_new_due_date <= p_old_due_date
         and v_new_minutes is not distinct from p_old_minutes_due_after_lab) then
    raise exception 'The assignment due date or lab offset must have moved later to enumerate late commits';
  end if;

  select private_profile_id into v_creator
  from public.user_roles
  where user_id = auth.uid() and class_id = v_class_id
  limit 1;

  -- Two instructors saving the same assignment at once must not both see "no
  -- open batch" and each open a review. Serialize per assignment; the partial
  -- unique index on open batches is the backstop.
  perform pg_advisory_xact_lock(hashtextextended('deadline_regrade_batches:' || p_assignment_id::text, 0));

  -- A second extension before the first review is finished supersedes the open
  -- batch. Widen the window back to the earliest open batch's old deadline so its
  -- unresolved commits are re-enumerated here rather than stranded.
  select array_agg(id) into v_superseded
  from public.deadline_regrade_batches
  where assignment_id = p_assignment_id and status = 'open';
  select old_due_date, old_minutes_due_after_lab into v_earliest
  from public.deadline_regrade_batches
  where assignment_id = p_assignment_id and status = 'open'
  order by old_due_date asc
  limit 1;
  -- An open batch's old schedule predates the save being handled now (it was
  -- the schedule before an earlier, still-unreviewed extension), so always
  -- keep it whole -- due date AND lab offset -- rather than comparing only the
  -- due dates, which are equal when the extensions were lab-offset-only.
  if v_earliest.old_due_date is not null then
    v_old_due_date := v_earliest.old_due_date;
    v_old_minutes := v_earliest.old_minutes_due_after_lab;
  else
    v_old_due_date := p_old_due_date;
    v_old_minutes := p_old_minutes_due_after_lab;
  end if;

  update public.deadline_regrade_batches
  set status = 'superseded', updated_at = now()
  where id = any(coalesce(v_superseded, '{}'::bigint[]));

  insert into public.deadline_regrade_batches
    (class_id, assignment_id, created_by, old_due_date, old_minutes_due_after_lab, new_due_date, status)
  values (v_class_id, p_assignment_id, v_creator, v_old_due_date, v_old_minutes, v_new_due_date, 'open')
  returning id into v_batch_id;

  -- For each repository (one per student or group) compute the per-student
  -- effective window and select the latest commit pushed inside it.
  insert into public.deadline_regrade_candidates
    (batch_id, class_id, assignment_id, profile_id, assignment_group_id,
     repository_id, repository, sha, commit_message, commit_date, pushed_at,
     current_submission_id, current_score, staged_status, decision)
  select
    v_batch_id, v_class_id, p_assignment_id, r.profile_id, r.assignment_group_id,
    r.id, r.repository, cand.sha, cand.commit_message, cand.commit_date, cand.pushed_at,
    act.id, act.score, 'none', 'pending'
  from public.repositories r
  -- Group repositories have no profile_id, but calculate_final_due_date derives
  -- the lab-based deadline from a student profile. Pick a member the same way
  -- autograder-create-submission does.
  left join lateral (
    select agm.profile_id
    from public.assignment_groups_members agm
    where r.assignment_group_id is not null
      and agm.assignment_group_id = r.assignment_group_id
    limit 1
  ) member on true
  cross join lateral (
    select public.calculate_final_due_date(
      p_assignment_id, coalesce(r.profile_id, member.profile_id), r.assignment_group_id
    ) as new_eff,
    public.calculate_effective_due_date(p_assignment_id, coalesce(r.profile_id, member.profile_id)) as new_base,
    public.calculate_effective_due_date(
      p_assignment_id, coalesce(r.profile_id, member.profile_id), v_old_due_date, v_old_minutes
    ) as old_base
  ) eff
  cross join lateral (
    -- new_eff = new_base + the student's due-date exceptions, so the old
    -- effective deadline is the old lab/regular deadline plus those same
    -- exceptions (assumed unchanged by the due-date move).
    select eff.new_eff as new_eff,
           eff.old_base + (eff.new_eff - eff.new_base) as old_eff
  ) win
  left join lateral (
    -- The window is judged on push time (check run created_at), which is what
    -- autograder-create-submission's deadline check uses; the commit's own
    -- timestamp is kept for display only. #NOT-GRADED commits are practice
    -- runs that must never become the graded submission.
    select cr.sha, cr.commit_message,
           coalesce((cr.status->>'commit_date')::timestamptz, cr.created_at) as commit_date,
           cr.created_at as pushed_at
    from public.repository_check_runs cr
    where cr.repository_id = r.id
      and cr.created_at > win.old_eff
      and cr.created_at <= win.new_eff
      and upper(coalesce(cr.commit_message, '')) not like '%#NOT-GRADED%'
    order by cr.created_at desc, cr.id desc
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
    -- Only students still enrolled: repositories and their push history
    -- outlive an SIS drop (user_roles.disabled). A group needs one enabled member.
    and exists (
      select 1 from public.user_roles ur
      where ur.class_id = v_class_id and ur.role = 'student' and not ur.disabled
        and (
          ur.private_profile_id = r.profile_id
          or (r.assignment_group_id is not null and ur.private_profile_id in (
                select agm.profile_id from public.assignment_groups_members agm
                where agm.assignment_group_id = r.assignment_group_id))
        )
    )
    -- A personal repository retained after its owner joined a group cannot be
    -- graded (autograder-create-submission rejects it); the group repo covers them.
    and not (
      r.assignment_group_id is null and exists (
        select 1 from public.assignment_groups_members agm
        where agm.assignment_id = p_assignment_id and agm.profile_id = r.profile_id
      )
    )
    -- skip when the candidate commit is already the active submission's commit
    and (act.id is null or not exists (
          select 1 from public.submissions s2 where s2.id = act.id and s2.sha = cand.sha
        ));
  get diagnostics v_count = row_count;

  -- Carry forward work already done in superseded batches on the same commit:
  -- a graded preview does not need re-grading, and a skip stays a skip.
  if v_superseded is not null then
    update public.deadline_regrade_candidates c
    set staged_submission_id = prev.staged_submission_id,
        staged_score = prev.staged_score,
        staged_status = prev.staged_status,
        staged_triggered_at = prev.staged_triggered_at,
        decision = prev.decision,
        updated_at = now()
    from (
      select distinct on (p.repository_id, p.sha) p.*
      from public.deadline_regrade_candidates p
      where p.batch_id = any(v_superseded) and p.decision <> 'applied'
      order by p.repository_id, p.sha, p.id desc
    ) prev
    where c.batch_id = v_batch_id
      and c.repository_id = prev.repository_id
      and c.sha = prev.sha;
  end if;

  -- Nothing to review: close the batch so the dashboard does not show an empty
  -- "late commits await review" banner.
  if v_count = 0 then
    update public.deadline_regrade_batches
    set status = 'dismissed', updated_at = now()
    where id = v_batch_id;
  end if;

  return v_batch_id;
end;
$$;

-- =====================================================================
-- 5. Preview-run reservation (service role only; called by
--    autograder-trigger-grading-workflow). A preview is dispatched on its own
--    tag, refs/tags/pawtograder-preview/<sha>, and autograder-create-submission
--    stages a run only when its OIDC token carries that ref, so the preview
--    status is bound to the run itself: an ordinary regrade of the same sha
--    (refs/tags/pawtograder-submit/<sha>) or a student push is never staged.
--    Reserving first authorizes the preview against a pending candidate in an
--    open review and marks it grading; release undoes that if the dispatch fails.
-- =====================================================================
create or replace function public.regrade_reserve_preview_run(
  p_repository_id bigint,
  p_sha text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id bigint;
  v_generation integer;
begin
  select c.id into v_id
  from public.deadline_regrade_candidates c
  join public.deadline_regrade_batches b on b.id = c.batch_id and b.status = 'open'
  where c.repository_id = p_repository_id and c.sha = p_sha and c.decision = 'pending'
  order by c.id desc
  limit 1
  for update of c;
  if v_id is null then
    raise exception 'No pending deadline regrade candidate for this commit in an open review';
  end if;
  -- One live preview per candidate. A second reservation while the first is
  -- still in flight would let either request's failed dispatch mislabel the
  -- other's running workflow. After 30 minutes (the review page's stale
  -- threshold) a retry is allowed.
  if exists (
    select 1 from public.deadline_regrade_candidates
    where id = v_id and staged_status = 'grading' and staged_triggered_at > now() - interval '30 minutes'
  ) then
    raise exception 'A preview for this commit is already being graded';
  end if;

  update public.deadline_regrade_candidates
  set staged_triggered_at = now(),
      -- A run may already have graded the candidate; never downgrade 'graded'.
      staged_status = case when staged_status = 'graded' then 'graded' else 'grading' end,
      reservation_generation = reservation_generation + 1,
      updated_at = now()
  where id = v_id
  returning reservation_generation into v_generation;
  return jsonb_build_object('candidate_id', v_id, 'generation', v_generation);
end;
$$;

create or replace function public.regrade_release_preview_run(
  p_candidate_id bigint,
  p_generation integer
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Compare-and-swap: only if no other reservation was made since this one.
  -- Otherwise another instructor's dispatch may be in flight, and clearing
  -- 'grading' would stop polling and re-enable Finish under it.
  update public.deadline_regrade_candidates
  set staged_status = 'none', updated_at = now()
  where id = p_candidate_id
    and reservation_generation = p_generation
    and staged_status = 'grading';
end;
$$;

revoke all on function public.regrade_reserve_preview_run(bigint, text) from public, anon, authenticated;
revoke all on function public.regrade_release_preview_run(bigint, integer) from public, anon, authenticated;
grant execute on function public.regrade_reserve_preview_run(bigint, text) to service_role;
grant execute on function public.regrade_release_preview_run(bigint, integer) to service_role;

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
    -- The newest preview wins: a retry offered after the stale threshold may
    -- finish after the run it replaced, and its result must not be ignored.
    -- (Promotion is a compare-and-swap on the page's numbers, so a swap here
    -- can never be promoted unseen.)
    and (c.staged_submission_id is null or c.staged_submission_id <= v_sub.id)
    and (
      (v_sub.assignment_group_id is not null and c.assignment_group_id = v_sub.assignment_group_id)
      or (v_sub.assignment_group_id is null and c.profile_id = v_sub.profile_id)
    );

  return NEW;
end;
$$;

drop trigger if exists trg_regrade_backfill_staged_result on public.grader_results;
-- Also on score updates: autograder-submit-feedback resolves a duplicate result
-- for a submission (a retried preview run) by rewriting the existing row.
create trigger trg_regrade_backfill_staged_result
  after insert or update of score on public.grader_results
  for each row execute function public.regrade_backfill_staged_result();

-- =====================================================================
-- 7. Apply (promote) a candidate's staged submission
-- =====================================================================
create or replace function public.apply_deadline_regrade(
  p_candidate_id bigint,
  -- Compare-and-swap: the comparison the instructor was looking at when they
  -- pressed Promote (and accepted or skipped the lower-score confirmation).
  -- Promotion goes ahead only if these still hold under lock.
  p_expected_current_submission_id bigint,
  p_expected_current_score numeric,
  p_expected_staged_score numeric
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
  v_counter_group bigint;
  v_counter_profile uuid;
  v_ordinal integer;
  v_new_score numeric;
  v_deadline timestamptz;
  r RECORD;
begin
  -- Lock the candidate so overlapping calls (double click, two instructors)
  -- serialize: the second one sees decision = 'applied' and returns early
  -- instead of promoting and notifying a second time.
  select * into v_cand from public.deadline_regrade_candidates where id = p_candidate_id for update;
  if v_cand.id is null then
    raise exception 'Regrade candidate % not found', p_candidate_id;
  end if;
  if not public.authorizeforclassinstructor(v_cand.class_id) then
    raise exception 'Only instructors can apply regrades' using errcode = 'insufficient_privilege';
  end if;
  if v_cand.decision = 'applied' then
    return jsonb_build_object('status', 'already_applied');
  end if;
  if v_cand.decision <> 'pending' then
    raise exception 'Candidate % was %; only pending candidates can be promoted', p_candidate_id, v_cand.decision;
  end if;
  -- Lock the batch too, so a concurrent dismiss or supersede serializes with
  -- this promotion instead of committing between the check and the updates.
  perform 1 from public.deadline_regrade_batches b
  where b.id = v_cand.batch_id and b.status = 'open'
  for update;
  if not found then
    raise exception 'Candidate % belongs to a regrade review that is no longer open', p_candidate_id;
  end if;
  if v_cand.staged_submission_id is null then
    raise exception 'Candidate % has no graded staged submission to promote yet', p_candidate_id;
  end if;
  v_staged_id := v_cand.staged_submission_id;
  if exists (select 1 from public.submissions where id = v_staged_id and is_not_graded) then
    raise exception 'Candidate % is a #NOT-GRADED submission and cannot be promoted', p_candidate_id;
  end if;

  -- Take the same per-student (or per-group) submission_ordinal_counters row
  -- lock that submissions_insert_hook_optimized takes for every insert. That
  -- serializes this promotion with ordinary submissions: one committed before
  -- the lock is visible to the snapshot read below, and one arriving later
  -- waits until this transaction commits. The row is created if the student
  -- has never submitted (next_ordinal = 1 matches what the hook would assign).
  if v_cand.assignment_group_id is not null then
    v_counter_group := v_cand.assignment_group_id;
    v_counter_profile := '00000000-0000-0000-0000-000000000000'::uuid;
  else
    v_counter_group := 0;
    v_counter_profile := v_cand.profile_id;
  end if;
  insert into public.submission_ordinal_counters
    (assignment_id, assignment_group_id, profile_id, next_ordinal, updated_at)
  values (v_cand.assignment_id, v_counter_group, v_counter_profile, 1, now())
  on conflict (assignment_id, assignment_group_id, profile_id) do nothing;
  perform 1 from public.submission_ordinal_counters
  where assignment_id = v_cand.assignment_id
    and assignment_group_id = v_counter_group
    and profile_id = v_counter_profile
  for update;

  -- A group promotion also demotes members' individual submissions, and
  -- submission_set_active serializes an individual activation on the
  -- member's OWN counter. So lock every member's individual counter too
  -- (profile order, to keep a consistent lock order).
  if v_cand.assignment_group_id is not null then
    insert into public.submission_ordinal_counters
      (assignment_id, assignment_group_id, profile_id, next_ordinal, updated_at)
    select v_cand.assignment_id, 0, agm.profile_id, 1, now()
    from public.assignment_groups_members agm
    where agm.assignment_group_id = v_cand.assignment_group_id
    on conflict (assignment_id, assignment_group_id, profile_id) do nothing;
    perform 1 from public.submission_ordinal_counters soc
    where soc.assignment_id = v_cand.assignment_id
      and soc.assignment_group_id = 0
      and soc.profile_id in (
        select agm.profile_id from public.assignment_groups_members agm
        where agm.assignment_group_id = v_cand.assignment_group_id
      )
    order by soc.profile_id
    for update;
  end if;

  -- Lock the active submission(s) in scope and the preview. Besides fixing the
  -- rows this promotion updates, FOR UPDATE conflicts with the FOR KEY SHARE
  -- lock that a new grader_results row's foreign-key check takes on its
  -- submission, so autograder-submit-feedback cannot insert a FIRST result for
  -- either one between the comparison below and the promotion.
  perform 1 from public.submissions s
  where s.assignment_id = v_cand.assignment_id
    and (s.is_active or s.id = v_staged_id)
    and (
      (v_cand.assignment_group_id is not null and s.assignment_group_id = v_cand.assignment_group_id)
      or (v_cand.assignment_group_id is null and s.profile_id = v_cand.profile_id and s.assignment_group_id is null)
    )
  for update of s;

  -- And lock their existing grader results, so neither score can be rewritten
  -- in that window either.
  perform 1 from public.grader_results gr
  where gr.rerun_for_submission_id is null
    and gr.submission_id in (
      select s.id from public.submissions s
      where s.assignment_id = v_cand.assignment_id
        and (s.is_active or s.id = v_staged_id)
        and (
          (v_cand.assignment_group_id is not null and s.assignment_group_id = v_cand.assignment_group_id)
          or (v_cand.assignment_group_id is null and s.profile_id = v_cand.profile_id and s.assignment_group_id is null)
        )
    )
  for update of gr;

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

  -- The student may have pushed again (and got a new active submission) after
  -- the review was enumerated. The instructor's decision, including the
  -- lower-score confirmation, was made against the old snapshot, so refresh the
  -- snapshot and make them decide again instead of silently replacing it.
  -- The preview itself can be re-scored the same way, so read it fresh too.
  select gr.score into v_new_score
  from public.grader_results gr
  where gr.submission_id = v_staged_id and gr.rerun_for_submission_id is null
  order by gr.id desc
  limit 1;

  -- Compare against what the instructor saw, not against the candidate row:
  -- the backfill trigger can refresh the row (a re-scored preview) after the
  -- page loaded, and the decision was made on the page's numbers. Either
  -- submission can also have been re-scored (a workflow retry rewrites its
  -- grader result), which changes the comparison just as much.
  if v_old_sub_id is distinct from p_expected_current_submission_id
     or v_old_score is distinct from p_expected_current_score
     or v_new_score is distinct from p_expected_staged_score then
    update public.deadline_regrade_candidates
    set current_submission_id = v_old_sub_id, current_score = v_old_score,
        staged_score = v_new_score, updated_at = now()
    where id = p_candidate_id;
    return jsonb_build_object(
      'status', 'active_changed',
      'old_submission_id', v_old_sub_id,
      'old_score', v_old_score,
      'new_submission_id', v_staged_id,
      'new_score', v_new_score
    );
  end if;

  -- The deadline may have been shortened again after the review was opened
  -- (the editor also dismisses the open review then). Promote only a commit
  -- that is on time under the student's CURRENT deadline.
  select public.calculate_final_due_date(
    v_cand.assignment_id,
    coalesce(v_cand.profile_id, (
      select agm.profile_id from public.assignment_groups_members agm
      where agm.assignment_group_id = v_cand.assignment_group_id
      limit 1
    )),
    v_cand.assignment_group_id
  ) into v_deadline;
  if coalesce(v_cand.pushed_at, v_cand.commit_date) > v_deadline then
    raise exception 'Commit % was pushed after the current deadline (%); the extension it relied on is no longer in effect',
      left(v_cand.sha, 7), v_deadline;
  end if;

  -- Promote: deactivate prior active submission(s), activate + un-stage the candidate.
  -- Predicated on is_active so already-inactive history is not rewritten
  -- (same reasoning as 20260828120000).
  if v_cand.assignment_group_id is not null then
    update public.submissions
    set is_active = false
    where assignment_id = v_cand.assignment_id
      and assignment_group_id = v_cand.assignment_group_id
      and id <> v_staged_id
      and is_active;
    -- Like a normal group submission (submissions_insert_hook_optimized), also
    -- demote any straggler active INDIVIDUAL submission of a group member, so
    -- no student ends up with two active rows. Their gradebook rows are
    -- recalculated by the loop below, which covers every group member.
    update public.submissions s
    set is_active = false
    from public.assignment_groups_members agm
    where agm.assignment_id = v_cand.assignment_id
      and agm.assignment_group_id = v_cand.assignment_group_id
      and s.assignment_id = v_cand.assignment_id
      and s.profile_id = agm.profile_id
      and s.assignment_group_id is null
      and s.is_active;
  else
    update public.submissions
    set is_active = false
    where assignment_id = v_cand.assignment_id
      and profile_id = v_cand.profile_id
      and assignment_group_id is null
      and id <> v_staged_id
      and is_active;
  end if;

  -- Staged previews do not take an ordinal (see the insert hook), so the
  -- promoted row gets the next one now, as if it had just been submitted.
  update public.submission_ordinal_counters
  set next_ordinal = next_ordinal + 1, updated_at = now()
  where assignment_id = v_cand.assignment_id
    and assignment_group_id = v_counter_group
    and profile_id = v_counter_profile
  returning next_ordinal - 1 into v_ordinal;

  update public.submissions
  set is_active = true, is_staged = false, ordinal = v_ordinal
  where id = v_staged_id;

  update public.deadline_regrade_candidates
  set decision = 'applied', updated_at = now()
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
    and not ur.disabled
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
  -- Unpromoted staged submissions are left in place: they are is_active=false,
  -- hidden from students by the submissions SELECT policy above, and serve as
  -- an audit trail of what was previewed.
  update public.deadline_regrade_batches
  set status = p_status, updated_at = now()
  where id = p_batch_id;
end;
$$;

-- =====================================================================
-- 8b. Submission limits must not count staged previews
--     (verbatim copy of 20260115120000_add_submissions_remaining_to_limits.sql
--     with `AND NOT s.is_staged` added to the count).
-- =====================================================================
CREATE OR REPLACE FUNCTION public.get_submissions_limits(p_assignment_id int8)
RETURNS TABLE(
	id int8,
	created_at timestamptz,
	max_submissions_count int4,
	max_submissions_period_secs int4,
	submissions_used int4,
	submissions_remaining int4
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
	v_profile_id uuid;
	v_assignment_group_id int8;
	v_submissions_count int4;
	v_max_submissions_count int4;
	v_max_submissions_period_secs int4;
BEGIN
	-- Get the student's profile_id
	SELECT ur.private_profile_id INTO v_profile_id
	FROM public.user_privileges up
	JOIN public.user_roles ur ON ur.user_id = up.user_id AND ur.class_id = up.class_id
	WHERE up.role = 'student'
	  AND up.user_id = auth.uid()
	  AND EXISTS (
		SELECT 1
		FROM public.assignments a
		WHERE a.id = p_assignment_id
		  AND a.class_id = up.class_id
	  )
	LIMIT 1;

	-- If no profile found, return empty result
	IF v_profile_id IS NULL THEN
		RETURN;
	END IF;

	-- Check if student is in a group for this assignment
	SELECT agm.assignment_group_id INTO v_assignment_group_id
	FROM public.assignment_groups_members agm
	WHERE agm.assignment_id = p_assignment_id
	  AND agm.profile_id = v_profile_id
	LIMIT 1;

	-- Get autograder settings
	SELECT a.max_submissions_count, a.max_submissions_period_secs
	INTO v_max_submissions_count, v_max_submissions_period_secs
	FROM public.autograder a
	JOIN public.assignments asn ON asn.id = a.id
	WHERE a.id = p_assignment_id
	  AND EXISTS (
		SELECT 1
		FROM public.user_privileges up
		WHERE up.role = 'student'
		  AND up.user_id = auth.uid()
		  AND up.class_id = asn.class_id
	  )
	LIMIT 1;

	-- If no autograder settings found, return empty result
	IF v_max_submissions_count IS NULL OR v_max_submissions_period_secs IS NULL THEN
		RETURN;
	END IF;

	-- Count submissions within the time window
	-- Only count submissions where grader_results IS NULL OR grader_results.score > 0
	SELECT COUNT(*)::int4 INTO v_submissions_count
	FROM public.submissions s
	LEFT JOIN public.grader_results gr ON gr.submission_id = s.id
	WHERE s.assignment_id = p_assignment_id
	  AND s.created_at >= (NOW() - (v_max_submissions_period_secs || ' seconds')::interval)
	  AND (
		(v_assignment_group_id IS NOT NULL AND s.assignment_group_id = v_assignment_group_id)
		OR (v_assignment_group_id IS NULL AND s.profile_id = v_profile_id AND s.assignment_group_id IS NULL)
	  )
	  AND (gr.id IS NULL OR gr.score > 0)
	  -- An instructor's staged preview is not a student attempt.
	  AND NOT s.is_staged;

	-- Return the result
	RETURN QUERY
	SELECT 
		p_assignment_id as id,
		NOW() as created_at,
		v_max_submissions_count as max_submissions_count,
		v_max_submissions_period_secs as max_submissions_period_secs,
		v_submissions_count as submissions_used,
		GREATEST(0, v_max_submissions_count - v_submissions_count) as submissions_remaining;
END;
$$;

-- =====================================================================
-- 8c. submission_set_active must not activate a staged preview
--     (verbatim copy of the current body from
--     20250918192649_instructors-can-set-active-submissions.sql with the
--     is_staged check added after the NOT-GRADED one, and the per-student
--     submission_ordinal_counters lock taken before any is_active change).
-- =====================================================================
CREATE OR REPLACE FUNCTION public.submission_set_active(_submission_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $$
DECLARE
    submission_record RECORD;
    is_staff boolean;
    final_due_date timestamp with time zone;
BEGIN
    -- Get the submission details
    SELECT * INTO submission_record 
    FROM submissions 
    WHERE id = _submission_id;

    -- Check if submission exists
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    -- Check if user is staff
    SELECT EXISTS (
        SELECT 1
        FROM user_privileges
        WHERE user_id = auth.uid()
        AND class_id = submission_record.class_id
        AND role IN ('instructor','grader')
    ) INTO is_staff;
    
    -- SECURITY CHECK: Verify user has permission to modify this submission
    IF NOT authorize_for_submission(_submission_id) and NOT is_staff THEN
        RETURN FALSE;
    END IF;

    if NOT is_staff THEN
        -- Only staff can set active submissions after the effective due date
        final_due_date := public.calculate_final_due_date(submission_record.assignment_id, submission_record.profile_id, submission_record.assignment_group_id);
        IF NOW() > final_due_date THEN
            RETURN FALSE;
        END IF;
    END IF;
    
    -- Prevent NOT-GRADED submissions from becoming active
    IF submission_record.is_not_graded THEN
        RETURN FALSE;
    END IF;

    -- A staged deadline-regrade preview is promoted only by
    -- apply_deadline_regrade, which records the decision and notifies students.
    IF submission_record.is_staged THEN
        RETURN FALSE;
    END IF;

    -- Serialize with apply_deadline_regrade and new submissions, which both
    -- hold this student's (or group's) submission_ordinal_counters row lock
    -- while they change which submission is active.
    INSERT INTO public.submission_ordinal_counters
        (assignment_id, assignment_group_id, profile_id, next_ordinal, updated_at)
    VALUES (
        submission_record.assignment_id,
        COALESCE(submission_record.assignment_group_id, 0),
        CASE WHEN submission_record.assignment_group_id IS NOT NULL
             THEN '00000000-0000-0000-0000-000000000000'::uuid
             ELSE submission_record.profile_id END,
        1, now())
    ON CONFLICT (assignment_id, assignment_group_id, profile_id) DO NOTHING;
    PERFORM 1 FROM public.submission_ordinal_counters
    WHERE assignment_id = submission_record.assignment_id
      AND assignment_group_id = COALESCE(submission_record.assignment_group_id, 0)
      AND profile_id = CASE WHEN submission_record.assignment_group_id IS NOT NULL
                            THEN '00000000-0000-0000-0000-000000000000'::uuid
                            ELSE submission_record.profile_id END
    FOR UPDATE;

    -- Set all other submissions for this assignment/student to inactive
    -- Handle individual vs group submissions separately to avoid cross-contamination
    IF submission_record.assignment_group_id IS NOT NULL THEN
        -- Group submission: deactivate other submissions for the same group
        UPDATE submissions 
        SET is_active = false 
        WHERE assignment_id = submission_record.assignment_id 
        AND assignment_group_id = submission_record.assignment_group_id
        AND id != _submission_id;
    ELSE
        -- Individual submission: deactivate other submissions for the same student
        UPDATE submissions 
        SET is_active = false 
        WHERE assignment_id = submission_record.assignment_id 
        AND profile_id = submission_record.profile_id
        AND assignment_group_id IS NULL  -- Ensure we only match individual submissions
        AND id != _submission_id;
    END IF;
    
    -- Set this submission as active
    UPDATE submissions 
    SET is_active = true 
    WHERE id = _submission_id;
    
    RETURN TRUE;
END;
$$;

-- =====================================================================
-- 8d. submissions_agg must not count or surface staged previews
--     (verbatim from 20260122210846_add_review_graded_to_submissions_agg.sql,
--     with `NOT is_staged` added to the submissions join; same columns, so
--     CREATE OR REPLACE is enough and dependents are untouched).
-- =====================================================================
CREATE OR REPLACE VIEW "public"."submissions_agg" WITH ("security_invoker"='true') AS
 SELECT "c"."profile_id",
    "p"."name",
    "p"."sortable_name",
    "p"."avatar_url",
    "groups"."name" AS "groupname",
    "c"."submissioncount",
    "c"."latestsubmissionid",
    "s"."id",
    "s"."created_at",
    "s"."assignment_id",
    "s"."profile_id" AS "user_id",
    "s"."released",
    "s"."sha",
    "s"."repository",
    "s"."run_attempt",
    "s"."run_number",
    "g"."score",
    "g"."ret_code",
    "g"."execution_time",
    CASE 
      WHEN "sr"."completed_at" IS NOT NULL AND "sr"."completed_by" IS NOT NULL THEN true
      ELSE false
    END AS "is_review_graded"
   FROM (((((( SELECT "count"("submissions"."id") AS "submissioncount",
            "max"("submissions"."id") AS "latestsubmissionid",
            "r"."private_profile_id" AS "profile_id"
           FROM (("public"."user_roles" "r"
             LEFT JOIN "public"."assignment_groups_members" "m" ON (("m"."profile_id" = "r"."private_profile_id")))
             LEFT JOIN "public"."submissions" ON (((("submissions"."profile_id" = "r"."private_profile_id") OR ("submissions"."assignment_group_id" = "m"."assignment_group_id")) AND (NOT "submissions"."is_staged"))))
          WHERE ("r"."disabled" = false)
          GROUP BY "submissions"."assignment_id", "r"."private_profile_id") "c"
     LEFT JOIN "public"."submissions" "s" ON (("s"."id" = "c"."latestsubmissionid")))
     LEFT JOIN "public"."assignment_groups" "groups" ON (("groups"."id" = "s"."assignment_group_id")))
     LEFT JOIN "public"."grader_results" "g" ON (("g"."submission_id" = "s"."id")))
     LEFT JOIN "public"."submission_reviews" "sr" ON (("sr"."id" = "s"."grading_review_id")))
     JOIN "public"."profiles" "p" ON (("p"."id" = "c"."profile_id")));

ALTER VIEW "public"."submissions_agg" OWNER TO "postgres";

-- =====================================================================
-- 8e. Only the regrade review can un-stage or activate a preview
--     The existing "Instructors and graders update" policy lets any grader
--     update every column of a submission, and staff can read staged rows, so
--     without this a grader could clear is_staged (or set is_active) on a
--     preview and bypass the instructor-only promotion and its notification.
--     Deliberately not SECURITY DEFINER, so current_user is the caller:
--     PostgREST requests run as authenticated/anon, while
--     apply_deadline_regrade runs as its owner.
-- =====================================================================
create or replace function public.guard_staged_submission_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if (not NEW.is_staged or NEW.is_active) and current_user in ('authenticated', 'anon') then
    raise exception 'A deadline-regrade preview can only be promoted from the regrade review'
      using errcode = 'insufficient_privilege';
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_guard_staged_submission_update on public.submissions;
create trigger trg_guard_staged_submission_update
  before update on public.submissions
  for each row
  when (OLD.is_staged)
  execute function public.guard_staged_submission_update();

-- =====================================================================
-- 9. Grants
-- =====================================================================
grant execute on function public.enumerate_deadline_regrade_candidates(bigint, timestamptz, integer) to authenticated;
grant execute on function public.apply_deadline_regrade(bigint, bigint, numeric, numeric) to authenticated;
grant execute on function public.skip_deadline_regrade(bigint) to authenticated;
grant execute on function public.dismiss_deadline_regrade_batch(bigint, text) to authenticated;
