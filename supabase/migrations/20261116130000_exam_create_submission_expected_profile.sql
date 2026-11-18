-- finalize must create the submission for the student it read, or not at all (#1270).
--
-- exam-async-worker's finalize reads matched_profile_id, then calls exam_create_submission, then
-- writes the submission's files, storage keys and exam_v1 artifact under the profile it read. The
-- RPC re-read the row without a lock and took the owner from it. A match edit landing between the
-- two (a re-pick in review after an error and Retry, while an earlier finalize message is still
-- queued or redelivered) created Bob's submission holding Alice's pages, files and artifact.
-- exam_scanned_submission_freeze_match only covers batches that are finalizing or completed and
-- rows that already have a submission, so it does not close that window.
--
-- A caller passes the profile it read as p_expected_profile_id. The exam worker starts doing so in a
-- separate change that must deploy after this migration (#1270), so this function exists before
-- anything calls it with two arguments. Under the row lock the function refuses when the row
-- no longer names that student, BEFORE its idempotent "already has a submission" return, so a stale
-- copy of the message can neither create nor adopt a submission for someone else. The worker treats
-- the error like any other failure: the message is retried and the retry reads the row again. Once
-- submission_id is set the freeze trigger keeps the row fixed, so the profile a successful call was
-- given is the submission's owner for the rest of finalize.
--
-- p_expected_profile_id defaults to null, which keeps the old result for callers that do not pass
-- it (scripts/ExamSeeding.ts, today's worker, and a rolled-back worker): no check, but the row lock
-- still serializes concurrent calls for the same scanned exam. The old one-argument signature is
-- dropped first: keeping both would make a call with only p_scanned_submission_id ambiguous.
--
-- Rollback: forward-only like every migration here. An older worker keeps working against this
-- function (it passes one argument), without the check. See the .down.sql.txt companion.

drop function if exists public.exam_create_submission(bigint);

create function public.exam_create_submission(
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
  -- matched_profile_id is staff-writable and references any profile, and the staff write policy
  -- checks only the row's class. This function runs as its owner and creates a submission that the
  -- profile's owner can read from any course (the submissions and submission_artifacts SELECT
  -- policies grant a profile its own rows), so a grader writing another course's student here
  -- would hand that student this course's scanned exam. Create only for an active student of this
  -- course.
  if not exists (
    select 1 from public.user_roles ur
    where ur.private_profile_id = v_profile_id
      and ur.class_id = v_class_id
      and ur.role = 'student'
      and not coalesce(ur.disabled, false)
  ) then
    raise exception
      'Scanned submission % is matched to a profile that is not an active student in this course',
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
