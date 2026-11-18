-- Matching cannot change the pages of an exam a human has decided, or that has been finalized.
--
-- Process re-runs matching, which groups the batch's pages afresh and links each group to the
-- scanned exam for that position. Its inputs are staff-writable: the batch's total_pages and
-- pages_per_exam, unlinked pages staff add, and the template's page count. Matching linked every
-- group before it checked whether a human had decided that exam, so a grader could add pages and
-- re-run Process to regroup a confirmed exam onto other pages, which finalize then used: a
-- student's exam missing a page, or holding another student's.
--
-- The invariant: a scanned exam that is confirmed or skipped, or has a submission or has been
-- finalized, keeps exactly the set of pages (by id) linked to it. Matching may not add a page to
-- it, move one out of it, or give its position to other pages. A grouping that would do any of
-- that is refused as a whole; nothing is linked or created.
--
-- exam_link_scan_groups does the check and the linking in one transaction, called by the worker in
-- place of its per-group writes:
--   1. creates the rows for positions that have none (ascending exam_index);
--   2. locks, in id order, the batch's scanned exams and any scanned exam holding a requested page;
--   3. compares, in a new statement, each protected exam's linked pages with its requested pages;
--   4. clears the identity of every undecided exam whose pages change, so no suggestion made from
--      its old pages stays on it while the worker re-detects (a confirm in that time would otherwise
--      confirm the old student onto the new pages);
--   5. links the requested pages in one UPDATE, and refuses a short count (a page moved or deleted
--      since the worker read the batch) so the worker retries.
-- A decision (confirm, skip, exam_create_submission, finalize) updates that exam's row, so it either
-- committed before step 2 and is seen in step 3, or waits for this transaction and then decides on
-- the pages linked here. Rows are created before the lock so that none can be created and decided
-- in between. Lock order: unique-index entries by exam_index, scanned exams by id, then page rows;
-- the operations this waits for each hold one row and wait on nothing else.
--
-- "Has a submission" and "finalized" only protect an exam if staff cannot clear them, so user roles
-- (authenticated, anon) may no longer set or change submission_id or finalized_at, on insert or
-- update. Only finalize writes them: exam_create_submission (security definer) and the worker (the
-- service role). Foreign-key actions (a deleted submission sets submission_id to null) run as the
-- table owner and are unaffected. Without this a grader could clear both on a finalized exam,
-- un-confirm it, regroup it, then confirm it and point it back at the student's submission, which
-- finalize would rebuild from the new pages.
--
-- Not covered: direct service-role or admin writes to page links (the seeder, fixtures, operators)
-- and deletes or cascades, as before.
-- A reviewer whose page was loaded before a regroup committed confirms a row whose identity step 4
-- cleared, which finalize does not turn into a submission.
--
-- Rollback: drop function public.exam_link_scan_groups(bigint, jsonb);
--   drop trigger trg_exam_scanned_submission_finalize_fields_guard on public.exam_scanned_submissions;
--   drop function public.exam_scanned_submission_finalize_fields_guard();
--   and restore the per-group linking in doMatch (exam-async-worker/index.ts).

create or replace function public.exam_link_scan_groups(p_batch_id bigint, p_groups jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_batch public.exam_scan_batches;
  v_requested integer;
  v_linked integer;
  v_bad record;
begin
  select * into v_batch from public.exam_scan_batches where id = p_batch_id;
  if not found then
    raise exception 'batch % not found', p_batch_id;
  end if;
  if jsonb_typeof(p_groups) is distinct from 'array'
     or exists (
       select 1 from jsonb_array_elements(p_groups) g
       where jsonb_typeof(g->'page_ids') is distinct from 'array'
          or (g->>'exam_index') is null or (g->>'exam_index')::int < 0)
     or exists (
       select 1 from jsonb_array_elements(p_groups) g
       group by (g->>'exam_index')::int having count(*) > 1)
     or exists (
       select 1 from jsonb_array_elements(p_groups) g
       cross join lateral jsonb_array_elements_text(g->'page_ids') pid
       group by pid having count(*) > 1) then
    raise exception 'batch %: malformed page grouping', p_batch_id;
  end if;

  -- 1. A row for every requested position.
  insert into public.exam_scanned_submissions (class_id, exam_id, batch_id, exam_index)
  select v_batch.class_id, v_batch.exam_id, p_batch_id, gi.exam_index
  from (select distinct (g->>'exam_index')::int as exam_index from jsonb_array_elements(p_groups) g) gi
  order by gi.exam_index
  on conflict (batch_id, exam_index) do nothing;

  -- 2. Lock every scanned exam this can change or must keep.
  perform 1
  from public.exam_scanned_submissions s
  where s.batch_id = p_batch_id
     or s.id in (
       select p.scanned_submission_id from public.exam_scan_pages p
       where p.id in (
         select pid::bigint from jsonb_array_elements(p_groups) g
         cross join lateral jsonb_array_elements_text(g->'page_ids') pid))
  order by s.id
  for update;

  -- 3. No protected exam may gain, lose or swap a page.
  with req as (
    select (g->>'exam_index')::int as exam_index, pid::bigint as page_id
    from jsonb_array_elements(p_groups) g
    cross join lateral jsonb_array_elements_text(g->'page_ids') pid
  ),
  prot as (
    select s.id, s.exam_index, s.batch_id
    from public.exam_scanned_submissions s
    where (s.match_status in ('confirmed', 'skipped') or s.submission_id is not null or s.finalized_at is not null)
      and (s.batch_id = p_batch_id
           or s.id in (select p.scanned_submission_id from public.exam_scan_pages p join req on req.page_id = p.id))
  ),
  cur as (
    select p.id as page_id, p.scanned_submission_id as row_id
    from public.exam_scan_pages p join prot on prot.id = p.scanned_submission_id
  ),
  want as (
    select req.page_id, prot.id as row_id
    from req join prot on prot.batch_id = p_batch_id and prot.exam_index = req.exam_index
  ),
  diff as (
    (select page_id, row_id from cur except select page_id, row_id from want)
    union
    (select page_id, row_id from want except select page_id, row_id from cur)
  )
  select prot.id, prot.exam_index into v_bad
  from diff join prot on prot.id = diff.row_id
  order by prot.batch_id <> p_batch_id, prot.exam_index
  limit 1;
  if found then
    raise exception using
      errcode = 'EX409',
      message = format(
        're-processing would change the pages of exam %s (scanned exam %s), which has been confirmed, skipped or finalized; '
        'remove the pages added since matching, or reopen its match in review, then process again',
        v_bad.exam_index + 1, v_bad.id);
  end if;

  -- 4. An undecided exam whose pages change loses the identity read from its old pages.
  with req as (
    select (g->>'exam_index')::int as exam_index, pid::bigint as page_id
    from jsonb_array_elements(p_groups) g
    cross join lateral jsonb_array_elements_text(g->'page_ids') pid
  ),
  want as (
    select req.page_id, s.id as row_id
    from req join public.exam_scanned_submissions s on s.batch_id = p_batch_id and s.exam_index = req.exam_index
  ),
  cur as (
    select p.id as page_id, p.scanned_submission_id as row_id
    from public.exam_scan_pages p join public.exam_scanned_submissions s on s.id = p.scanned_submission_id
    where s.batch_id = p_batch_id
  ),
  changed as (
    (select page_id, row_id from cur except select page_id, row_id from want)
    union
    (select page_id, row_id from want except select page_id, row_id from cur)
  )
  update public.exam_scanned_submissions s
     set matched_profile_id = null, match_confidence = null, detected_name = null, detected_sis_id = null,
         match_status = 'unmatched'
   where s.batch_id = p_batch_id
     and s.id in (select row_id from changed)
     and s.match_status in ('suggested', 'unmatched')
     and s.submission_id is null and s.finalized_at is null;

  -- 5. Link every requested page of this batch to its position's row.
  with req as (
    select (g->>'exam_index')::int as exam_index, pid::bigint as page_id
    from jsonb_array_elements(p_groups) g
    cross join lateral jsonb_array_elements_text(g->'page_ids') pid
  )
  update public.exam_scan_pages p
     set scanned_submission_id = s.id
    from req
    join public.exam_scanned_submissions s on s.batch_id = p_batch_id and s.exam_index = req.exam_index
   where p.id = req.page_id and p.batch_id = p_batch_id;
  get diagnostics v_linked = row_count;
  select count(*) into v_requested
  from jsonb_array_elements(p_groups) g cross join lateral jsonb_array_elements_text(g->'page_ids') pid;
  if v_linked <> v_requested then
    raise exception 'batch % lost pages while linking scanned exams (% of %); re-run matching',
      p_batch_id, v_linked, v_requested;
  end if;

  return coalesce((
    select jsonb_agg(
             jsonb_build_object('exam_index', s.exam_index, 'scanned_submission_id', s.id, 'match_status', s.match_status)
             order by s.exam_index)
    from public.exam_scanned_submissions s
    where s.batch_id = p_batch_id
      and s.exam_index in (select (g->>'exam_index')::int from jsonb_array_elements(p_groups) g)
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.exam_link_scan_groups(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.exam_link_scan_groups(bigint, jsonb) to service_role;

create or replace function public.exam_scanned_submission_finalize_fields_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if (tg_op = 'INSERT' and (new.submission_id is not null or new.finalized_at is not null))
     or (tg_op = 'UPDATE' and (new.submission_id is distinct from old.submission_id
                               or new.finalized_at is distinct from old.finalized_at)) then
    raise exception
      'scanned submission %: only finalize can set or clear its submission or finalized time',
      coalesce(new.id, old.id);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_exam_scanned_submission_finalize_fields_guard on public.exam_scanned_submissions;
create trigger trg_exam_scanned_submission_finalize_fields_guard
  before insert or update of submission_id, finalized_at on public.exam_scanned_submissions
  for each row execute function public.exam_scanned_submission_finalize_fields_guard();
