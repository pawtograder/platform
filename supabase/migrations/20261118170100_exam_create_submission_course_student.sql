-- exam_create_submission creates a submission only for a student of the exam's course (#1270).
--
-- matched_profile_id references any profile, and the staff write policy on exam_scanned_submissions
-- checks only the row's class. exam_create_submission runs as its owner and inserts a submission
-- under that profile, and a profile's owner can read their own submissions in any course. So a
-- grader of course A could point a scanned exam at a course-B student (a PATCH or INSERT through
-- PostgREST; the picker only offers the roster, the API does not), confirm it, and finalize would
-- give that student course A's exam, pages and grade. Reproduced on staging's schema, including
-- #1133's scan guards (investigations, 2026-11-18).
--
-- The function now refuses, before inserting anything, unless the row's profile has a student role
-- in the row's course. A disabled role counts: dropping a course after sitting the exam must not
-- block finalizing it (grading views already hide disabled students until they are re-enabled).
-- The worker treats the error like any other: retries, then the batch errors with this message.
--
-- Depends on 20261118130000 (it replaces that two-argument function). The signature is unchanged,
-- so no worker change is needed and the deploy order of edge functions does not matter.
--
-- Rollback: forward-only. See the .down.sql.txt companion, which restores the 20261118130000 body.

create or replace function public.exam_create_submission(
  p_scanned_submission_id bigint,
  p_expected_profile_id uuid default null
)
returns bigint
language plpgsql
security definer
-- Inserting into public.submissions fires the submission trigger chain (channels,
-- metrics, after-insert hook). Some of those triggers reference tables unqualified and
-- have no search_path of their own, so they inherit this function's. An empty search_path
-- makes them fail with "relation submissions does not exist" — keep public on the path.
set search_path = public, pg_temp
as $$
declare
  v_class_id bigint;
  v_assignment_id bigint;
  v_profile_id uuid;
  v_match_status text;
  v_existing bigint;
  v_submission_id bigint;
begin
  -- Lock the row: a concurrent match edit either commits first (and is seen below) or waits for
  -- this transaction, after which the freeze trigger refuses it because submission_id is set.
  -- NO KEY UPDATE is enough to serialize with those edits, and unlike FOR UPDATE it does not block
  -- the foreign-key checks taken when matching re-links exam_scan_pages to this row.
  select ss.class_id, e.assignment_id, ss.matched_profile_id, ss.match_status, ss.submission_id
    into v_class_id, v_assignment_id, v_profile_id, v_match_status, v_existing
  from public.exam_scanned_submissions ss
  join public.exams e on e.id = ss.exam_id
  where ss.id = p_scanned_submission_id
  for no key update of ss;

  if v_class_id is null then
    raise exception 'Scanned submission % not found', p_scanned_submission_id;
  end if;
  if p_expected_profile_id is not null and v_profile_id is distinct from p_expected_profile_id then
    raise exception
      'Scanned submission % is matched to a different student than this finalize read; it will be retried',
      p_scanned_submission_id;
  end if;
  if v_existing is not null then
    return v_existing; -- idempotent
  end if;
  if v_match_status <> 'confirmed' or v_profile_id is null then
    raise exception 'Scanned submission % is not a confirmed match', p_scanned_submission_id;
  end if;
  -- The profile must be a student of this course. Disabled (dropped) students still count, so an exam
  -- they sat before dropping can be finalized; a profile from another course, or a staff profile,
  -- never does.
  if not exists (
    select 1 from public.user_roles ur
    where ur.private_profile_id = v_profile_id
      and ur.class_id = v_class_id
      and ur.role = 'student'
  ) then
    raise exception
      'Scanned submission % is matched to a profile that is not a student in this course',
      p_scanned_submission_id;
  end if;

  -- Shared lock on the assignment, matching quiz_submit. FOR KEY SHARE does not conflict with
  -- itself (concurrent finalize workers proceed in parallel) but does conflict with the
  -- FOR UPDATE taken by exam_upsert_questions_and_regions, so an instructor cannot rewrite the
  -- question set while this submission's exam_v1 artifact is being written against it.
  perform 1 from public.assignments where id = v_assignment_id for key share;

  insert into public.submissions
    -- 'manual': there is no git commit behind a scanned exam, and without this the submission
    -- history renderer's `sha && repository` branch turns these synthetic values into a
    -- github.com/<repository>/commit/<sha> link that 404s.
    (assignment_id, profile_id, class_id, sha, repository, run_attempt, run_number, is_active, submitted_via)
  values
    (v_assignment_id, v_profile_id, v_class_id, 'exam',
     'exam-scan/' || p_scanned_submission_id::text, 0, 1, true, 'manual')
  returning id into v_submission_id;

  update public.exam_scanned_submissions set submission_id = v_submission_id
    where id = p_scanned_submission_id;

  return v_submission_id;
end;
$$;
revoke all on function public.exam_create_submission(bigint, uuid) from public;
grant execute on function public.exam_create_submission(bigint, uuid) to service_role;
